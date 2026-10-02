import { Router, type Request } from 'express';
import { onCheckIn } from '../engagement/loyalty.js';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { config } from '../../config.js';
import { one, query, tx } from '../../db/pool.js';
import { assertBranch, auth, branchScope, can } from '../../lib/auth.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { isoDate, paginationSchema, paged, uuid } from '../../lib/http.js';
import { accessDecision } from '../common/routes.js';

// ------------------------------------------------------------- QR tokens --

const QR_PREFIX = 'FQ.';

/** Short-lived token the member app renders as a QR code. */
export function issueCheckinToken(memberId: string) {
  const token = jwt.sign({ sub: memberId, typ: 'checkin' }, config.jwtSecret, { expiresIn: 120 });
  return { token: QR_PREFIX + token, expiresAt: new Date(Date.now() + 120_000).toISOString() };
}

function readCheckinToken(code: string): string {
  try {
    const p = jwt.verify(code.slice(QR_PREFIX.length), config.jwtSecret) as jwt.JwtPayload;
    if (p.typ !== 'checkin') throw new Error();
    return String(p.sub);
  } catch {
    throw badRequest('This QR code has expired. Ask the member to refresh it in the app.');
  }
}

// --------------------------------------------------------- access decision --

const MEMBER_CARD = `
  SELECT m.id, m.member_code, m.branch_id, b.name AS branch_name, u.full_name, u.phone, u.avatar_url, u.is_active,
         cm.status, cm.plan_name, cm.end_date, cm.days_remaining, cm.frozen_until,
         bal.outstanding, vs.last_visit_at, vs.visits_30d
    FROM members m JOIN users u ON u.id = m.user_id JOIN branches b ON b.id = m.branch_id
    JOIN member_current_membership cm ON cm.member_id = m.id
    JOIN member_balances bal ON bal.member_id = m.id
    JOIN member_visit_stats vs ON vs.member_id = m.id`;

export async function memberCard(orgId: string, memberId: string) {
  return one(`${MEMBER_CARD} WHERE m.id = $1 AND m.organization_id = $2`, [memberId, orgId]);
}

/** Entry rule shared by the front desk, the member app and access hardware. */
export function entryDecision(card: { status: string; branch_id: string; branch_name: string }, branchId: string) {
  const d = accessDecision(card.status);
  if (d.allowed && card.branch_id !== branchId) return { allowed: false, reason: `Home branch is ${card.branch_name}` };
  return d;
}

async function resolveMember(req: Request, input: { memberId?: string; code?: string }) {
  const orgId = auth(req).orgId;
  if (input.memberId) return memberCard(orgId, input.memberId);
  const code = input.code!.trim();
  if (code.startsWith(QR_PREFIX)) return memberCard(orgId, readCheckinToken(code));
  const digits = code.replace(/[\s-]/g, '');
  return one(
    `${MEMBER_CARD} WHERE m.organization_id = $1
        AND (upper(m.member_code) = upper($2) OR u.phone = $3 OR u.phone = '+91' || $3 OR right(u.phone, 10) = $3)
      LIMIT 1`,
    [orgId, code, digits],
  );
}

export const attendanceRouter = Router();

// ------------------------------------------------------------------ check in --

attendanceRouter.post('/check-in', can('attendance.checkin'), async (req, res) => {
  const body = z
    .object({
      memberId: uuid.optional(),
      code: z.string().trim().min(2).optional(),
      branchId: uuid.optional(),
      method: z.enum(['front_desk', 'qr', 'member_id', 'app', 'access_control']).default('front_desk'),
      override: z.object({ reason: z.string().trim().min(3) }).optional(),
    })
    .refine((v) => v.memberId || v.code, 'Scan a QR code or enter a member ID / phone')
    .parse(req.body);

  const scope = branchScope(req);
  const branchId = body.branchId ?? (scope.length === 1 ? scope[0] : null);
  if (!branchId) throw badRequest('Pick the branch you are checking members into');
  assertBranch(req, branchId);

  const card = await resolveMember(req, body);
  if (!card) throw notFound('Member');
  const method = body.code?.startsWith(QR_PREFIX) ? 'qr' : body.method;
  const decision = entryDecision(card, branchId);

  const result = await tx(async (c) => {
    const org = await one(`SELECT checkin_dedupe_minutes FROM organizations WHERE id = $1`, [auth(req).orgId], c);
    // Scanning twice at the door shouldn't create two visits.
    const recent = await one(
      `SELECT * FROM attendance WHERE member_id = $1 AND branch_id = $2 AND status <> 'denied' AND checked_out_at IS NULL
          AND checked_in_at > now() - make_interval(mins => $3) ORDER BY checked_in_at DESC LIMIT 1`,
      [card.id, branchId, org!.checkin_dedupe_minutes],
      c,
    );
    if (recent && (decision.allowed || body.override)) return { attendance: recent, duplicate: true, status: recent.status };

    let status: 'allowed' | 'denied' | 'override' = decision.allowed ? 'allowed' : 'denied';
    if (!decision.allowed && body.override) {
      if (!auth(req).permissions.has('attendance.override')) throw forbidden('You can’t override entry. Ask a manager.');
      status = 'override';
    }
    const row = await one(
      `INSERT INTO attendance (organization_id, branch_id, member_id, method, status, reason, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [auth(req).orgId, branchId, card.id, method, status, status === 'allowed' ? null : status === 'override' ? `${decision.reason} — ${body.override!.reason}` : decision.reason, auth(req).userId],
      c,
    );
    if (status !== 'denied') await onCheckIn(c, auth(req).orgId, card.id, branchId);
    if (status === 'override') {
      await audit(c, req, {
        action: 'attendance.override', entityType: 'member', entityId: card.id, branchId,
        summary: `Entry overridden for ${card.full_name}: ${decision.reason} (${body.override!.reason})`,
      });
    }
    return { attendance: row, duplicate: false, status };
  });
  res.status(result.duplicate ? 200 : 201).json({ ...result, allowed: result.status !== 'denied', reason: decision.reason, member: card });
});

attendanceRouter.post('/:id/check-out', can('attendance.checkin'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const row = await one(
    `UPDATE attendance SET checked_out_at = now()
      WHERE id = $1 AND organization_id = $2 AND branch_id = ANY($3) AND checked_out_at IS NULL AND status <> 'denied' RETURNING *`,
    [id, auth(req).orgId, auth(req).branchIds],
  );
  if (!row) throw conflict('Already checked out');
  res.json(row);
});

attendanceRouter.get('/lookup', can('attendance.checkin'), async (req, res) => {
  const { code, branchId } = z.object({ code: z.string().trim().min(2), branchId: uuid.optional() }).parse(req.query);
  const card = await resolveMember(req, { code });
  if (!card) throw notFound('Member');
  const scope = branchScope(req);
  const b = branchId ?? (scope.length === 1 ? scope[0] : card.branch_id);
  res.json({ member: card, decision: entryDecision(card, b) });
});

// ---------------------------------------------------------------- list/live --

attendanceRouter.get('/', can('attendance.read'), async (req, res) => {
  const q = paginationSchema
    .extend({ date: isoDate.optional(), memberId: uuid.optional(), status: z.enum(['allowed', 'denied', 'override']).optional(), method: z.string().optional() })
    .parse(req.query);
  const params: unknown[] = [auth(req).orgId, branchScope(req)];
  const where = [`a.organization_id = $1`, `a.branch_id = ANY($2)`];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replaceAll('$?', `$${params.length}`));
  };
  if (q.date) add(`a.checked_in_at >= $?::date AND a.checked_in_at < $?::date + 1`, q.date);
  if (q.memberId) add(`a.member_id = $?`, q.memberId);
  if (q.status) add(`a.status = $?`, q.status);
  if (q.method) add(`a.method = $?`, q.method);
  params.push(q.pageSize, (q.page - 1) * q.pageSize);
  const rows = await query(
    `SELECT a.*, u.full_name AS member_name, m.member_code, b.name AS branch_name, ru.full_name AS recorded_by_name,
            count(*) OVER() AS total_count
       FROM attendance a JOIN members m ON m.id = a.member_id JOIN users u ON u.id = m.user_id
       JOIN branches b ON b.id = a.branch_id LEFT JOIN users ru ON ru.id = a.recorded_by
      WHERE ${where.join(' AND ')}
      ORDER BY a.checked_in_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  res.json(paged(rows, q.page, q.pageSize));
});

attendanceRouter.get('/live', can('attendance.read'), async (req, res) => {
  const scope = [auth(req).orgId, branchScope(req)];
  const [stats, recent] = await Promise.all([
    one(
      `SELECT count(*) FILTER (WHERE status <> 'denied') AS today,
              count(DISTINCT member_id) FILTER (WHERE status <> 'denied') AS unique_today,
              count(*) FILTER (WHERE status = 'denied') AS denied_today,
              -- "In the gym": checked in within the last 2h and not checked out.
              count(*) FILTER (WHERE status <> 'denied' AND checked_out_at IS NULL AND checked_in_at > now() - interval '2 hours') AS inside,
              (SELECT count(*) FROM attendance p WHERE p.organization_id = $1 AND p.branch_id = ANY($2) AND p.status <> 'denied'
                  AND p.checked_in_at >= current_date - 7 AND p.checked_in_at < now() - interval '7 days') AS same_time_last_week
         FROM attendance WHERE organization_id = $1 AND branch_id = ANY($2) AND checked_in_at >= current_date`,
      scope,
    ),
    query(
      `SELECT a.id, a.checked_in_at, a.checked_out_at, a.status, a.reason, a.method, m.id AS member_id, m.member_code, u.full_name, cm.plan_name, cm.status AS membership_status
         FROM attendance a JOIN members m ON m.id = a.member_id JOIN users u ON u.id = m.user_id
         JOIN member_current_membership cm ON cm.member_id = m.id
        WHERE a.organization_id = $1 AND a.branch_id = ANY($2) AND a.checked_in_at >= current_date
        ORDER BY a.checked_in_at DESC LIMIT 25`,
      scope,
    ),
  ]);
  res.json({ ...Object.fromEntries(Object.entries(stats!).map(([k, v]) => [k, Number(v)])), recent });
});

attendanceRouter.get('/analytics', can('attendance.read'), async (req, res) => {
  const { days } = z.object({ days: z.coerce.number().int().refine((d) => [7, 30, 90].includes(d)).default(30) }).parse(req.query);
  const scope = [auth(req).orgId, branchScope(req), days];
  const [daily, heat, summary] = await Promise.all([
    query(
      `SELECT d::date AS date, count(a.id) AS visits, count(DISTINCT a.member_id) AS members
         FROM generate_series(current_date - ($3::int - 1), current_date, interval '1 day') d
         LEFT JOIN attendance a ON a.checked_in_at >= d AND a.checked_in_at < d + interval '1 day'
              AND a.organization_id = $1 AND a.branch_id = ANY($2) AND a.status <> 'denied'
        GROUP BY d ORDER BY d`,
      scope,
    ),
    // Average check-ins per weekday × hour across the window.
    query(
      `SELECT extract(isodow FROM checked_in_at)::int AS dow, extract(hour FROM checked_in_at)::int AS hour,
              round(count(*)::numeric / GREATEST(1, ($3::int / 7.0)), 1) AS avg
         FROM attendance
        WHERE organization_id = $1 AND branch_id = ANY($2) AND status <> 'denied' AND checked_in_at >= current_date - ($3::int - 1)
        GROUP BY 1, 2`,
      scope,
    ),
    one(
      `SELECT (SELECT count(*) FROM members m JOIN member_current_membership cm ON cm.member_id = m.id
                 JOIN member_visit_stats vs ON vs.member_id = m.id JOIN organizations o ON o.id = m.organization_id
                WHERE m.organization_id = $1 AND m.branch_id = ANY($2) AND cm.status IN ('active','expiring_soon')
                  AND COALESCE(vs.last_visit_at, m.join_date::timestamptz) < now() - make_interval(days => o.inactive_after_days)) AS inactive,
              (SELECT count(*) FROM members m JOIN member_current_membership cm ON cm.member_id = m.id
                WHERE m.organization_id = $1 AND m.branch_id = ANY($2) AND cm.status IN ('active','expiring_soon')) AS active,
              (SELECT inactive_after_days FROM organizations WHERE id = $1) AS inactive_after_days`,
      [auth(req).orgId, branchScope(req)],
    ),
  ]);
  const visits = daily.map((d) => Number(d.visits));
  const total = visits.reduce((a, b) => a + b, 0);
  const peak = heat.reduce((best, h) => (Number(h.avg) > Number(best?.avg ?? -1) ? h : best), null as any);
  const hourTotals = new Map<number, number>();
  heat.forEach((h) => hourTotals.set(h.hour, (hourTotals.get(h.hour) ?? 0) + Number(h.avg)));
  const peakHour = [...hourTotals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  res.json({
    daily: daily.map((d) => ({ date: d.date, visits: Number(d.visits), members: Number(d.members) })),
    heatmap: heat.map((h) => ({ dow: h.dow, hour: h.hour, avg: Number(h.avg) })),
    total,
    averageDaily: Math.round(total / days),
    peakHour,
    peakSlot: peak ? { dow: peak.dow, hour: peak.hour, avg: Number(peak.avg) } : null,
    inactive: Number(summary!.inactive),
    active: Number(summary!.active),
    inactiveAfterDays: Number(summary!.inactive_after_days),
  });
});

// ------------------------------------------------------------ staff clock --

attendanceRouter.get('/staff', can('attendance.read'), async (req, res) => {
  const { date } = z.object({ date: isoDate.optional() }).parse(req.query);
  const rows = await query(
    `SELECT u.id AS user_id, u.full_name, r.name AS role_name, s.id, s.clock_in, s.clock_out, b.name AS branch_name,
            EXTRACT(epoch FROM (COALESCE(s.clock_out, now()) - s.clock_in)) / 3600 AS hours
       FROM users u JOIN roles r ON r.id = u.role_id
       LEFT JOIN staff_attendance s ON s.user_id = u.id AND s.clock_in >= COALESCE($3::date, current_date) AND s.clock_in < COALESCE($3::date, current_date) + 1
       LEFT JOIN branches b ON b.id = s.branch_id
      WHERE u.organization_id = $1 AND u.kind = 'staff' AND u.is_active
        AND (r.all_branches OR EXISTS (SELECT 1 FROM staff_branches sb WHERE sb.user_id = u.id AND sb.branch_id = ANY($2)))
      ORDER BY s.clock_in IS NULL, s.clock_in, u.full_name`,
    [auth(req).orgId, branchScope(req), date ?? null],
  );
  res.json(rows);
});

attendanceRouter.post('/staff/clock', async (req, res) => {
  const body = z.object({ userId: uuid.optional(), action: z.enum(['in', 'out']), branchId: uuid.optional() }).parse(req.body);
  const self = !body.userId || body.userId === auth(req).userId;
  if (!self && !auth(req).permissions.has('staff.attendance')) throw forbidden();
  const userId = body.userId ?? auth(req).userId;
  const scope = branchScope(req);
  const branchId = body.branchId ?? scope[0];
  assertBranch(req, branchId);
  const row = await tx(async (c) => {
    const user = await one(`SELECT full_name FROM users WHERE id = $1 AND organization_id = $2 AND kind = 'staff'`, [userId, auth(req).orgId], c);
    if (!user) throw notFound('Employee');
    if (body.action === 'in') {
      const open = await one(`SELECT 1 FROM staff_attendance WHERE user_id = $1 AND clock_out IS NULL`, [userId], c);
      if (open) throw conflict(`${user.full_name} is already clocked in`);
      return one(
        `INSERT INTO staff_attendance (organization_id, branch_id, user_id, method, recorded_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [auth(req).orgId, branchId, userId, self ? 'self' : 'front_desk', auth(req).userId],
        c,
      );
    }
    const out = await one(`UPDATE staff_attendance SET clock_out = now() WHERE user_id = $1 AND clock_out IS NULL RETURNING *`, [userId], c);
    if (!out) throw conflict(`${user.full_name} isn’t clocked in`);
    return out;
  });
  res.json(row);
});
