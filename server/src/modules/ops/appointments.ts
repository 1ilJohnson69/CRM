import { Router, type Request } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { one, pool, query, tx } from '../../db/pool.js';
import { assertBranch, auth, branchScope, can } from '../../lib/auth.js';
import { audit, notify } from '../../lib/audit.js';
import { badRequest, conflict, HttpError, notFound } from '../../lib/errors.js';
import { addToDate, isoDate, round2, uuid } from '../../lib/http.js';
import { createInvoice, PAYMENT_METHODS, recordPayment } from '../billing/service.js';

const TYPES = ['pt', 'nutrition', 'assessment', 'trial', 'consultation', 'other'] as const;
const TYPE_LABEL: Record<string, string> = { pt: 'PT session', nutrition: 'Nutrition consult', assessment: 'Fitness assessment', trial: 'Trial session', consultation: 'Consultation', other: 'Appointment' };
const fmt = (d: string | Date) => new Date(d).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });

const APPT_SELECT = `
  SELECT a.*, su.full_name AS staff_name, COALESCE(mu.full_name, l.full_name) AS client_name, COALESCE(mu.phone, l.phone) AS client_phone,
         m.member_code, l.stage AS lead_stage, b.name AS branch_name, pk.package_name, pk.sessions_total, pk.sessions_used, pk.sessions_remaining
    FROM appointments a
    JOIN branches b ON b.id = a.branch_id
    LEFT JOIN users su ON su.id = a.staff_id
    LEFT JOIN members m ON m.id = a.member_id LEFT JOIN users mu ON mu.id = m.user_id
    LEFT JOIN leads l ON l.id = a.lead_id
    LEFT JOIN member_pt_package_status pk ON pk.id = a.member_pt_package_id`;

// ------------------------------------------------------------- conflicts --

async function findConflicts(c: PoolClient | typeof pool, a: { staffId?: string | null; memberId?: string | null; startsAt: string; endsAt: string; branchId: string; excludeId?: string }) {
  const out: { kind: string; message: string }[] = [];
  if (a.staffId) {
    const [appts, classes, avail] = await Promise.all([
      query(
        `SELECT a.starts_at, a.type, COALESCE(mu.full_name, l.full_name) AS who FROM appointments a
           LEFT JOIN members m ON m.id = a.member_id LEFT JOIN users mu ON mu.id = m.user_id LEFT JOIN leads l ON l.id = a.lead_id
          WHERE a.staff_id = $1 AND a.status = 'scheduled' AND a.starts_at < $3 AND a.ends_at > $2 AND ($4::uuid IS NULL OR a.id <> $4)`,
        [a.staffId, a.startsAt, a.endsAt, a.excludeId ?? null],
        c,
      ),
      query(
        `SELECT cs.starts_at, ct.name FROM class_sessions cs JOIN class_types ct ON ct.id = cs.class_type_id
          WHERE cs.trainer_id = $1 AND cs.status = 'scheduled' AND cs.starts_at < $3 AND cs.ends_at > $2`,
        [a.staffId, a.startsAt, a.endsAt],
        c,
      ),
      query(
        `SELECT 1 FROM staff_availability sa JOIN organizations o ON o.id = (SELECT organization_id FROM branches WHERE id = $2)
          WHERE sa.user_id = $1 AND sa.branch_id = $2
            AND sa.weekday = extract(dow FROM ($3::timestamptz AT TIME ZONE o.timezone))
            AND sa.start_time <= ($3::timestamptz AT TIME ZONE o.timezone)::time
            AND sa.end_time >= ($4::timestamptz AT TIME ZONE o.timezone)::time`,
        [a.staffId, a.branchId, a.startsAt, a.endsAt],
        c,
      ),
    ]);
    appts.forEach((x) => out.push({ kind: 'staff', message: `Already booked: ${TYPE_LABEL[x.type]} with ${x.who} at ${fmt(x.starts_at)}` }));
    classes.forEach((x) => out.push({ kind: 'class', message: `Teaching ${x.name} at ${fmt(x.starts_at)}` }));
    const hasAvailability = await one(`SELECT 1 FROM staff_availability WHERE user_id = $1 LIMIT 1`, [a.staffId], c);
    if (hasAvailability && !avail.length) out.push({ kind: 'availability', message: 'Outside this person’s working hours' });
  }
  if (a.memberId) {
    const mine = await query(
      `SELECT starts_at, type FROM appointments WHERE member_id = $1 AND status = 'scheduled' AND starts_at < $3 AND ends_at > $2 AND ($4::uuid IS NULL OR id <> $4)`,
      [a.memberId, a.startsAt, a.endsAt, a.excludeId ?? null],
      c,
    );
    mine.forEach((x) => out.push({ kind: 'member', message: `Member already has a ${TYPE_LABEL[x.type]} at ${fmt(x.starts_at)}` }));
  }
  return out;
}

async function checkPackage(c: PoolClient, memberId: string, packageId: string, startsAt: string, excludeId?: string) {
  // Lock the package so two concurrent bookings can't oversell its sessions.
  await c.query(`SELECT id FROM member_pt_packages WHERE id = $1 FOR UPDATE`, [packageId]);
  const p = await one(`SELECT * FROM member_pt_package_status WHERE id = $1`, [packageId], c);
  if (!p || p.member_id !== memberId) throw badRequest('That PT package doesn’t belong to this member');
  if (p.effective_status !== 'active') throw badRequest(`PT package is ${p.effective_status === 'pending' ? 'awaiting payment' : p.effective_status}`);
  if (startsAt.slice(0, 10) > p.expires_on) throw badRequest(`PT package expires on ${p.expires_on}`);
  const booked = await one(
    `SELECT count(*)::int AS n FROM appointments WHERE member_pt_package_id = $1 AND status = 'scheduled' AND ($2::uuid IS NULL OR id <> $2)`,
    [packageId, excludeId ?? null],
    c,
  );
  if (p.sessions_used + booked!.n >= p.sessions_total) throw badRequest('All sessions in this package are used or already booked');
  return p;
}

// ---------------------------------------------------------------- routes --

export const appointmentsRouter = Router();

appointmentsRouter.get('/', can('appointments.read'), async (req, res) => {
  const q = z.object({
    from: isoDate.optional(), to: isoDate.optional(), staffId: uuid.optional(), type: z.enum(TYPES).optional(),
    memberId: uuid.optional(), leadId: uuid.optional(), status: z.enum(['scheduled', 'completed', 'cancelled', 'no_show']).optional(),
    mine: z.coerce.boolean().optional(), limit: z.coerce.number().int().min(1).max(500).default(500),
  }).parse(req.query);
  const params: unknown[] = [auth(req).orgId, branchScope(req)];
  const where = [`a.organization_id = $1`, `a.branch_id = ANY($2)`];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replaceAll('$?', `$${params.length}`)); };
  if (q.from) add(`a.starts_at >= $?::date`, q.from);
  if (q.to) add(`a.starts_at < $?::date + 1`, q.to);
  if (q.staffId) add(`a.staff_id = $?`, q.staffId);
  if (q.mine) add(`a.staff_id = $?`, auth(req).userId);
  if (q.type) add(`a.type = $?`, q.type);
  if (q.memberId) add(`a.member_id = $?`, q.memberId);
  if (q.leadId) add(`a.lead_id = $?`, q.leadId);
  if (q.status) add(`a.status = $?`, q.status);
  params.push(q.limit);
  res.json(await query(`${APPT_SELECT} WHERE ${where.join(' AND ')} ORDER BY a.starts_at ${q.memberId || q.leadId ? 'DESC' : ''} LIMIT $${params.length}`, params));
});

/** People who take appointments, with their weekly availability. */
appointmentsRouter.get('/staff', can('appointments.read'), async (req, res) => {
  res.json(await query(
    `SELECT u.id, u.full_name, r.key AS role_key, r.name AS role_name, tp.specialties, tp.bio, COALESCE(tp.is_bookable, true) AS is_bookable,
            COALESCE((SELECT json_agg(json_build_object('branch_id', sa.branch_id, 'weekday', sa.weekday, 'start', to_char(sa.start_time, 'HH24:MI'), 'end', to_char(sa.end_time, 'HH24:MI')) ORDER BY sa.weekday, sa.start_time)
                        FROM staff_availability sa WHERE sa.user_id = u.id), '[]') AS availability,
            COALESCE((SELECT array_agg(sb.branch_id) FROM staff_branches sb WHERE sb.user_id = u.id), '{}') AS branch_ids, r.all_branches
       FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN trainer_profiles tp ON tp.user_id = u.id
      WHERE u.organization_id = $1 AND u.kind = 'staff' AND u.is_active
        AND r.key IN ('trainer', 'nutritionist', 'branch_manager', 'sales', 'front_desk')
        AND (r.all_branches OR EXISTS (SELECT 1 FROM staff_branches sb WHERE sb.user_id = u.id AND sb.branch_id = ANY($2)))
      ORDER BY CASE r.key WHEN 'trainer' THEN 0 WHEN 'nutritionist' THEN 1 ELSE 2 END, u.full_name`,
    [auth(req).orgId, branchScope(req)],
  ));
});

appointmentsRouter.get('/availability', can('appointments.read'), async (req, res) => {
  const q = z.object({ staffId: uuid, date: isoDate }).parse(req.query);
  const [windows, busy] = await Promise.all([
    query(
      `SELECT to_char(start_time, 'HH24:MI') AS start, to_char(end_time, 'HH24:MI') AS "end", branch_id FROM staff_availability
        WHERE user_id = $1 AND weekday = extract(dow FROM $2::date) AND branch_id = ANY($3) ORDER BY start_time`,
      [q.staffId, q.date, auth(req).branchIds],
    ),
    query(
      `SELECT starts_at, ends_at, title FROM (
         SELECT a.starts_at, a.ends_at, COALESCE(mu.full_name, l.full_name) AS title FROM appointments a
           LEFT JOIN members m ON m.id = a.member_id LEFT JOIN users mu ON mu.id = m.user_id LEFT JOIN leads l ON l.id = a.lead_id
          WHERE a.staff_id = $1 AND a.status = 'scheduled' AND a.starts_at >= $2::date AND a.starts_at < $2::date + 1
         UNION ALL
         SELECT cs.starts_at, cs.ends_at, ct.name FROM class_sessions cs JOIN class_types ct ON ct.id = cs.class_type_id
          WHERE cs.trainer_id = $1 AND cs.status = 'scheduled' AND cs.starts_at >= $2::date AND cs.starts_at < $2::date + 1
       ) x ORDER BY starts_at`,
      [q.staffId, q.date],
    ),
  ]);
  res.json({ windows, busy });
});

const createSchema = z.object({
  type: z.enum(TYPES),
  staffId: uuid.optional().nullable(),
  memberId: uuid.optional().nullable(),
  leadId: uuid.optional().nullable(),
  memberPtPackageId: uuid.optional().nullable(),
  startsAt: z.string().datetime({ offset: true }),
  durationMin: z.coerce.number().int().min(10).max(480).default(60),
  location: z.string().trim().max(80).optional().nullable(),
  notes: z.string().trim().max(1000).optional().nullable(),
  force: z.boolean().default(false),
}).refine((v) => !!v.memberId !== !!v.leadId, 'Pick a member or a lead');

appointmentsRouter.post('/', can('appointments.manage'), async (req, res) => {
  const b = createSchema.parse(req.body);
  if (b.type === 'pt' && !b.memberPtPackageId) throw badRequest('Pick the PT package this session uses');
  if (b.type === 'pt' && b.leadId) throw badRequest('PT sessions are for members');
  const endsAt = new Date(new Date(b.startsAt).getTime() + b.durationMin * 60_000).toISOString();
  const row = await tx(async (c) => {
    const client = b.memberId
      ? await one(`SELECT m.id, m.branch_id, u.full_name, u.id AS user_id FROM members m JOIN users u ON u.id = m.user_id WHERE m.id = $1 AND m.organization_id = $2`, [b.memberId, auth(req).orgId], c)
      : await one(`SELECT id, branch_id, full_name, stage, assigned_to FROM leads WHERE id = $1 AND organization_id = $2 FOR UPDATE`, [b.leadId, auth(req).orgId], c);
    if (!client) throw notFound(b.memberId ? 'Member' : 'Lead');
    assertBranch(req, client.branch_id);
    if (b.memberPtPackageId) await checkPackage(c, b.memberId!, b.memberPtPackageId, b.startsAt);
    const conflicts = await findConflicts(c, { staffId: b.staffId, memberId: b.memberId, startsAt: b.startsAt, endsAt, branchId: client.branch_id });
    if (conflicts.length && !b.force) throw new HttpError(409, 'schedule_conflict', conflicts[0].message, conflicts);

    const appt = await one(
      `INSERT INTO appointments (organization_id, branch_id, type, staff_id, member_id, lead_id, member_pt_package_id, starts_at, ends_at, location, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [auth(req).orgId, client.branch_id, b.type, b.staffId ?? null, b.memberId ?? null, b.leadId ?? null, b.memberPtPackageId ?? null,
        b.startsAt, endsAt, b.location ?? null, b.notes ?? null, auth(req).userId],
      c,
    );
    // A trial booked for a lead advances the pipeline.
    if (b.leadId && b.type === 'trial') {
      await c.query(`UPDATE leads SET trial_at = $2, updated_at = now() WHERE id = $1`, [b.leadId, b.startsAt]);
      if (['new', 'contacted', 'interested'].includes(client.stage)) {
        await c.query(`UPDATE leads SET stage = 'trial_booked', stage_changed_at = now() WHERE id = $1`, [b.leadId]);
        await c.query(`INSERT INTO lead_stage_history (lead_id, from_stage, to_stage, changed_by) VALUES ($1,$2,'trial_booked',$3)`, [b.leadId, client.stage, auth(req).userId]);
      }
    }
    if (b.memberId) {
      await notify(c, {
        orgId: auth(req).orgId, recipientId: client.user_id, audience: 'member', type: 'appointment.booked',
        title: `${TYPE_LABEL[b.type]} booked`, body: fmt(b.startsAt), entityType: 'appointment', entityId: appt.id,
      });
    }
    await audit(c, req, {
      action: 'appointment.booked', entityType: 'appointment', entityId: appt.id, branchId: client.branch_id,
      summary: `${TYPE_LABEL[b.type]} booked for ${client.full_name} · ${fmt(b.startsAt)}${conflicts.length ? ' (conflict overridden)' : ''}`,
    });
    return appt;
  });
  res.status(201).json(row);
});

async function loadAppt(c: PoolClient, req: Request, id: string) {
  const a = await one(`SELECT * FROM appointments WHERE id = $1 AND organization_id = $2 FOR UPDATE`, [id, auth(req).orgId], c);
  if (!a || !auth(req).branchIds.includes(a.branch_id)) throw notFound('Appointment');
  return a;
}

appointmentsRouter.patch('/:id', can('appointments.manage'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const b = z.object({
    startsAt: z.string().datetime({ offset: true }).optional(), durationMin: z.coerce.number().int().min(10).max(480).optional(),
    staffId: uuid.optional().nullable(), location: z.string().trim().optional().nullable(), notes: z.string().trim().optional().nullable(), force: z.boolean().default(false),
  }).parse(req.body);
  await tx(async (c) => {
    const a = await loadAppt(c, req, id);
    if (a.status !== 'scheduled') throw conflict('Only scheduled appointments can be changed');
    const startsAt = b.startsAt ?? new Date(a.starts_at).toISOString();
    const minutes = b.durationMin ?? (new Date(a.ends_at).getTime() - new Date(a.starts_at).getTime()) / 60_000;
    const endsAt = new Date(new Date(startsAt).getTime() + minutes * 60_000).toISOString();
    const staffId = b.staffId !== undefined ? b.staffId : a.staff_id;
    if (a.member_pt_package_id && b.startsAt) await checkPackage(c, a.member_id, a.member_pt_package_id, startsAt, id);
    const conflicts = await findConflicts(c, { staffId, memberId: a.member_id, startsAt, endsAt, branchId: a.branch_id, excludeId: id });
    if (conflicts.length && !b.force) throw new HttpError(409, 'schedule_conflict', conflicts[0].message, conflicts);
    await c.query(
      `UPDATE appointments SET starts_at = $2, ends_at = $3, staff_id = $4, location = COALESCE($5, location), notes = COALESCE($6, notes),
              reminder_sent_at = CASE WHEN $2 <> starts_at THEN NULL ELSE reminder_sent_at END, updated_at = now() WHERE id = $1`,
      [id, startsAt, endsAt, staffId, b.location ?? null, b.notes ?? null],
    );
    if (a.lead_id && a.type === 'trial' && b.startsAt) await c.query(`UPDATE leads SET trial_at = $2 WHERE id = $1`, [a.lead_id, startsAt]);
    if (b.startsAt && b.startsAt !== new Date(a.starts_at).toISOString()) {
      await audit(c, req, { action: 'appointment.rescheduled', entityType: 'appointment', entityId: id, branchId: a.branch_id, summary: `${TYPE_LABEL[a.type]} moved to ${fmt(startsAt)}`, before: { starts_at: a.starts_at }, after: { starts_at: startsAt } });
    }
  });
  res.status(204).end();
});

appointmentsRouter.post('/:id/complete', can('appointments.manage'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const b = z.object({ status: z.enum(['completed', 'no_show']), outcomeNotes: z.string().trim().max(2000).optional().nullable() }).parse(req.body);
  const result = await tx(async (c) => {
    const a = await loadAppt(c, req, id);
    if (a.status !== 'scheduled') throw conflict('This appointment is already closed');
    if (new Date(a.starts_at) > new Date(Date.now() + 15 * 60_000)) throw conflict('This appointment hasn’t started yet');
    const org = await one(`SELECT pt_no_show_consumes FROM organizations WHERE id = $1`, [a.organization_id], c);
    const consumed = a.type === 'pt' && (b.status === 'completed' || org!.pt_no_show_consumes);
    await c.query(`UPDATE appointments SET status = $2, outcome_notes = $3, consumed_session = $4, updated_at = now() WHERE id = $1`, [id, b.status, b.outcomeNotes ?? null, consumed]);
    if (a.lead_id && a.type === 'trial' && b.status === 'completed') {
      const lead = await one(`SELECT stage FROM leads WHERE id = $1 FOR UPDATE`, [a.lead_id], c);
      if (lead && ['new', 'contacted', 'interested', 'trial_booked'].includes(lead.stage)) {
        await c.query(`UPDATE leads SET stage = 'trial_completed', stage_changed_at = now() WHERE id = $1`, [a.lead_id]);
        await c.query(`INSERT INTO lead_stage_history (lead_id, from_stage, to_stage, changed_by) VALUES ($1,$2,'trial_completed',$3)`, [a.lead_id, lead.stage, auth(req).userId]);
      }
    }
    return { consumedSession: consumed };
  });
  res.json(result);
});

appointmentsRouter.post('/:id/cancel', can('appointments.manage'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const { reason } = z.object({ reason: z.string().trim().min(2) }).parse(req.body);
  await tx(async (c) => {
    const a = await loadAppt(c, req, id);
    if (a.status !== 'scheduled') throw conflict('This appointment is already closed');
    await c.query(`UPDATE appointments SET status = 'cancelled', cancel_reason = $2, updated_at = now() WHERE id = $1`, [id, reason]);
    await audit(c, req, { action: 'appointment.cancelled', entityType: 'appointment', entityId: id, branchId: a.branch_id, summary: `${TYPE_LABEL[a.type]} on ${fmt(a.starts_at)} cancelled — ${reason}` });
  });
  res.status(204).end();
});

// ---------------------------------------------------------------------- PT --

export const ptRouter = Router();

ptRouter.get('/packages', can('appointments.read'), async (req, res) => {
  res.json(await query(
    `SELECT p.*, (SELECT count(*) FROM member_pt_package_status s WHERE s.package_id = p.id AND s.effective_status = 'active') AS active_clients
       FROM pt_packages p WHERE p.organization_id = $1 ORDER BY p.status, p.sessions`,
    [auth(req).orgId],
  ));
});

const packageSchema = z.object({
  name: z.string().trim().min(2), description: z.string().trim().optional().nullable(),
  sessions: z.coerce.number().int().min(1).max(500), validityDays: z.coerce.number().int().min(1).max(730),
  price: z.coerce.number().min(0), taxRate: z.coerce.number().min(0).max(40).default(18), status: z.enum(['active', 'archived']).default('active'),
});

ptRouter.post('/packages', can('pt.manage'), async (req, res) => {
  const b = packageSchema.parse(req.body);
  res.status(201).json(await one(
    `INSERT INTO pt_packages (organization_id, name, description, sessions, validity_days, price, tax_rate, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [auth(req).orgId, b.name, b.description ?? null, b.sessions, b.validityDays, b.price, b.taxRate, b.status],
  ));
});

ptRouter.put('/packages/:id', can('pt.manage'), async (req, res) => {
  const b = packageSchema.parse(req.body);
  const row = await one(
    `UPDATE pt_packages SET name=$3, description=$4, sessions=$5, validity_days=$6, price=$7, tax_rate=$8, status=$9 WHERE id=$1 AND organization_id=$2 RETURNING *`,
    [uuid.parse(req.params.id), auth(req).orgId, b.name, b.description ?? null, b.sessions, b.validityDays, b.price, b.taxRate, b.status],
  );
  if (!row) throw notFound('Package');
  res.json(row);
});

ptRouter.get('/member-packages', can('appointments.read'), async (req, res) => {
  const q = z.object({ memberId: uuid.optional(), trainerId: z.string().optional(), status: z.enum(['active', 'pending', 'expired', 'exhausted', 'cancelled', 'all']).default('active') }).parse(req.query);
  const params: unknown[] = [auth(req).orgId, branchScope(req)];
  const where = [`s.organization_id = $1`, `s.branch_id = ANY($2)`];
  if (q.memberId) { params.push(q.memberId); where.push(`s.member_id = $${params.length}`); }
  if (q.trainerId) { params.push(q.trainerId === 'me' ? auth(req).userId : q.trainerId); where.push(`s.trainer_id = $${params.length}`); }
  if (q.status !== 'all' && !q.memberId) { params.push(q.status); where.push(`s.effective_status = $${params.length}`); }
  res.json(await query(
    `SELECT s.*, u.full_name AS member_name, m.member_code, tu.full_name AS trainer_name,
            (SELECT min(a.starts_at) FROM appointments a WHERE a.member_pt_package_id = s.id AND a.status = 'scheduled' AND a.starts_at > now()) AS next_session_at,
            (SELECT max(a.starts_at) FROM appointments a WHERE a.member_pt_package_id = s.id AND a.consumed_session) AS last_session_at
       FROM member_pt_package_status s JOIN members m ON m.id = s.member_id JOIN users u ON u.id = m.user_id
       LEFT JOIN users tu ON tu.id = s.trainer_id
      WHERE ${where.join(' AND ')}
      ORDER BY s.effective_status = 'active' DESC, s.expires_on`,
    params,
  ));
});

ptRouter.post('/member-packages', can('pt.sell'), async (req, res) => {
  const b = z.object({
    memberId: uuid, packageId: uuid, trainerId: uuid.optional().nullable(), discount: z.coerce.number().min(0).default(0), startsOn: isoDate.optional(),
    payment: z.object({ amount: z.coerce.number().positive(), method: z.enum(PAYMENT_METHODS), reference: z.string().trim().optional().nullable() }).optional().nullable(),
  }).parse(req.body);
  if (b.payment && !auth(req).permissions.has('payments.create')) throw badRequest('You cannot record payments');
  const result = await tx(async (c) => {
    const member = await one(`SELECT m.id, m.branch_id, u.full_name FROM members m JOIN users u ON u.id = m.user_id WHERE m.id = $1 AND m.organization_id = $2`, [b.memberId, auth(req).orgId], c);
    if (!member) throw notFound('Member');
    assertBranch(req, member.branch_id);
    const pkg = await one(`SELECT * FROM pt_packages WHERE id = $1 AND organization_id = $2 AND status = 'active'`, [b.packageId, auth(req).orgId], c);
    if (!pkg) throw badRequest('That package is not available');
    const discount = round2(b.discount);
    if (discount > Number(pkg.price)) throw badRequest('Discount cannot exceed the price');
    const startsOn = b.startsOn ?? new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const mp = await one(
      `INSERT INTO member_pt_packages (organization_id, branch_id, member_id, package_id, trainer_id, sessions_total, price, discount, starts_on, expires_on, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [auth(req).orgId, member.branch_id, member.id, pkg.id, b.trainerId ?? null, pkg.sessions, pkg.price, discount, startsOn,
        addToDate(startsOn, 'day', pkg.validity_days - 1), auth(req).userId],
      c,
    );
    const invoice = await createInvoice(c, req, {
      memberId: member.id, branchId: member.branch_id,
      items: [{ itemType: 'pt', description: `${pkg.name} · ${pkg.sessions} sessions (valid ${pkg.validity_days} days)`, memberPtPackageId: mp.id, unitPrice: Number(pkg.price), discount, taxRate: Number(pkg.tax_rate) }],
    });
    await audit(c, req, { action: 'pt.package_sold', entityType: 'member_pt_package', entityId: mp.id, branchId: member.branch_id, summary: `${member.full_name} bought ${pkg.name}`, after: { invoice: invoice.invoice_number, trainer_id: b.trainerId } });
    const payment = b.payment ? await recordPayment(c, req, { invoiceId: invoice.id, ...b.payment }) : null;
    return { package: await one(`SELECT * FROM member_pt_package_status WHERE id = $1`, [mp.id], c), invoice: await one(`SELECT * FROM invoices WHERE id = $1`, [invoice.id], c), payment };
  });
  res.status(201).json(result);
});

ptRouter.patch('/member-packages/:id', can('pt.sell'), async (req, res) => {
  const { trainerId } = z.object({ trainerId: uuid.nullable() }).parse(req.body);
  const row = await one(
    `UPDATE member_pt_packages SET trainer_id = $3 WHERE id = $1 AND organization_id = $2 AND branch_id = ANY($4) RETURNING *`,
    [uuid.parse(req.params.id), auth(req).orgId, trainerId, auth(req).branchIds],
  );
  if (!row) throw notFound('Package');
  res.json(row);
});

ptRouter.post('/member-packages/:id/cancel', can('pt.manage'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const { reason } = z.object({ reason: z.string().trim().min(3) }).parse(req.body);
  await tx(async (c) => {
    const p = await one(`SELECT * FROM member_pt_packages WHERE id = $1 AND organization_id = $2 FOR UPDATE`, [id, auth(req).orgId], c);
    if (!p || !auth(req).branchIds.includes(p.branch_id)) throw notFound('Package');
    if (p.status === 'cancelled') throw conflict('Already cancelled');
    await c.query(`UPDATE member_pt_packages SET status = 'cancelled', cancel_reason = $2 WHERE id = $1`, [id, reason]);
    await c.query(`UPDATE appointments SET status = 'cancelled', cancel_reason = 'Package cancelled' WHERE member_pt_package_id = $1 AND status = 'scheduled'`, [id]);
    await c.query(`UPDATE invoices SET status = 'void' WHERE status = 'pending' AND amount_paid = 0 AND id IN (SELECT invoice_id FROM invoice_items WHERE member_pt_package_id = $1)`, [id]);
    await audit(c, req, { action: 'pt.package_cancelled', entityType: 'member_pt_package', entityId: id, branchId: p.branch_id, summary: `PT package cancelled — ${reason}` });
  });
  res.status(204).end();
});

ptRouter.get('/trainers', can('appointments.read'), async (req, res) => {
  res.json(await query(
    `SELECT u.id, u.full_name, r.name AS role_name, tp.specialties, tp.bio, COALESCE(tp.is_bookable, true) AS is_bookable,
            (SELECT count(*) FROM member_pt_package_status s WHERE s.trainer_id = u.id AND s.effective_status = 'active') AS active_clients,
            (SELECT count(*) FROM appointments a WHERE a.staff_id = u.id AND a.type = 'pt' AND a.consumed_session AND a.starts_at >= date_trunc('month', current_date)) AS sessions_month,
            (SELECT count(*) FROM appointments a WHERE a.staff_id = u.id AND a.status = 'no_show' AND a.starts_at >= date_trunc('month', current_date)) AS no_shows_month,
            (SELECT count(*) FROM appointments a WHERE a.staff_id = u.id AND a.status = 'scheduled' AND a.starts_at >= now() AND a.starts_at < now() + interval '7 days') AS upcoming_week,
            (SELECT count(*) FROM class_sessions cs WHERE cs.trainer_id = u.id AND cs.status <> 'cancelled' AND cs.starts_at >= date_trunc('month', current_date) AND cs.starts_at < now()) AS classes_month,
            COALESCE((SELECT sum(EXTRACT(epoch FROM (sa.end_time - sa.start_time)) / 3600) FROM staff_availability sa WHERE sa.user_id = u.id), 0) AS weekly_hours,
            COALESCE((SELECT json_agg(json_build_object('branch_id', sa.branch_id, 'weekday', sa.weekday, 'start', to_char(sa.start_time, 'HH24:MI'), 'end', to_char(sa.end_time, 'HH24:MI')) ORDER BY sa.weekday, sa.start_time)
                        FROM staff_availability sa WHERE sa.user_id = u.id), '[]') AS availability
       FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN trainer_profiles tp ON tp.user_id = u.id
      WHERE u.organization_id = $1 AND u.is_active AND r.key IN ('trainer', 'nutritionist')
        AND (r.all_branches OR EXISTS (SELECT 1 FROM staff_branches sb WHERE sb.user_id = u.id AND sb.branch_id = ANY($2)))
      ORDER BY r.key, u.full_name`,
    [auth(req).orgId, branchScope(req)],
  ));
});

ptRouter.put('/trainers/:id', can('pt.manage'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const b = z.object({
    specialties: z.array(z.string().trim().min(1)).default([]), bio: z.string().trim().optional().nullable(), isBookable: z.boolean().default(true),
    availability: z.array(z.object({ branchId: uuid, weekday: z.number().int().min(0).max(6), start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) }))
      .refine((a) => a.every((w) => w.end > w.start), 'End time must be after start time'),
  }).parse(req.body);
  await tx(async (c) => {
    const u = await one(`SELECT full_name FROM users WHERE id = $1 AND organization_id = $2 AND kind = 'staff'`, [id, auth(req).orgId], c);
    if (!u) throw notFound('Staff member');
    b.availability.forEach((w) => assertBranch(req, w.branchId));
    await c.query(
      `INSERT INTO trainer_profiles (user_id, specialties, bio, is_bookable) VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id) DO UPDATE SET specialties = EXCLUDED.specialties, bio = EXCLUDED.bio, is_bookable = EXCLUDED.is_bookable`,
      [id, b.specialties, b.bio ?? null, b.isBookable],
    );
    await c.query(`DELETE FROM staff_availability WHERE user_id = $1 AND branch_id = ANY($2)`, [id, auth(req).branchIds]);
    for (const w of b.availability) {
      await c.query(`INSERT INTO staff_availability (user_id, branch_id, weekday, start_time, end_time) VALUES ($1,$2,$3,$4,$5)`, [id, w.branchId, w.weekday, w.start, w.end]);
    }
    await audit(c, req, { action: 'staff.availability_updated', entityType: 'user', entityId: id, summary: `${u.full_name}'s profile and availability updated` });
  });
  res.status(204).end();
});
