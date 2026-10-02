import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { one, query } from '../../db/pool.js';
import { auth, branchScope, can } from '../../lib/auth.js';
import { badRequest } from '../../lib/errors.js';
import { isoDate } from '../../lib/http.js';

export const reportsRouter = Router();

const rangeSchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  format: z.enum(['json', 'csv']).default('json'),
  table: z.string().optional(),
});

/** Date range (inclusive, IST calendar days) with a bucket that keeps charts readable. */
function range(req: Request) {
  const q = rangeSchema.parse(req.query);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const to = q.to ?? today;
  const from = q.from ?? new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86400_000).toISOString().slice(0, 10);
  if (from > to) throw badRequest('“From” must be before “to”');
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400_000) + 1;
  if (days > 731) throw badRequest('Pick a range of two years or less');
  const bucket = days > 120 ? 'month' : days > 45 ? 'week' : 'day';
  // Previous period of equal length, for comparisons.
  const prevTo = new Date(Date.parse(`${from}T00:00:00Z`) - 86400_000).toISOString().slice(0, 10);
  const prevFrom = new Date(Date.parse(`${prevTo}T00:00:00Z`) - (days - 1) * 86400_000).toISOString().slice(0, 10);
  return { ...q, from, to, days, bucket, prevFrom, prevTo, scope: [auth(req).orgId, branchScope(req), from, to] as unknown[] };
}

const csvCell = (v: unknown) => {
  if (v == null) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  // Neutralise spreadsheet formulas and quote everything that needs it.
  const safe = /^[=+\-@]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** ?format=csv&table=<name> exports any table in a report response. */
function send(res: Response, r: ReturnType<typeof range>, name: string, data: Record<string, any>) {
  if (r.format !== 'csv') return res.json({ from: r.from, to: r.to, bucket: r.bucket, ...data });
  const table = data[r.table ?? ''];
  if (!Array.isArray(table) || !table.length) throw badRequest('Nothing to export for that table');
  const cols = Object.keys(table[0]);
  const csv = [cols.join(','), ...table.map((row) => cols.map((c) => csvCell(row[c])).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}-${r.table}-${r.from}-to-${r.to}.csv"`);
  res.send(csv);
}

const series = (bucket: string) =>
  `generate_series(date_trunc('${bucket}', $3::date), date_trunc('${bucket}', $4::date), interval '1 ${bucket}') b`;
const inRange = (col: string) => `${col} >= $3::date AND ${col} < $4::date + 1`;

// ------------------------------------------------------------------ revenue --

reportsRouter.get('/revenue', can('reports.read'), async (req, res) => {
  const r = range(req);
  // Payments split across invoice lines by share, refunds netted — same rules as the dashboard.
  const alloc = `
    SELECT p.paid_at AS at, p.branch_id, p.method, p.collected_by, ii.item_type,
           p.amount * (ii.amount / NULLIF((SELECT sum(x.amount) FROM invoice_items x WHERE x.invoice_id = p.invoice_id), 0)) AS amount
      FROM payments p JOIN invoice_items ii ON ii.invoice_id = p.invoice_id
     WHERE p.organization_id = $1 AND p.branch_id = ANY($2) AND p.status = 'recorded' AND ${inRange('p.paid_at')}`;
  const [trend, byService, byMethod, byEmployee, byBranch, totals, prev] = await Promise.all([
    query(
      `WITH a AS (${alloc})
       SELECT b::date AS date, COALESCE((SELECT sum(amount) FROM a WHERE date_trunc('${r.bucket}', a.at) = b), 0)
            - COALESCE((SELECT sum(rf.amount) FROM refunds rf WHERE rf.organization_id = $1 AND rf.branch_id = ANY($2) AND ${inRange('rf.created_at')} AND date_trunc('${r.bucket}', rf.created_at) = b), 0) AS revenue
         FROM ${series(r.bucket)} ORDER BY b`, r.scope),
    query(`WITH a AS (${alloc}) SELECT item_type AS service, round(sum(amount), 2) AS revenue FROM a GROUP BY item_type ORDER BY revenue DESC`, r.scope),
    query(`SELECT method, round(sum(amount), 2) AS revenue, count(*)::int AS payments FROM payments WHERE organization_id = $1 AND branch_id = ANY($2) AND status = 'recorded' AND ${inRange('paid_at')} GROUP BY method ORDER BY revenue DESC`, r.scope),
    query(
      `SELECT COALESCE(u.full_name, 'Unattributed') AS employee, ro.name AS role, round(sum(p.amount), 2) AS collected, count(*)::int AS payments
         FROM payments p LEFT JOIN users u ON u.id = p.collected_by LEFT JOIN roles ro ON ro.id = u.role_id
        WHERE p.organization_id = $1 AND p.branch_id = ANY($2) AND p.status = 'recorded' AND ${inRange('p.paid_at')}
        GROUP BY u.full_name, ro.name ORDER BY collected DESC`, r.scope),
    query(
      `SELECT b.name AS branch, round(COALESCE(sum(p.amount), 0), 2) AS revenue, count(p.id)::int AS payments,
              round(COALESCE((SELECT sum(rf.amount) FROM refunds rf WHERE rf.branch_id = b.id AND ${inRange('rf.created_at')}), 0), 2) AS refunds
         FROM branches b LEFT JOIN payments p ON p.branch_id = b.id AND p.status = 'recorded' AND ${inRange('p.paid_at')}
        WHERE b.organization_id = $1 AND b.id = ANY($2) GROUP BY b.id ORDER BY revenue DESC`, r.scope),
    one(
      `SELECT COALESCE(sum(amount), 0) AS gross, count(*)::int AS payments,
              (SELECT COALESCE(sum(amount), 0) FROM refunds WHERE organization_id = $1 AND branch_id = ANY($2) AND ${inRange('created_at')}) AS refunds
         FROM payments WHERE organization_id = $1 AND branch_id = ANY($2) AND status = 'recorded' AND ${inRange('paid_at')}`, r.scope),
    one(
      `SELECT COALESCE(sum(amount), 0) - COALESCE((SELECT sum(amount) FROM refunds WHERE organization_id = $1 AND branch_id = ANY($2) AND created_at >= $3::date AND created_at < $4::date + 1), 0) AS net
         FROM payments WHERE organization_id = $1 AND branch_id = ANY($2) AND status = 'recorded' AND paid_at >= $3::date AND paid_at < $4::date + 1`,
      [auth(req).orgId, branchScope(req), r.prevFrom, r.prevTo]),
  ]);
  const net = Number(totals!.gross) - Number(totals!.refunds);
  send(res, r, 'revenue', {
    totals: { ...totals, net, previousNet: Number(prev!.net), avgPerDay: net / r.days },
    trend, byService, byMethod, byEmployee, byBranch,
  });
});

// --------------------------------------------------------------- membership --

reportsRouter.get('/membership', can('reports.read'), async (req, res) => {
  const r = range(req);
  const [trend, counts, active, byPlan, churn] = await Promise.all([
    query(
      `SELECT b::date AS date,
              (SELECT count(*) FROM memberships ms WHERE ms.organization_id = $1 AND ms.branch_id = ANY($2) AND ms.kind = 'new' AND ms.status <> 'cancelled' AND date_trunc('${r.bucket}', ms.created_at) = b)::int AS new,
              (SELECT count(*) FROM memberships ms WHERE ms.organization_id = $1 AND ms.branch_id = ANY($2) AND ms.kind = 'renewal' AND ms.status <> 'cancelled' AND date_trunc('${r.bucket}', ms.created_at) = b)::int AS renewals,
              (SELECT count(*) FROM memberships ms WHERE ms.organization_id = $1 AND ms.branch_id = ANY($2) AND ms.status IN ('active','expired') AND date_trunc('${r.bucket}', ms.end_date::timestamptz) = b AND ms.end_date < current_date
                  AND NOT EXISTS (SELECT 1 FROM memberships nx WHERE nx.member_id = ms.member_id AND nx.start_date > ms.start_date AND nx.status <> 'cancelled'))::int AS expired,
              (SELECT count(DISTINCT ms.member_id) FROM memberships ms WHERE ms.organization_id = $1 AND ms.branch_id = ANY($2) AND ms.status IN ('active','frozen','expired')
                  AND ms.start_date <= LEAST(b + interval '1 ${r.bucket}' - interval '1 day', current_date) AND ms.end_date >= LEAST(b + interval '1 ${r.bucket}' - interval '1 day', current_date))::int AS active
         FROM ${series(r.bucket)} ORDER BY b`, r.scope),
    one(
      `SELECT count(*) FILTER (WHERE kind = 'new' AND status <> 'cancelled')::int AS new,
              count(*) FILTER (WHERE kind = 'renewal' AND status <> 'cancelled')::int AS renewals,
              count(*) FILTER (WHERE kind IN ('upgrade','downgrade') AND status <> 'cancelled')::int AS plan_changes,
              count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
              (SELECT count(*) FROM membership_freezes f JOIN memberships m2 ON m2.id = f.membership_id WHERE m2.organization_id = $1 AND m2.branch_id = ANY($2) AND f.created_at >= $3::date AND f.created_at < $4::date + 1)::int AS frozen
         FROM memberships WHERE organization_id = $1 AND branch_id = ANY($2) AND ${inRange('created_at')}`, r.scope),
    one(
      `SELECT count(*) FILTER (WHERE cm.status IN ('active','expiring_soon'))::int AS active, count(*) FILTER (WHERE cm.status = 'expiring_soon')::int AS expiring_soon,
              count(*) FILTER (WHERE cm.status = 'frozen')::int AS frozen, count(*) FILTER (WHERE cm.status = 'expired')::int AS expired
         FROM members m JOIN member_current_membership cm ON cm.member_id = m.id WHERE m.organization_id = $1 AND m.branch_id = ANY($2) AND NOT cm.is_pass`,
      [auth(req).orgId, branchScope(req)]),
    query(
      `SELECT p.name AS plan, count(*)::int AS sold, count(*) FILTER (WHERE ms.kind = 'renewal')::int AS renewals, round(sum(ms.price), 2) AS value
         FROM memberships ms JOIN membership_plans p ON p.id = ms.plan_id
        WHERE ms.organization_id = $1 AND ms.branch_id = ANY($2) AND ms.status <> 'cancelled' AND ${inRange('ms.created_at')}
        GROUP BY p.name ORDER BY sold DESC`, r.scope),
    // Renewal rate: of memberships that ended in the range, how many were followed by another.
    one(
      `SELECT count(*)::int AS ended, count(*) FILTER (WHERE EXISTS (SELECT 1 FROM memberships nx WHERE nx.member_id = ms.member_id AND nx.id <> ms.id
                                                                     AND nx.start_date >= ms.end_date - 30 AND nx.status <> 'cancelled'))::int AS renewed
         FROM memberships ms JOIN membership_plans p ON p.id = ms.plan_id
        WHERE ms.organization_id = $1 AND ms.branch_id = ANY($2) AND ms.status <> 'cancelled' AND NOT (p.duration_unit = 'day' AND p.duration_value < 7)
          AND ms.end_date BETWEEN $3::date AND LEAST($4::date, current_date - 1)`, r.scope),
  ]);
  send(res, r, 'membership', { counts: { ...counts, ...active, ...churn, renewalRate: churn!.ended ? Math.round((churn!.renewed / churn!.ended) * 100) : null }, trend, byPlan });
});

// -------------------------------------------------------------------- sales --

reportsRouter.get('/sales', can('reports.read'), async (req, res) => {
  const r = range(req);
  const [funnel, bySource, bySalesperson, followUps, trend] = await Promise.all([
    one(
      `SELECT count(*)::int AS leads, count(*) FILTER (WHERE stage = 'won')::int AS won, count(*) FILTER (WHERE stage = 'lost')::int AS lost,
              count(*) FILTER (WHERE stage NOT IN ('won','lost'))::int AS open,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM lead_stage_history h WHERE h.lead_id = l.id AND h.to_stage IN ('trial_booked','trial_completed')))::int AS trials,
              round(avg(extract(epoch FROM (converted_at - created_at)) / 86400) FILTER (WHERE stage = 'won')::numeric, 1) AS avg_days_to_close,
              round(avg(extract(epoch FROM (COALESCE(last_contacted_at, now()) - created_at)) / 3600) FILTER (WHERE last_contacted_at IS NOT NULL)::numeric, 1) AS avg_hours_to_contact
         FROM leads l WHERE organization_id = $1 AND branch_id = ANY($2) AND ${inRange('created_at')}`, r.scope),
    query(
      `SELECT COALESCE(s.name, 'Unknown') AS source, count(*)::int AS leads, count(*) FILTER (WHERE l.stage = 'won')::int AS won,
              round(100.0 * count(*) FILTER (WHERE l.stage = 'won') / NULLIF(count(*), 0), 1) AS conversion,
              round(COALESCE(sum((SELECT sum(i.amount_paid) FROM invoices i WHERE i.member_id = l.converted_member_id AND i.status <> 'void')), 0), 2) AS revenue
         FROM leads l LEFT JOIN lead_sources s ON s.id = l.source_id
        WHERE l.organization_id = $1 AND l.branch_id = ANY($2) AND ${inRange('l.created_at')}
        GROUP BY s.name ORDER BY leads DESC`, r.scope),
    query(
      `SELECT u.full_name AS salesperson, ro.name AS role,
              (SELECT count(*) FROM leads l WHERE l.assigned_to = u.id AND l.branch_id = ANY($2) AND ${inRange('l.created_at')})::int AS leads,
              (SELECT count(*) FROM leads l WHERE l.assigned_to = u.id AND l.branch_id = ANY($2) AND l.stage = 'won' AND ${inRange('l.converted_at')})::int AS won,
              (SELECT count(*) FROM memberships ms WHERE ms.created_by = u.id AND ms.branch_id = ANY($2) AND ms.status <> 'cancelled' AND ${inRange('ms.created_at')})::int AS memberships_sold,
              (SELECT round(COALESCE(sum(ms.price), 0), 2) FROM memberships ms WHERE ms.created_by = u.id AND ms.branch_id = ANY($2) AND ms.status <> 'cancelled' AND ${inRange('ms.created_at')}) AS sales_value,
              (SELECT round(COALESCE(sum(p.amount), 0), 2) FROM payments p WHERE p.collected_by = u.id AND p.branch_id = ANY($2) AND p.status = 'recorded' AND ${inRange('p.paid_at')}) AS collected
         FROM users u JOIN roles ro ON ro.id = u.role_id
        WHERE u.organization_id = $1 AND u.kind = 'staff' AND ro.key IN ('sales','front_desk','branch_manager','super_admin')
        ORDER BY sales_value DESC`, r.scope),
    query(
      `SELECT COALESCE(u.full_name, 'Unassigned') AS staff, count(*)::int AS due,
              count(*) FILTER (WHERE f.status = 'done')::int AS done,
              count(*) FILTER (WHERE f.status = 'done' AND f.completed_at < f.due_at + interval '1 day')::int AS on_time,
              count(*) FILTER (WHERE f.status = 'pending' AND f.due_at < now())::int AS overdue,
              count(*) FILTER (WHERE f.outcome IN ('converted','renewed','paid'))::int AS won
         FROM follow_ups f LEFT JOIN users u ON u.id = f.assigned_to
        WHERE f.organization_id = $1 AND f.branch_id = ANY($2) AND ${inRange('f.due_at')}
        GROUP BY u.full_name ORDER BY due DESC`, r.scope),
    query(
      `SELECT b::date AS date,
              (SELECT count(*) FROM leads l WHERE l.organization_id = $1 AND l.branch_id = ANY($2) AND date_trunc('${r.bucket}', l.created_at) = b)::int AS leads,
              (SELECT count(*) FROM leads l WHERE l.organization_id = $1 AND l.branch_id = ANY($2) AND l.stage = 'won' AND date_trunc('${r.bucket}', l.converted_at) = b)::int AS won
         FROM ${series(r.bucket)} ORDER BY b`, r.scope),
  ]);
  send(res, r, 'sales', {
    funnel: { ...funnel, conversion: funnel!.leads ? Math.round((funnel!.won / funnel!.leads) * 1000) / 10 : 0 },
    bySource, bySalesperson: bySalesperson.filter((s) => s.leads || s.memberships_sold || Number(s.collected)), followUps, trend,
  });
});

// --------------------------------------------------------------- attendance --

reportsRouter.get('/attendance', can('reports.read'), async (req, res) => {
  const r = range(req);
  const [trend, totals, heat, classes, distribution, inactive] = await Promise.all([
    query(
      `SELECT b::date AS date, (SELECT count(*) FROM attendance a WHERE a.organization_id = $1 AND a.branch_id = ANY($2) AND a.status <> 'denied'
                                   AND date_trunc('${r.bucket}', a.checked_in_at) = b)::int AS visits
         FROM ${series(r.bucket)} ORDER BY b`, r.scope),
    one(
      `SELECT count(*) FILTER (WHERE status <> 'denied')::int AS visits, count(DISTINCT member_id) FILTER (WHERE status <> 'denied')::int AS unique_members,
              count(*) FILTER (WHERE status = 'denied')::int AS denied, count(*) FILTER (WHERE status = 'override')::int AS overrides
         FROM attendance WHERE organization_id = $1 AND branch_id = ANY($2) AND ${inRange('checked_in_at')}`, r.scope),
    query(
      `SELECT extract(isodow FROM checked_in_at)::int - 1 AS dow, extract(hour FROM checked_in_at)::int AS hour,
              round(count(*)::numeric / GREATEST(1, ($4::date - $3::date + 1) / 7.0), 1) AS avg
         FROM attendance WHERE organization_id = $1 AND branch_id = ANY($2) AND status <> 'denied' AND ${inRange('checked_in_at')}
        GROUP BY 1, 2`, r.scope),
    query(
      `WITH s AS (
         SELECT cs.id, ct.name, cs.capacity,
                (SELECT count(*) FROM class_bookings cb WHERE cb.session_id = cs.id AND cb.status IN ('booked','attended','no_show')) AS booked,
                (SELECT count(*) FROM class_bookings cb WHERE cb.session_id = cs.id AND cb.status = 'attended') AS attended,
                (SELECT count(*) FROM class_bookings cb WHERE cb.session_id = cs.id AND cb.status = 'no_show') AS no_show
           FROM class_sessions cs JOIN class_types ct ON ct.id = cs.class_type_id
          WHERE cs.organization_id = $1 AND cs.branch_id = ANY($2) AND cs.status <> 'cancelled' AND cs.starts_at < now() AND ${inRange('cs.starts_at')})
       SELECT name AS class, count(*)::int AS sessions, sum(capacity)::int AS capacity, sum(booked)::int AS booked, sum(attended)::int AS attended,
              round(100.0 * sum(attended) / NULLIF(sum(attended) + sum(no_show), 0), 1) AS show_rate,
              round(100.0 * sum(booked) / NULLIF(sum(capacity), 0), 1) AS fill_rate
         FROM s GROUP BY name ORDER BY attended DESC`, r.scope),
    // How often active members came, bucketed per week of the range.
    query(
      `WITH v AS (
         SELECT m.id, (SELECT count(*) FROM attendance a WHERE a.member_id = m.id AND a.status <> 'denied' AND ${inRange('a.checked_in_at')}) AS n
           FROM members m JOIN member_current_membership cm ON cm.member_id = m.id
          WHERE m.organization_id = $1 AND m.branch_id = ANY($2) AND cm.status IN ('active','expiring_soon'))
       SELECT bucket, count(*)::int AS members FROM (
         SELECT CASE WHEN n = 0 THEN '0' WHEN n::numeric / GREATEST(1, ($4::date - $3::date + 1) / 7.0) < 1 THEN 'under 1'
                     WHEN n::numeric / GREATEST(1, ($4::date - $3::date + 1) / 7.0) < 2 THEN '1–2'
                     WHEN n::numeric / GREATEST(1, ($4::date - $3::date + 1) / 7.0) < 4 THEN '2–4' ELSE '4+' END AS bucket FROM v) x
        GROUP BY bucket`, r.scope),
    query(
      `SELECT u.full_name AS member, m.member_code, b.name AS branch, cm.plan_name AS plan, cm.end_date AS expires, vs.last_visit_at::date AS last_visit,
              (current_date - COALESCE(vs.last_visit_at::date, m.join_date))::int AS idle_days, u.phone
         FROM members m JOIN users u ON u.id = m.user_id JOIN branches b ON b.id = m.branch_id
         JOIN member_current_membership cm ON cm.member_id = m.id JOIN member_visit_stats vs ON vs.member_id = m.id JOIN organizations o ON o.id = m.organization_id
        WHERE m.organization_id = $1 AND m.branch_id = ANY($2) AND cm.status IN ('active','expiring_soon') AND NOT cm.is_pass
          AND COALESCE(vs.last_visit_at, m.join_date::timestamptz) < now() - make_interval(days => o.inactive_after_days)
        ORDER BY idle_days DESC LIMIT 200`, [auth(req).orgId, branchScope(req)]),
  ]);
  const order = ['0', 'under 1', '1–2', '2–4', '4+'];
  send(res, r, 'attendance', {
    totals: { ...totals, perDay: Math.round((totals!.visits / r.days) * 10) / 10 },
    trend, heat, classes, distribution: order.map((k) => ({ bucket: k, members: distribution.find((d) => d.bucket === k)?.members ?? 0 })), inactive,
  });
});

// ---------------------------------------------------------------- financial --

reportsRouter.get('/financial', can('reports.read'), async (req, res) => {
  const r = range(req);
  const canExpenses = auth(req).permissions.has('expenses.read');
  const [trend, totals, aging, refunds] = await Promise.all([
    query(
      `SELECT b::date AS date,
              COALESCE((SELECT sum(amount) FROM payments p WHERE p.organization_id = $1 AND p.branch_id = ANY($2) AND p.status = 'recorded' AND date_trunc('${r.bucket}', p.paid_at) = b AND ${inRange('p.paid_at')}), 0) AS revenue,
              COALESCE((SELECT sum(amount) FROM refunds rf WHERE rf.organization_id = $1 AND rf.branch_id = ANY($2) AND date_trunc('${r.bucket}', rf.created_at) = b AND ${inRange('rf.created_at')}), 0) AS refunds,
              COALESCE((SELECT sum(amount) FROM expenses e WHERE e.organization_id = $1 AND e.branch_id = ANY($2) AND e.status = 'recorded' AND date_trunc('${r.bucket}', e.expense_date::timestamptz) = b AND e.expense_date BETWEEN $3::date AND $4::date), 0) AS expenses
         FROM ${series(r.bucket)} ORDER BY b`, r.scope),
    one(
      `SELECT (SELECT COALESCE(sum(amount), 0) FROM payments WHERE organization_id = $1 AND branch_id = ANY($2) AND status = 'recorded' AND ${inRange('paid_at')}) AS revenue,
              (SELECT COALESCE(sum(amount), 0) FROM refunds WHERE organization_id = $1 AND branch_id = ANY($2) AND ${inRange('created_at')}) AS refunds,
              (SELECT COALESCE(sum(amount), 0) FROM expenses WHERE organization_id = $1 AND branch_id = ANY($2) AND status = 'recorded' AND expense_date BETWEEN $3::date AND $4::date) AS expenses,
              (SELECT COALESCE(sum(total - amount_paid), 0) FROM invoices WHERE organization_id = $1 AND branch_id = ANY($2) AND status IN ('pending','partially_paid')) AS outstanding,
              (SELECT COALESCE(sum(tax), 0) FROM invoices WHERE organization_id = $1 AND branch_id = ANY($2) AND status <> 'void' AND issue_date BETWEEN $3::date AND $4::date) AS gst_billed`, r.scope),
    query(
      `SELECT CASE WHEN age <= 7 THEN '0–7 days' WHEN age <= 30 THEN '8–30 days' WHEN age <= 60 THEN '31–60 days' ELSE '60+ days' END AS bucket,
              count(*)::int AS invoices, round(sum(balance), 2) AS amount
         FROM (SELECT current_date - COALESCE(due_date, issue_date) AS age, total - amount_paid AS balance FROM invoices
                WHERE organization_id = $1 AND branch_id = ANY($2) AND status IN ('pending','partially_paid')) x
        GROUP BY 1 ORDER BY min(age)`, [auth(req).orgId, branchScope(req)]),
    query(
      `SELECT rf.refund_number, rf.created_at::date AS date, i.invoice_number, COALESCE(u.full_name, i.customer_name) AS customer, rf.method, rf.amount, rf.reason
         FROM refunds rf JOIN invoices i ON i.id = rf.invoice_id LEFT JOIN members m ON m.id = rf.member_id LEFT JOIN users u ON u.id = m.user_id
        WHERE rf.organization_id = $1 AND rf.branch_id = ANY($2) AND ${inRange('rf.created_at')} ORDER BY rf.created_at DESC LIMIT 200`, r.scope),
  ]);
  const t = totals!;
  const net = Number(t.revenue) - Number(t.refunds);
  send(res, r, 'financial', {
    totals: { revenue: Number(t.revenue), refunds: Number(t.refunds), netRevenue: net, expenses: canExpenses ? Number(t.expenses) : null, profit: canExpenses ? net - Number(t.expenses) : null, outstanding: Number(t.outstanding), gstBilled: Number(t.gst_billed) },
    trend: trend.map((x) => ({ date: x.date, revenue: Number(x.revenue) - Number(x.refunds), refunds: Number(x.refunds), ...(canExpenses ? { expenses: Number(x.expenses), profit: Number(x.revenue) - Number(x.refunds) - Number(x.expenses) } : {}) })),
    aging, refunds,
  });
});
