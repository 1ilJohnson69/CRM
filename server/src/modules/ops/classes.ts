import { Router, type Request } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { one, pool, query, tx, type Db } from '../../db/pool.js';
import { assertBranch, auth, branchScope, can } from '../../lib/auth.js';
import { audit, notify } from '../../lib/audit.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../../lib/errors.js';
import { isoDate, uuid } from '../../lib/http.js';
import { accessDecision } from '../common/routes.js';

const time = z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:MM');
const GENERATE_DAYS = 21;

/**
 * Materialises sessions from active schedules for the next three weeks.
 * Idempotent (unique schedule_id + starts_at); safe to run on every save
 * and from the daily job.
 */
export async function generateSessions(db: Db = pool, scheduleId?: string) {
  await db.query(
    `INSERT INTO class_sessions (organization_id, branch_id, class_type_id, schedule_id, trainer_id, starts_at, ends_at, capacity, location)
     SELECT s.organization_id, s.branch_id, s.class_type_id, s.id, s.trainer_id,
            (d::date + s.start_time) AT TIME ZONE o.timezone,
            (d::date + s.start_time) AT TIME ZONE o.timezone + make_interval(mins => s.duration_min),
            s.capacity, s.location
       FROM class_schedules s
       JOIN organizations o ON o.id = s.organization_id
       CROSS JOIN LATERAL generate_series(GREATEST(current_date, s.starts_on), current_date + ${GENERATE_DAYS}, interval '1 day') d
      WHERE s.is_active AND ($1::uuid IS NULL OR s.id = $1)
        AND (s.ends_on IS NULL OR d::date <= s.ends_on)
        AND extract(dow FROM d)::smallint = ANY(s.weekdays)
     ON CONFLICT (schedule_id, starts_at) DO NOTHING`,
    [scheduleId ?? null],
  );
}

const SESSION_SELECT = `
  SELECT cs.*, ct.name AS class_name, ct.category, ct.requires_class_access, tu.full_name AS trainer_name, b.name AS branch_name,
         COALESCE(bk.booked, 0)::int AS booked, COALESCE(bk.waitlisted, 0)::int AS waitlisted, COALESCE(bk.attended, 0)::int AS attended
    FROM class_sessions cs
    JOIN class_types ct ON ct.id = cs.class_type_id
    JOIN branches b ON b.id = cs.branch_id
    LEFT JOIN users tu ON tu.id = cs.trainer_id
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE status IN ('booked', 'attended', 'no_show')) AS booked,
             count(*) FILTER (WHERE status = 'waitlisted') AS waitlisted,
             count(*) FILTER (WHERE status = 'attended') AS attended
        FROM class_bookings WHERE session_id = cs.id
    ) bk ON true`;

async function loadSession(c: Db, req: Request, id: string, lock = false) {
  const s = await one(`SELECT * FROM class_sessions WHERE id = $1 AND organization_id = $2 ${lock ? 'FOR UPDATE' : ''}`, [id, auth(req).orgId], c);
  if (!s || !auth(req).branchIds.includes(s.branch_id)) throw notFound('Class');
  return s;
}

/** Whether a member may book this session; the member app uses the same rule. */
export async function bookingEligibility(c: Db, memberId: string, session: any) {
  const m = await one(
    `SELECT m.id, m.branch_id, u.full_name, cm.status, p.class_access
       FROM members m JOIN users u ON u.id = m.user_id
       JOIN member_current_membership cm ON cm.member_id = m.id
       LEFT JOIN membership_plans p ON p.id = cm.plan_id
      WHERE m.id = $1`,
    [memberId],
    c,
  );
  if (!m) return { ok: false, reason: 'Member not found', member: null };
  const access = accessDecision(m.status);
  if (!access.allowed) return { ok: false, reason: access.reason, member: m };
  const type = await one(`SELECT requires_class_access FROM class_types WHERE id = $1`, [session.class_type_id], c);
  if (type!.requires_class_access && !m.class_access) return { ok: false, reason: 'Plan doesn’t include group classes', member: m };
  if (m.branch_id !== session.branch_id) return { ok: false, reason: 'Class is at a different branch', member: m };
  return { ok: true, reason: null, member: m };
}

/** Books (or waitlists) a member. Caller holds a lock on the session row. */
export async function bookMember(c: PoolClient, session: any, memberId: string, opts: { source: 'crm' | 'app'; bookedBy?: string | null; override?: boolean }) {
  if (session.status !== 'scheduled') throw conflict('This class is cancelled');
  if (new Date(session.starts_at) < new Date(Date.now() - 15 * 60_000)) throw conflict('This class has already started');
  const elig = await bookingEligibility(c, memberId, session);
  if (!elig.ok && !opts.override) throw new HttpError(422, 'not_eligible', elig.reason ?? 'Not eligible');
  const existing = await one(`SELECT id, status FROM class_bookings WHERE session_id = $1 AND member_id = $2 AND status <> 'cancelled'`, [session.id, memberId], c);
  if (existing) throw conflict(existing.status === 'waitlisted' ? 'Already on the waitlist' : 'Already booked');
  const count = await one(`SELECT count(*)::int AS n FROM class_bookings WHERE session_id = $1 AND status IN ('booked','attended','no_show')`, [session.id], c);
  const status = count!.n < session.capacity ? 'booked' : 'waitlisted';
  const row = await one(
    `INSERT INTO class_bookings (organization_id, session_id, member_id, status, source, booked_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [session.organization_id, session.id, memberId, status, opts.source, opts.bookedBy ?? null],
    c,
  );
  return { booking: row, member: elig.member, eligible: elig };
}

/** Frees a seat and moves the first waitlisted member up. */
export async function cancelBooking(c: PoolClient, bookingId: string, orgId: string) {
  const b = await one(`SELECT * FROM class_bookings WHERE id = $1 AND organization_id = $2 FOR UPDATE`, [bookingId, orgId], c);
  if (!b) throw notFound('Booking');
  if (!['booked', 'waitlisted'].includes(b.status)) throw conflict('This booking can’t be cancelled');
  await c.query(`SELECT id FROM class_sessions WHERE id = $1 FOR UPDATE`, [b.session_id]);
  await c.query(`UPDATE class_bookings SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [bookingId]);
  let promoted = null;
  if (b.status === 'booked') {
    promoted = await one(
      `UPDATE class_bookings SET status = 'booked', promoted_at = now()
        WHERE id = (SELECT id FROM class_bookings WHERE session_id = $1 AND status = 'waitlisted' ORDER BY created_at LIMIT 1)
        RETURNING *`,
      [b.session_id],
      c,
    );
    if (promoted) {
      const info = await one(
        `SELECT u.id AS user_id, ct.name, cs.starts_at, cs.branch_id FROM class_bookings cb JOIN members m ON m.id = cb.member_id JOIN users u ON u.id = m.user_id
           JOIN class_sessions cs ON cs.id = cb.session_id JOIN class_types ct ON ct.id = cs.class_type_id WHERE cb.id = $1`,
        [promoted.id],
        c,
      );
      await notify(c, {
        orgId, recipientId: info.user_id, audience: 'member', type: 'class.promoted', title: `You’re in: ${info.name}`,
        body: `A spot opened up for ${new Date(info.starts_at).toLocaleString('en-IN', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })}. See you there!`,
        entityType: 'class_session', entityId: b.session_id,
      });
    }
  }
  return { booking: b, promoted };
}

export const classesRouter = Router();

// --------------------------------------------------------------- types --

classesRouter.get('/types', can('classes.read'), async (req, res) => {
  res.json(await query(`SELECT * FROM class_types WHERE organization_id = $1 ORDER BY is_active DESC, name`, [auth(req).orgId]));
});

const typeSchema = z.object({
  name: z.string().trim().min(2),
  description: z.string().trim().optional().nullable(),
  category: z.string().trim().optional().nullable(),
  defaultDurationMin: z.coerce.number().int().min(10).max(240),
  defaultCapacity: z.coerce.number().int().min(1).max(500),
  requiresClassAccess: z.boolean().default(true),
  isActive: z.boolean().default(true),
});

classesRouter.post('/types', can('classes.manage'), async (req, res) => {
  const b = typeSchema.parse(req.body);
  res.status(201).json(await one(
    `INSERT INTO class_types (organization_id, name, description, category, default_duration_min, default_capacity, requires_class_access, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [auth(req).orgId, b.name, b.description ?? null, b.category ?? null, b.defaultDurationMin, b.defaultCapacity, b.requiresClassAccess, b.isActive],
  ));
});

classesRouter.put('/types/:id', can('classes.manage'), async (req, res) => {
  const b = typeSchema.parse(req.body);
  const row = await one(
    `UPDATE class_types SET name=$3, description=$4, category=$5, default_duration_min=$6, default_capacity=$7, requires_class_access=$8, is_active=$9
      WHERE id = $1 AND organization_id = $2 RETURNING *`,
    [uuid.parse(req.params.id), auth(req).orgId, b.name, b.description ?? null, b.category ?? null, b.defaultDurationMin, b.defaultCapacity, b.requiresClassAccess, b.isActive],
  );
  if (!row) throw notFound('Class type');
  res.json(row);
});

// ----------------------------------------------------------- schedules --

classesRouter.get('/schedules', can('classes.read'), async (req, res) => {
  res.json(await query(
    `SELECT s.*, to_char(s.start_time, 'HH24:MI') AS start_hhmm, ct.name AS class_name, tu.full_name AS trainer_name, b.name AS branch_name
       FROM class_schedules s JOIN class_types ct ON ct.id = s.class_type_id JOIN branches b ON b.id = s.branch_id
       LEFT JOIN users tu ON tu.id = s.trainer_id
      WHERE s.organization_id = $1 AND s.branch_id = ANY($2)
      ORDER BY s.is_active DESC, b.name, s.start_time`,
    [auth(req).orgId, branchScope(req)],
  ));
});

const scheduleSchema = z.object({
  branchId: uuid,
  classTypeId: uuid,
  trainerId: uuid.optional().nullable(),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1),
  startTime: time,
  durationMin: z.coerce.number().int().min(10).max(240),
  capacity: z.coerce.number().int().min(1).max(500),
  location: z.string().trim().optional().nullable(),
  startsOn: isoDate.optional(),
  endsOn: isoDate.optional().nullable(),
  isActive: z.boolean().default(true),
});

async function saveSchedule(req: Request, id: string | null, b: z.infer<typeof scheduleSchema>) {
  assertBranch(req, b.branchId);
  return tx(async (c) => {
    let row;
    const values = [b.branchId, b.classTypeId, b.trainerId ?? null, b.weekdays, b.startTime, b.durationMin, b.capacity, b.location ?? null, b.endsOn ?? null, b.isActive];
    if (id) {
      row = await one(
        `UPDATE class_schedules SET branch_id=$3, class_type_id=$4, trainer_id=$5, weekdays=$6, start_time=$7, duration_min=$8, capacity=$9, location=$10,
                ends_on=$11, is_active=$12 WHERE id = $1 AND organization_id = $2 RETURNING *`,
        [id, auth(req).orgId, ...values],
        c,
      );
      if (!row) throw notFound('Schedule');
      // Re-plan future sessions nobody has booked; booked ones stay as they are.
      await c.query(
        `DELETE FROM class_sessions cs WHERE cs.schedule_id = $1 AND cs.starts_at > now()
            AND NOT EXISTS (SELECT 1 FROM class_bookings cb WHERE cb.session_id = cs.id AND cb.status <> 'cancelled')`,
        [id],
      );
      await c.query(
        `UPDATE class_sessions SET trainer_id = $2, capacity = GREATEST(capacity, $3), location = $4 WHERE schedule_id = $1 AND starts_at > now()`,
        [id, b.trainerId ?? null, b.capacity, b.location ?? null],
      );
    } else {
      row = await one(
        `INSERT INTO class_schedules (organization_id, starts_on, created_by, branch_id, class_type_id, trainer_id, weekdays, start_time, duration_min, capacity, location, ends_on, is_active)
         VALUES ($1, COALESCE($2::date, current_date), $3, $4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [auth(req).orgId, b.startsOn ?? null, auth(req).userId, ...values],
        c,
      );
    }
    if (row.is_active) await generateSessions(c, row.id);
    const type = await one(`SELECT name FROM class_types WHERE id = $1`, [b.classTypeId], c);
    await audit(c, req, { action: id ? 'class_schedule.updated' : 'class_schedule.created', entityType: 'class_schedule', entityId: row.id, branchId: b.branchId, summary: `${type!.name} schedule ${id ? 'updated' : 'created'} (${b.startTime})`, after: b });
    return row;
  });
}

classesRouter.post('/schedules', can('classes.manage'), async (req, res) => {
  res.status(201).json(await saveSchedule(req, null, scheduleSchema.parse(req.body)));
});
classesRouter.put('/schedules/:id', can('classes.manage'), async (req, res) => {
  res.json(await saveSchedule(req, uuid.parse(req.params.id), scheduleSchema.parse(req.body)));
});

// ------------------------------------------------------------ sessions --

classesRouter.get('/sessions', can('classes.read'), async (req, res) => {
  const q = z.object({ from: isoDate, to: isoDate, trainerId: uuid.optional(), classTypeId: uuid.optional() }).parse(req.query);
  const params: unknown[] = [auth(req).orgId, branchScope(req), q.from, q.to];
  const where = [`cs.organization_id = $1`, `cs.branch_id = ANY($2)`, `cs.starts_at >= $3::date`, `cs.starts_at < $4::date + 1`];
  if (q.trainerId) { params.push(q.trainerId); where.push(`cs.trainer_id = $${params.length}`); }
  if (q.classTypeId) { params.push(q.classTypeId); where.push(`cs.class_type_id = $${params.length}`); }
  res.json(await query(`${SESSION_SELECT} WHERE ${where.join(' AND ')} ORDER BY cs.starts_at`, params));
});

classesRouter.post('/sessions', can('classes.manage'), async (req, res) => {
  const b = z.object({
    branchId: uuid, classTypeId: uuid, trainerId: uuid.optional().nullable(), startsAt: z.string().datetime({ offset: true }),
    durationMin: z.coerce.number().int().min(10).max(240), capacity: z.coerce.number().int().min(1).max(500), location: z.string().trim().optional().nullable(),
  }).parse(req.body);
  assertBranch(req, b.branchId);
  const row = await one(
    `INSERT INTO class_sessions (organization_id, branch_id, class_type_id, trainer_id, starts_at, ends_at, capacity, location)
     VALUES ($1,$2,$3,$4,$5::timestamptz, $5::timestamptz + make_interval(mins => $6), $7, $8) RETURNING *`,
    [auth(req).orgId, b.branchId, b.classTypeId, b.trainerId ?? null, b.startsAt, b.durationMin, b.capacity, b.location ?? null],
  );
  res.status(201).json(row);
});

classesRouter.get('/sessions/:id', can('classes.read'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  await loadSession(pool, req, id);
  const [session, roster] = await Promise.all([
    one(`${SESSION_SELECT} WHERE cs.id = $1`, [id]),
    query(
      `SELECT cb.*, m.member_code, u.full_name, u.phone, cm.status AS membership_status, cm.plan_name,
              row_number() OVER (PARTITION BY cb.status = 'waitlisted' ORDER BY cb.created_at) AS position
         FROM class_bookings cb JOIN members m ON m.id = cb.member_id JOIN users u ON u.id = m.user_id
         JOIN member_current_membership cm ON cm.member_id = m.id
        WHERE cb.session_id = $1 ORDER BY cb.status = 'cancelled', cb.status = 'waitlisted', cb.created_at`,
      [id],
    ),
  ]);
  res.json({ ...session, roster });
});

classesRouter.patch('/sessions/:id', can('classes.manage'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const b = z.object({ trainerId: uuid.optional().nullable(), capacity: z.coerce.number().int().min(1).max(500).optional(), location: z.string().trim().optional().nullable() }).parse(req.body);
  await tx(async (c) => {
    const s = await loadSession(c, req, id, true);
    const booked = await one(`SELECT count(*)::int AS n FROM class_bookings WHERE session_id = $1 AND status IN ('booked','attended','no_show')`, [id], c);
    if (b.capacity !== undefined && b.capacity < booked!.n) throw badRequest(`${booked!.n} people are already booked`);
    await c.query(
      `UPDATE class_sessions SET trainer_id = CASE WHEN $2 THEN $3 ELSE trainer_id END, capacity = COALESCE($4, capacity),
              location = CASE WHEN $5 THEN $6 ELSE location END WHERE id = $1`,
      [id, b.trainerId !== undefined, b.trainerId ?? null, b.capacity ?? null, b.location !== undefined, b.location ?? null],
    );
    // Extra capacity goes to the waitlist first.
    if (b.capacity && b.capacity > s.capacity) {
      await c.query(
        `UPDATE class_bookings SET status = 'booked', promoted_at = now()
          WHERE id IN (SELECT id FROM class_bookings WHERE session_id = $1 AND status = 'waitlisted' ORDER BY created_at LIMIT $2)`,
        [id, b.capacity - Math.max(s.capacity, booked!.n)],
      );
    }
  });
  res.status(204).end();
});

classesRouter.post('/sessions/:id/cancel', can('classes.manage'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const { reason } = z.object({ reason: z.string().trim().min(3) }).parse(req.body);
  const n = await tx(async (c) => {
    const s = await loadSession(c, req, id, true);
    if (s.status !== 'scheduled') throw conflict('This class isn’t scheduled');
    await c.query(`UPDATE class_sessions SET status = 'cancelled', cancel_reason = $2 WHERE id = $1`, [id, reason]);
    const affected = await query(
      `UPDATE class_bookings cb SET status = 'cancelled', cancelled_at = now() FROM members m
        WHERE cb.session_id = $1 AND cb.status IN ('booked','waitlisted') AND m.id = cb.member_id RETURNING m.user_id`,
      [id],
      c,
    );
    const type = await one(`SELECT name FROM class_types WHERE id = $1`, [s.class_type_id], c);
    for (const a of affected) {
      await notify(c, {
        orgId: auth(req).orgId, recipientId: a.user_id, audience: 'member', type: 'class.cancelled', priority: 'high',
        title: `${type!.name} cancelled`, body: `Sorry — ${new Date(s.starts_at).toLocaleString('en-IN', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })} is cancelled: ${reason}.`,
        entityType: 'class_session', entityId: id,
      });
    }
    await audit(c, req, { action: 'class_session.cancelled', entityType: 'class_session', entityId: id, branchId: s.branch_id, summary: `${type!.name} on ${new Date(s.starts_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} cancelled — ${reason} (${affected.length} members notified)` });
    return affected.length;
  });
  res.json({ notified: n });
});

classesRouter.post('/sessions/:id/bookings', can('classes.book'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const { memberId, override } = z.object({ memberId: uuid, override: z.boolean().default(false) }).parse(req.body);
  if (override && !auth(req).permissions.has('classes.manage')) throw forbidden('Only class managers can override eligibility');
  const result = await tx(async (c) => {
    const s = await loadSession(c, req, id, true);
    return bookMember(c, s, memberId, { source: 'crm', bookedBy: auth(req).userId, override });
  });
  res.status(201).json(result);
});

classesRouter.post('/bookings/:id/cancel', can('classes.book'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const result = await tx(async (c) => {
    const b = await one(`SELECT cs.branch_id FROM class_bookings cb JOIN class_sessions cs ON cs.id = cb.session_id WHERE cb.id = $1`, [id], c);
    if (!b) throw notFound('Booking');
    assertBranch(req, b.branch_id);
    return cancelBooking(c, id, auth(req).orgId);
  });
  res.json(result);
});

classesRouter.post('/bookings/:id/attendance', can('classes.book'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const { status } = z.object({ status: z.enum(['attended', 'no_show', 'booked']) }).parse(req.body);
  const row = await one(
    `UPDATE class_bookings cb SET status = $3, attended_at = CASE WHEN $3 = 'attended' THEN now() ELSE NULL END
       FROM class_sessions cs
      WHERE cb.id = $1 AND cs.id = cb.session_id AND cs.organization_id = $2 AND cs.branch_id = ANY($4)
        AND cb.status IN ('booked', 'attended', 'no_show') AND cs.starts_at < now() + interval '30 minutes'
      RETURNING cb.*`,
    [id, auth(req).orgId, status, auth(req).branchIds],
  );
  if (!row) throw conflict('Attendance can be marked from 30 minutes before the class');
  res.json(row);
});

