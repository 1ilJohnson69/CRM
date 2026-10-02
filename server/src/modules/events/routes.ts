import { Router, type Request } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { one, pool, query, tx } from '../../db/pool.js';
import { assertBranch, auth, branchScope, can } from '../../lib/auth.js';
import { audit, notify } from '../../lib/audit.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { paginationSchema, paged, round2, uuid } from '../../lib/http.js';
import { createInvoice, PAYMENT_METHODS, recordPayment } from '../billing/service.js';
import { postPoints } from '../engagement/loyalty.js';

export const EVENT_TYPES = ['workshop', 'competition', 'seminar', 'challenge', 'special'] as const;
const TYPE_LABEL: Record<string, string> = { workshop: 'Workshop', competition: 'Competition', seminar: 'Seminar', challenge: 'Fitness challenge', special: 'Special event' };

const eventStats = `
  (SELECT count(*) FROM event_registrations r WHERE r.event_id = e.id AND r.status IN ('registered','attended','no_show'))::int AS registered,
  (SELECT count(*) FROM event_registrations r WHERE r.event_id = e.id AND r.status = 'waitlisted')::int AS waitlisted,
  (SELECT count(*) FROM event_registrations r WHERE r.event_id = e.id AND r.status = 'attended')::int AS attended,
  (SELECT COALESCE(sum(p.amount), 0) FROM event_registrations r JOIN payments p ON p.invoice_id = r.invoice_id AND p.status = 'recorded' WHERE r.event_id = e.id) AS revenue,
  (SELECT COALESCE(sum(i.total - i.amount_paid), 0) FROM event_registrations r JOIN invoices i ON i.id = r.invoice_id
    WHERE r.event_id = e.id AND r.status <> 'cancelled' AND i.status IN ('pending','partially_paid')) AS outstanding`;

/** What a given person pays: members get the member price when one is set. */
export const priceFor = (e: any, isMember: boolean) => Number(isMember && e.member_price != null ? e.member_price : e.price);

export async function loadEvent(db: PoolClient | typeof pool, orgId: string, id: string, lock = false) {
  return one(`SELECT e.*, b.name AS branch_name, h.full_name AS host_name, ${eventStats}
                FROM events e JOIN branches b ON b.id = e.branch_id LEFT JOIN users h ON h.id = e.host_id
               WHERE e.id = $1 AND e.organization_id = $2 ${lock ? 'FOR UPDATE OF e' : ''}`, [id, orgId], db);
}

/**
 * Registers a member or guest. Over capacity → waitlist. Paid events raise
 * an "event" invoice (so revenue, receipts and the member's history follow
 * the same billing rules as everything else), optionally collecting payment.
 */
export async function registerForEvent(
  c: PoolClient, req: Request,
  r: { eventId: string; memberId?: string | null; guest?: { name: string; phone?: string | null } | null; source: 'crm' | 'app'; payment?: { amount: number; method: (typeof PAYMENT_METHODS)[number]; reference?: string | null } | null },
) {
  const orgId = auth(req).orgId;
  const e = await loadEvent(c, orgId, r.eventId, true);
  if (!e) throw notFound('Event');
  if (e.status !== 'published') throw conflict(e.status === 'draft' ? 'Publish the event before taking registrations' : `This event is ${e.status}`);
  if (new Date(e.ends_at) < new Date()) throw conflict('This event is over');
  if (e.registration_closes_at && new Date(e.registration_closes_at) < new Date()) throw conflict('Registration has closed');
  if (!r.memberId && !e.allow_guests) throw badRequest('This event is for members only');
  let member: any = null;
  if (r.memberId) {
    member = await one(`SELECT m.id, m.branch_id, m.user_id, u.full_name FROM members m JOIN users u ON u.id = m.user_id WHERE m.id = $1 AND m.organization_id = $2`, [r.memberId, orgId], c);
    if (!member) throw notFound('Member');
    const dup = await one(`SELECT status FROM event_registrations WHERE event_id = $1 AND member_id = $2 AND status <> 'cancelled'`, [e.id, member.id], c);
    if (dup) throw conflict(dup.status === 'waitlisted' ? 'Already on the waitlist' : 'Already registered');
  }
  const full = e.capacity != null && e.registered >= e.capacity;
  const reg = await one(
    `INSERT INTO event_registrations (organization_id, event_id, member_id, guest_name, guest_phone, status, source, registered_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [orgId, e.id, member?.id ?? null, member ? null : r.guest!.name, member ? null : r.guest?.phone ?? null, full ? 'waitlisted' : 'registered', r.source,
      auth(req).kind === 'staff' ? auth(req).userId : null],
    c,
  );
  let invoice: any = null;
  const price = priceFor(e, !!member);
  if (!full && price > 0) invoice = await billRegistration(c, req, e, reg, member, r.guest ?? null, price, r.payment ?? null);
  await audit(c, req, {
    action: full ? 'event.waitlisted' : 'event.registered', entityType: 'event', entityId: e.id, branchId: e.branch_id,
    summary: `${member?.full_name ?? r.guest!.name} ${full ? 'joined the waitlist for' : 'registered for'} ${e.title}${r.source === 'app' ? ' (app)' : ''}`,
  });
  if (member) {
    await notify(c, {
      orgId, recipientId: member.user_id, audience: 'member', type: full ? 'event.waitlisted' : 'event.registered',
      title: full ? `On the waitlist: ${e.title}` : `You're registered: ${e.title}`,
      body: full ? 'We’ll let you know if a spot opens up.' : `${new Date(e.starts_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}${price > 0 ? ` · ₹${price.toLocaleString('en-IN')} payable at the front desk` : ''}`,
      entityType: 'event', entityId: e.id,
    });
  }
  return { registration: reg, invoice, waitlisted: full };
}

async function billRegistration(c: PoolClient, req: Request, e: any, reg: any, member: any, guest: { name: string; phone?: string | null } | null, price: number, payment: any) {
  const gross = round2(price / (1 + e.tax_rate / 100)); // event prices are shown GST-inclusive
  const invoice = await createInvoice(c, req, {
    memberId: member?.id ?? null, customer: member ? null : { name: guest!.name, phone: guest?.phone ?? null }, branchId: e.branch_id,
    source: reg.source === 'app' ? 'app' : 'crm',
    items: [{ itemType: 'event', description: `${TYPE_LABEL[e.type]}: ${e.title}`, unitPrice: gross, taxRate: Number(e.tax_rate) }],
  });
  await c.query(`UPDATE invoice_items SET event_registration_id = $2 WHERE invoice_id = $1`, [invoice.id, reg.id]);
  await c.query(`UPDATE event_registrations SET invoice_id = $2 WHERE id = $1`, [reg.id, invoice.id]);
  if (payment) {
    if (!auth(req).permissions.has('payments.create')) throw badRequest('You cannot record payments');
    await recordPayment(c, req, { invoiceId: invoice.id, amount: payment.amount, method: payment.method, reference: payment.reference });
  }
  return one(`SELECT * FROM invoices WHERE id = $1`, [invoice.id], c);
}

/** Frees a spot: cancels the registration, voids an unpaid invoice and promotes the waitlist. */
export async function cancelRegistration(c: PoolClient, req: Request, regId: string, by: 'staff' | 'member') {
  const reg = await one(`SELECT r.*, e.title, e.branch_id, e.status AS event_status, e.starts_at FROM event_registrations r JOIN events e ON e.id = r.event_id WHERE r.id = $1 AND r.organization_id = $2 FOR UPDATE OF r`, [regId, auth(req).orgId], c);
  if (!reg) throw notFound('Registration');
  if (!['registered', 'waitlisted'].includes(reg.status)) throw conflict(`This registration is ${reg.status}`);
  if (by === 'member' && new Date(reg.starts_at) < new Date()) throw conflict('The event has started');
  await c.query(`UPDATE event_registrations SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [regId]);
  let note = '';
  if (reg.invoice_id) {
    const inv = await one(`SELECT * FROM invoices WHERE id = $1 FOR UPDATE`, [reg.invoice_id], c);
    if (inv && inv.amount_paid === 0 && inv.status === 'pending') await c.query(`UPDATE invoices SET status = 'void', updated_at = now() WHERE id = $1`, [inv.id]);
    else if (inv && inv.amount_paid > 0) note = ` — ₹${Number(inv.amount_paid).toLocaleString('en-IN')} was paid; refund or adjust ${inv.invoice_number}`;
  }
  if (reg.status === 'registered') await promoteWaitlist(c, req, reg.event_id);
  await audit(c, req, { action: 'event.cancelled_registration', entityType: 'event', entityId: reg.event_id, branchId: reg.branch_id, summary: `Registration for ${reg.title} cancelled${by === 'member' ? ' by the member' : ''}${note}` });
  return { note };
}

async function promoteWaitlist(c: PoolClient, req: Request, eventId: string) {
  const e = await loadEvent(c, auth(req).orgId, eventId, true);
  if (!e || e.status !== 'published' || (e.capacity != null && e.registered >= e.capacity)) return;
  const next = await one(
    `SELECT r.*, m.user_id, u.full_name FROM event_registrations r LEFT JOIN members m ON m.id = r.member_id LEFT JOIN users u ON u.id = m.user_id
      WHERE r.event_id = $1 AND r.status = 'waitlisted' ORDER BY r.created_at LIMIT 1 FOR UPDATE OF r`, [eventId], c);
  if (!next) return;
  await c.query(`UPDATE event_registrations SET status = 'registered', promoted_at = now() WHERE id = $1`, [next.id]);
  const price = priceFor(e, !!next.member_id);
  if (price > 0 && !next.invoice_id) {
    await billRegistration(c, req, e, next, next.member_id ? { id: next.member_id } : null, next.member_id ? null : { name: next.guest_name, phone: next.guest_phone }, price, null);
  }
  if (next.user_id) {
    await notify(c, { orgId: auth(req).orgId, recipientId: next.user_id, audience: 'member', type: 'event.promoted', title: `A spot opened up: ${e.title}`, body: 'You’re in! See you there.', entityType: 'event', entityId: e.id });
  }
}

// -------------------------------------------------------------------- routes --

export const eventsRouter = Router();

const eventSchema = z.object({
  branchId: uuid,
  title: z.string().trim().min(3).max(120),
  type: z.enum(EVENT_TYPES),
  description: z.string().trim().max(3000).optional().nullable(),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  location: z.string().trim().max(120).optional().nullable(),
  capacity: z.coerce.number().int().min(1).max(10000).optional().nullable(),
  price: z.coerce.number().min(0).max(1_000_000).default(0),
  memberPrice: z.coerce.number().min(0).max(1_000_000).optional().nullable(),
  taxRate: z.coerce.number().min(0).max(40).default(18),
  allowGuests: z.boolean().default(true),
  registrationClosesAt: z.string().datetime({ offset: true }).optional().nullable(),
  attendancePoints: z.coerce.number().int().min(0).max(10000).default(0),
  hostId: uuid.optional().nullable(),
}).refine((v) => Date.parse(v.endsAt) > Date.parse(v.startsAt), { message: 'The event must end after it starts', path: ['endsAt'] });

eventsRouter.get('/', can('events.read'), async (req, res) => {
  const q = paginationSchema.extend({ when: z.enum(['upcoming', 'past', 'all']).default('upcoming'), status: z.string().optional(), type: z.enum(EVENT_TYPES).optional() }).parse(req.query);
  const params: unknown[] = [auth(req).orgId, branchScope(req)];
  const where = [`e.organization_id = $1`, `e.branch_id = ANY($2)`];
  if (q.when === 'upcoming') where.push(`e.ends_at >= now()`);
  if (q.when === 'past') where.push(`e.ends_at < now()`);
  if (q.status) { params.push(q.status); where.push(`e.status = $${params.length}`); }
  if (q.type) { params.push(q.type); where.push(`e.type = $${params.length}`); }
  params.push(q.pageSize, (q.page - 1) * q.pageSize);
  const rows = await query(
    `SELECT e.*, b.name AS branch_name, h.full_name AS host_name, ${eventStats}, count(*) OVER() AS total_count
       FROM events e JOIN branches b ON b.id = e.branch_id LEFT JOIN users h ON h.id = e.host_id
      WHERE ${where.join(' AND ')}
      ORDER BY ${q.when === 'past' ? 'e.starts_at DESC' : 'e.starts_at'} LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  res.json(paged(rows, q.page, q.pageSize));
});

eventsRouter.get('/summary', can('events.read'), async (req, res) => {
  res.json(await one(
    `SELECT count(*) FILTER (WHERE e.status = 'published' AND e.ends_at >= now())::int AS upcoming,
            COALESCE(sum(s.registered) FILTER (WHERE e.status = 'published' AND e.ends_at >= now()), 0)::int AS upcoming_registrations,
            COALESCE(sum(s.revenue) FILTER (WHERE e.starts_at >= now() - interval '90 days'), 0) AS revenue_90d,
            COALESCE(round(100.0 * sum(s.attended) FILTER (WHERE e.status = 'completed') / NULLIF(sum(s.registered) FILTER (WHERE e.status = 'completed'), 0)), 0)::int AS show_rate
       FROM events e CROSS JOIN LATERAL (SELECT ${eventStats}) s
      WHERE e.organization_id = $1 AND e.branch_id = ANY($2) AND e.status <> 'cancelled'`,
    [auth(req).orgId, branchScope(req)],
  ));
});

eventsRouter.get('/:id', can('events.read'), async (req, res) => {
  const e = await loadEvent(pool, auth(req).orgId, uuid.parse(req.params.id));
  if (!e || !auth(req).branchIds.includes(e.branch_id)) throw notFound('Event');
  const participants = await query(
    `SELECT r.*, COALESCE(u.full_name, r.guest_name) AS name, COALESCE(u.phone, r.guest_phone) AS phone, m.member_code,
            i.invoice_number, i.total, i.amount_paid, i.status AS invoice_status
       FROM event_registrations r LEFT JOIN members m ON m.id = r.member_id LEFT JOIN users u ON u.id = m.user_id LEFT JOIN invoices i ON i.id = r.invoice_id
      WHERE r.event_id = $1 ORDER BY r.status = 'cancelled', r.status = 'waitlisted', r.created_at`,
    [e.id],
  );
  res.json({ ...e, participants });
});

async function saveEvent(req: Request, id: string | null) {
  const b = eventSchema.parse(req.body);
  assertBranch(req, b.branchId);
  return tx(async (c) => {
    if (id) {
      const before = await loadEvent(c, auth(req).orgId, id, true);
      if (!before || !auth(req).branchIds.includes(before.branch_id)) throw notFound('Event');
      if (['cancelled', 'completed'].includes(before.status)) throw conflict(`This event is ${before.status}`);
      if (b.capacity != null && b.capacity < before.registered) throw conflict(`${before.registered} people are already registered — capacity can’t go below that`);
    }
    const vals = [b.branchId, b.title, b.type, b.description ?? null, b.startsAt, b.endsAt, b.location ?? null, b.capacity ?? null, b.price, b.memberPrice ?? null, b.taxRate,
      b.allowGuests, b.registrationClosesAt ?? null, b.attendancePoints, b.hostId ?? null];
    const row = id
      ? await one(
        `UPDATE events SET branch_id=$2, title=$3, type=$4, description=$5, starts_at=$6, ends_at=$7, location=$8, capacity=$9, price=$10, member_price=$11, tax_rate=$12,
                allow_guests=$13, registration_closes_at=$14, attendance_points=$15, host_id=$16, updated_at=now() WHERE id=$1 RETURNING *`, [id, ...vals], c)
      : await one(
        `INSERT INTO events (branch_id, title, type, description, starts_at, ends_at, location, capacity, price, member_price, tax_rate, allow_guests, registration_closes_at,
                             attendance_points, host_id, organization_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`, [...vals, auth(req).orgId, auth(req).userId], c);
    if (id) await promoteWaitlist(c, req, id); // capacity may have grown
    await audit(c, req, { action: id ? 'event.updated' : 'event.created', entityType: 'event', entityId: row.id, branchId: b.branchId, summary: `${TYPE_LABEL[b.type]} “${b.title}” ${id ? 'updated' : 'created'}` });
    return row;
  });
}

eventsRouter.post('/', can('events.manage'), async (req, res) => res.status(201).json(await saveEvent(req, null)));
eventsRouter.put('/:id', can('events.manage'), async (req, res) => res.json(await saveEvent(req, uuid.parse(req.params.id))));

eventsRouter.post('/:id/publish', can('events.manage'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const { announce } = z.object({ announce: z.boolean().default(false) }).parse(req.body ?? {});
  const result = await tx(async (c) => {
    const e = await loadEvent(c, auth(req).orgId, id, true);
    if (!e || !auth(req).branchIds.includes(e.branch_id)) throw notFound('Event');
    if (e.status !== 'draft') throw conflict(`This event is ${e.status}`);
    if (new Date(e.starts_at) < new Date()) throw conflict('This event has already started');
    await c.query(`UPDATE events SET status = 'published', updated_at = now() WHERE id = $1`, [id]);
    let announced = 0;
    if (announce) {
      // In-app announcement to active members of the branch who haven't opted out of promotions.
      const r = await c.query(
        `INSERT INTO notifications (organization_id, branch_id, recipient_id, audience, type, title, body, entity_type, entity_id)
         SELECT m.organization_id, m.branch_id, m.user_id, 'member', 'event.announced', $2, $3, 'event', $1
           FROM members m JOIN member_current_membership cm ON cm.member_id = m.id
          WHERE m.branch_id = $4 AND cm.status IN ('active','expiring_soon') AND NOT m.marketing_opt_out`,
        [id, `New: ${e.title}`, `${TYPE_LABEL[e.type]} · ${new Date(e.starts_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}. Register in the app.`, e.branch_id],
      );
      announced = r.rowCount ?? 0;
    }
    await audit(c, req, { action: 'event.published', entityType: 'event', entityId: id, branchId: e.branch_id, summary: `“${e.title}” published${announce ? ` and announced to ${announced} members` : ''}` });
    return { announced };
  });
  res.json(result);
});

eventsRouter.post('/:id/cancel', can('events.manage'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const { reason } = z.object({ reason: z.string().trim().min(3).max(300) }).parse(req.body);
  const result = await tx(async (c) => {
    const e = await loadEvent(c, auth(req).orgId, id, true);
    if (!e || !auth(req).branchIds.includes(e.branch_id)) throw notFound('Event');
    if (['cancelled', 'completed'].includes(e.status)) throw conflict(`This event is ${e.status}`);
    await c.query(`UPDATE events SET status = 'cancelled', cancel_reason = $2, updated_at = now() WHERE id = $1`, [id, reason]);
    const regs = await query(
      `UPDATE event_registrations SET status = 'cancelled', cancelled_at = now() WHERE event_id = $1 AND status IN ('registered','waitlisted') RETURNING id, member_id, invoice_id`, [id], c);
    await c.query(`UPDATE invoices SET status = 'void', updated_at = now() WHERE id = ANY($1) AND amount_paid = 0 AND status = 'pending'`, [regs.map((r) => r.invoice_id).filter(Boolean)]);
    const paid = await query(`SELECT invoice_number, amount_paid FROM invoices WHERE id = ANY($1) AND amount_paid > 0`, [regs.map((r) => r.invoice_id).filter(Boolean)], c);
    await c.query(
      `INSERT INTO notifications (organization_id, branch_id, recipient_id, audience, type, priority, title, body, entity_type, entity_id)
       SELECT $1, $2, m.user_id, 'member', 'event.cancelled', 'high', $3, $4, 'event', $5 FROM members m WHERE m.id = ANY($6)`,
      [auth(req).orgId, e.branch_id, `Cancelled: ${e.title}`, `${reason}. If you paid, the front desk will refund you.`, id, regs.map((r) => r.member_id).filter(Boolean)],
    );
    await audit(c, req, { action: 'event.cancelled', entityType: 'event', entityId: id, branchId: e.branch_id, summary: `“${e.title}” cancelled (${regs.length} registrations): ${reason}`, after: { paid_invoices: paid } });
    return { cancelled: regs.length, toRefund: paid };
  });
  res.json(result);
});

const registerSchema = z.object({
  memberId: uuid.optional().nullable(),
  guest: z.object({ name: z.string().trim().min(2).max(80), phone: z.string().trim().max(20).optional().nullable() }).optional().nullable(),
  payment: z.object({ amount: z.coerce.number().positive(), method: z.enum(PAYMENT_METHODS), reference: z.string().trim().max(80).optional().nullable() }).optional().nullable(),
}).refine((v) => !!v.memberId !== !!v.guest, 'Pick a member or enter a guest');

eventsRouter.post('/:id/registrations', can('events.manage'), async (req, res) => {
  const b = registerSchema.parse(req.body);
  const id = uuid.parse(req.params.id);
  const result = await tx(async (c) => {
    const e = await one(`SELECT branch_id FROM events WHERE id = $1 AND organization_id = $2`, [id, auth(req).orgId], c);
    if (!e) throw notFound('Event');
    assertBranch(req, e.branch_id);
    return registerForEvent(c, req, { eventId: id, memberId: b.memberId, guest: b.guest, source: 'crm', payment: b.payment });
  });
  res.status(201).json(result);
});

eventsRouter.post('/registrations/:regId/cancel', can('events.manage'), async (req, res) => {
  res.json(await tx((c) => cancelRegistration(c, req, uuid.parse(req.params.regId), 'staff')));
});

/** Attendance: marking someone present awards the event's loyalty points (once). */
eventsRouter.post('/registrations/:regId/attendance', can('events.manage'), async (req, res) => {
  const { status } = z.object({ status: z.enum(['attended', 'no_show', 'registered']) }).parse(req.body);
  const regId = uuid.parse(req.params.regId);
  await tx(async (c) => {
    const r = await one(
      `SELECT r.*, e.title, e.branch_id, e.starts_at, e.attendance_points, e.status AS event_status FROM event_registrations r JOIN events e ON e.id = r.event_id
        WHERE r.id = $1 AND r.organization_id = $2 FOR UPDATE OF r`, [regId, auth(req).orgId], c);
    if (!r || !auth(req).branchIds.includes(r.branch_id)) throw notFound('Registration');
    if (['cancelled', 'waitlisted'].includes(r.status)) throw conflict(`This registration is ${r.status}`);
    if (new Date(r.starts_at).getTime() > Date.now() + 60 * 60_000) throw conflict('Attendance opens an hour before the event starts');
    await c.query(`UPDATE event_registrations SET status = $2, attended_at = CASE WHEN $2 = 'attended' THEN now() END WHERE id = $1`, [regId, status]);
    if (status === 'attended' && r.member_id && r.attendance_points > 0) {
      await postPoints(c, {
        orgId: auth(req).orgId, memberId: r.member_id, branchId: r.branch_id, reason: 'event', points: r.attendance_points,
        sourceKey: `event:${r.event_id}`, description: `Attended ${r.title}`, createdBy: auth(req).userId,
      });
    }
  });
  res.status(204).end();
});

eventsRouter.post('/:id/complete', can('events.manage'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  await tx(async (c) => {
    const e = await loadEvent(c, auth(req).orgId, id, true);
    if (!e || !auth(req).branchIds.includes(e.branch_id)) throw notFound('Event');
    if (e.status !== 'published') throw conflict(`This event is ${e.status}`);
    if (new Date(e.starts_at) > new Date()) throw conflict('The event hasn’t started yet');
    // Anyone not marked present by the end is a no-show.
    await c.query(`UPDATE event_registrations SET status = 'no_show' WHERE event_id = $1 AND status = 'registered'`, [id]);
    await c.query(`UPDATE event_registrations SET status = 'cancelled', cancelled_at = now() WHERE event_id = $1 AND status = 'waitlisted'`, [id]);
    await c.query(`UPDATE events SET status = 'completed', updated_at = now() WHERE id = $1`, [id]);
    await audit(c, req, { action: 'event.completed', entityType: 'event', entityId: id, branchId: e.branch_id, summary: `“${e.title}” closed: ${e.attended} attended of ${e.registered}` });
  });
  res.status(204).end();
});
