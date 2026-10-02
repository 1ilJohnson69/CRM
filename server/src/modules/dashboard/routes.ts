import { Router } from 'express';
import { z } from 'zod';
import { one, query } from '../../db/pool.js';
import { auth, branchScope, can } from '../../lib/auth.js';

export const dashboardRouter = Router();

const pct = (now: number, before: number) => (before ? Math.round(((now - before) / before) * 1000) / 10 : now ? 100 : 0);

dashboardRouter.get('/summary', can('dashboard.view'), async (req, res) => {
  const scope = [auth(req).orgId, branchScope(req)];

  const [active, activeSeries, revenue, revenueSeries, joins, joinSeries, renewals, outstanding, leads, leadSeries, visits, visitSeries] = await Promise.all([
    one(
      `SELECT count(*) FILTER (WHERE cm.status IN ('active','expiring_soon')) AS active,
              count(*) FILTER (WHERE cm.status = 'frozen') AS frozen
         FROM members m JOIN member_current_membership cm ON cm.member_id = m.id
        WHERE m.organization_id = $1 AND m.branch_id = ANY($2)`,
      scope,
    ),
    query(
      `SELECT d::date AS date,
              (SELECT count(DISTINCT ms.member_id) FROM memberships ms
                WHERE ms.organization_id = $1 AND ms.branch_id = ANY($2) AND ms.status IN ('active','frozen')
                  AND ms.start_date <= d AND ms.end_date >= d) AS value
         FROM generate_series(current_date - 56, current_date, interval '7 days') d ORDER BY d`,
      scope,
    ),
    one(
      `SELECT COALESCE(sum(amount) FILTER (WHERE paid_at >= current_date - 29), 0) AS last_30,
              COALESCE(sum(amount) FILTER (WHERE paid_at < current_date - 29), 0) AS prior_30,
              COALESCE(sum(amount) FILTER (WHERE paid_at >= current_date), 0) AS today,
              count(*) FILTER (WHERE paid_at >= current_date AND amount > 0) AS today_count
         FROM (SELECT paid_at, amount FROM payments WHERE organization_id = $1 AND branch_id = ANY($2) AND status = 'recorded' AND paid_at >= current_date - 59
               UNION ALL
               -- Refunds net off revenue on the day they're given.
               SELECT created_at, -amount FROM refunds WHERE organization_id = $1 AND branch_id = ANY($2) AND created_at >= current_date - 59) x`,
      scope,
    ),
    query(
      `SELECT d::date AS date,
              COALESCE((SELECT sum(p.amount) FROM payments p WHERE p.paid_at >= d AND p.paid_at < d + interval '1 day'
                         AND p.organization_id = $1 AND p.branch_id = ANY($2) AND p.status = 'recorded'), 0)
            - COALESCE((SELECT sum(r.amount) FROM refunds r WHERE r.created_at >= d AND r.created_at < d + interval '1 day'
                         AND r.organization_id = $1 AND r.branch_id = ANY($2)), 0) AS value
         FROM generate_series(current_date - 29, current_date, interval '1 day') d ORDER BY d`,
      scope,
    ),
    one(
      `SELECT count(*) FILTER (WHERE join_date >= date_trunc('month', current_date)) AS this_month,
              count(*) FILTER (WHERE join_date >= date_trunc('month', current_date) - interval '1 month'
                                 AND join_date <= current_date - interval '1 month') AS last_month_to_date
         FROM members WHERE organization_id = $1 AND branch_id = ANY($2)`,
      scope,
    ),
    query(
      `SELECT d::date AS date, (SELECT count(*) FROM members m WHERE m.organization_id = $1 AND m.branch_id = ANY($2)
                                  AND m.join_date > d::date - 7 AND m.join_date <= d::date) AS value
         FROM generate_series(current_date - 56, current_date, interval '7 days') d ORDER BY d`,
      scope,
    ),
    one(
      `SELECT count(*) FILTER (WHERE cm.end_date <= current_date + 7) AS week,
              count(*) FILTER (WHERE cm.end_date = current_date) AS today,
              COALESCE(sum(cm.price) FILTER (WHERE cm.end_date <= current_date + 7), 0) AS week_value
         FROM members m JOIN member_current_membership cm ON cm.member_id = m.id
        WHERE m.organization_id = $1 AND m.branch_id = ANY($2)
          AND cm.status IN ('active','expiring_soon') AND cm.end_date >= current_date AND NOT cm.has_upcoming AND NOT cm.is_pass`,
      scope,
    ),
    one(
      `SELECT COALESCE(sum(total - amount_paid), 0) AS amount, count(*) AS invoices
         FROM invoices WHERE organization_id = $1 AND branch_id = ANY($2) AND status IN ('pending','partially_paid')`,
      scope,
    ),
    one(
      `SELECT count(*) FILTER (WHERE created_at >= date_trunc('month', current_date)) AS this_month,
              count(*) FILTER (WHERE created_at >= date_trunc('month', current_date) - interval '1 month'
                                 AND created_at < now() - interval '1 month') AS last_month_to_date,
              count(*) FILTER (WHERE stage = 'won' AND converted_at >= current_date - 89) AS won_90,
              count(*) FILTER (WHERE stage = 'lost' AND stage_changed_at >= current_date - 89) AS lost_90
         FROM leads WHERE organization_id = $1 AND branch_id = ANY($2)`,
      scope,
    ),
    query(
      `SELECT d::date AS date, (SELECT count(*) FROM leads l WHERE l.organization_id = $1 AND l.branch_id = ANY($2)
                                  AND l.created_at >= d - interval '6 days' AND l.created_at < d + interval '1 day') AS value
         FROM generate_series(current_date - 56, current_date, interval '7 days') d ORDER BY d`,
      scope,
    ),
    one(
      `SELECT count(*) FILTER (WHERE checked_in_at >= current_date) AS today,
              count(*) FILTER (WHERE checked_in_at >= current_date - 7 AND checked_in_at < now() - interval '7 days') AS same_time_last_week
         FROM attendance WHERE organization_id = $1 AND branch_id = ANY($2) AND status <> 'denied' AND checked_in_at >= current_date - 7`,
      scope,
    ),
    query(
      `SELECT d::date AS date, (SELECT count(*) FROM attendance a WHERE a.organization_id = $1 AND a.branch_id = ANY($2) AND a.status <> 'denied'
                                  AND a.checked_in_at >= d AND a.checked_in_at < d + interval '1 day') AS value
         FROM generate_series(current_date - 13, current_date, interval '1 day') d ORDER BY d`,
      scope,
    ),
  ]);

  const activeValues = activeSeries.map((r) => Number(r.value));
  res.json({
    activeMembers: {
      value: Number(active!.active),
      frozen: Number(active!.frozen),
      change: pct(activeValues.at(-1)!, activeValues.at(-5) ?? 0),
      series: activeValues,
    },
    revenue: {
      value: revenue!.last_30,
      change: pct(revenue!.last_30, revenue!.prior_30),
      today: revenue!.today,
      todayCount: Number(revenue!.today_count),
      series: revenueSeries.map((r) => r.value),
    },
    newMembers: {
      value: Number(joins!.this_month),
      change: pct(Number(joins!.this_month), Number(joins!.last_month_to_date)),
      series: joinSeries.map((r) => Number(r.value)),
    },
    newLeads: {
      value: Number(leads!.this_month),
      change: pct(Number(leads!.this_month), Number(leads!.last_month_to_date)),
      conversionRate: Number(leads!.won_90) + Number(leads!.lost_90)
        ? Math.round((Number(leads!.won_90) / (Number(leads!.won_90) + Number(leads!.lost_90))) * 1000) / 10
        : 0,
      series: leadSeries.map((r) => Number(r.value)),
    },
    todayAttendance: {
      value: Number(visits!.today),
      change: pct(Number(visits!.today), Number(visits!.same_time_last_week)),
      series: visitSeries.map((r) => Number(r.value)),
    },
    renewalsDue: { value: Number(renewals!.week), today: Number(renewals!.today), atStake: renewals!.week_value },
    outstanding: { value: outstanding!.amount, invoices: Number(outstanding!.invoices) },
  });
});

dashboardRouter.get('/revenue', can('dashboard.view'), async (req, res) => {
  const { days } = z.object({ days: z.coerce.number().int().refine((d) => [7, 30, 90, 365].includes(d)).default(30) }).parse(req.query);
  const bucket = days === 365 ? 'month' : 'day';
  const scope = [auth(req).orgId, branchScope(req), days];

  // Payments are split across an invoice's line items in proportion to each
  // line's share of the invoice total, so mixed invoices attribute correctly.
  const allocated = `SELECT * FROM (
    SELECT p.paid_at, ii.item_type, p.amount * (ii.amount / NULLIF((SELECT sum(x.amount) FROM invoice_items x WHERE x.invoice_id = i.id), 0)) AS amount
      FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN invoice_items ii ON ii.invoice_id = i.id
     WHERE p.organization_id = $1 AND p.branch_id = ANY($2) AND p.status = 'recorded'
     UNION ALL
    SELECT r.created_at, 'product', -r.amount FROM refunds r WHERE r.organization_id = $1 AND r.branch_id = ANY($2)) z WHERE true`;

  const series = await query(
    `WITH a AS (${allocated} AND z.paid_at >= date_trunc('${bucket}', current_date - ($3::int - 1)))
     SELECT b::date AS date,
            COALESCE(sum(a.amount) FILTER (WHERE a.item_type = 'membership'), 0) AS membership,
            COALESCE(sum(a.amount) FILTER (WHERE a.item_type = 'pt'), 0) AS pt,
            COALESCE(sum(a.amount) FILTER (WHERE a.item_type = 'class'), 0) AS class,
            COALESCE(sum(a.amount) FILTER (WHERE a.item_type = 'product'), 0) AS product,
            COALESCE(sum(a.amount) FILTER (WHERE a.item_type IN ('event','other')), 0) AS other
       FROM generate_series(date_trunc('${bucket}', current_date - ($3::int - 1)), current_date, interval '1 ${bucket}') b
       LEFT JOIN a ON date_trunc('${bucket}', a.paid_at) = b
      GROUP BY b ORDER BY b`,
    scope,
  );
  const previous = await one(
    `WITH a AS (${allocated} AND z.paid_at >= current_date - ($3::int * 2 - 1) AND z.paid_at < current_date - ($3::int - 1))
     SELECT COALESCE(sum(amount), 0) AS total FROM a`,
    scope,
  );
  const round = (n: number) => Math.round(n);
  const data = series.map((r) => ({
    date: r.date,
    membership: round(r.membership),
    pt: round(r.pt),
    class: round(r.class),
    product: round(r.product),
    other: round(r.other),
  }));
  const total = data.reduce((s, r) => s + r.membership + r.pt + r.class + r.product + r.other, 0);
  const byService = ['membership', 'pt', 'class', 'product', 'other'].map((k) => ({
    key: k,
    value: data.reduce((s, r) => s + (r as any)[k], 0),
  }));
  res.json({ bucket, series: data, total, averageDaily: Math.round(total / days), growth: pct(total, previous!.total), byService });
});

dashboardRouter.get('/membership-health', can('dashboard.view'), async (req, res) => {
  const rows = await query(
    `SELECT cm.status, count(*) AS count FROM members m JOIN member_current_membership cm ON cm.member_id = m.id
      WHERE m.organization_id = $1 AND m.branch_id = ANY($2) GROUP BY cm.status`,
    [auth(req).orgId, branchScope(req)],
  );
  const counts = Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
  res.json(
    ['active', 'expiring_soon', 'expired', 'frozen', 'cancelled', 'pending'].map((status) => ({ status, count: counts[status] ?? 0 })),
  );
});

dashboardRouter.get('/attention', can('dashboard.view', 'members.read'), async (req, res) => {
  const rows = await query(
    `SELECT m.id AS member_id, m.member_code, u.full_name, u.phone, u.avatar_url, cm.membership_id, cm.plan_id, cm.plan_name,
            cm.end_date, cm.days_remaining, cm.status, p.price AS renewal_amount, su.full_name AS assigned_staff
       FROM members m
       JOIN users u ON u.id = m.user_id
       JOIN member_current_membership cm ON cm.member_id = m.id
       JOIN membership_plans p ON p.id = cm.plan_id
       LEFT JOIN users su ON su.id = m.assigned_staff_id
      WHERE m.organization_id = $1 AND m.branch_id = ANY($2)
        AND cm.status IN ('active','expiring_soon','expired')
        AND cm.end_date BETWEEN current_date - 30 AND current_date + 7
        AND NOT cm.has_upcoming AND NOT cm.is_pass
      ORDER BY abs(cm.days_remaining), cm.end_date
      LIMIT 60`,
    [auth(req).orgId, branchScope(req)],
  );
  const bucket = (d: number) => (d < 0 ? 'expired' : d === 0 ? 'today' : d <= 3 ? 'in3' : 'in7');
  res.json(rows.map((r) => ({ ...r, bucket: bucket(r.days_remaining) })));
});

dashboardRouter.get('/activity', can('dashboard.view'), async (req, res) => {
  const rows = await query(
    `SELECT a.id, a.action, a.entity_type, a.entity_id, a.summary, a.created_at, u.full_name AS actor
       FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.organization_id = $1 AND (a.branch_id IS NULL OR a.branch_id = ANY($2))
        AND a.action NOT IN ('invoice.created')
      ORDER BY a.created_at DESC LIMIT 14`,
    [auth(req).orgId, branchScope(req)],
  );
  res.json(rows);
});

dashboardRouter.get('/staff', can('dashboard.view'), async (req, res) => {
  const rows = await query(
    `WITH pay AS (
       SELECT collected_by AS user_id, sum(amount) AS collected, count(*) AS collections
         FROM payments WHERE organization_id = $1 AND branch_id = ANY($2) AND status = 'recorded'
          AND paid_at >= date_trunc('month', current_date) GROUP BY collected_by),
     sales AS (
       SELECT created_by AS user_id, count(*) FILTER (WHERE kind = 'new') AS new_sales,
              count(*) FILTER (WHERE kind = 'renewal') AS renewals,
              count(*) FILTER (WHERE kind IN ('upgrade','downgrade')) AS changes
         FROM memberships WHERE organization_id = $1 AND branch_id = ANY($2) AND status <> 'cancelled'
          AND created_at >= date_trunc('month', current_date) GROUP BY created_by)
     SELECT u.id, u.full_name, u.avatar_url, r.name AS role_name,
            COALESCE(pay.collected, 0) AS collected, COALESCE(pay.collections, 0) AS collections,
            COALESCE(sales.new_sales, 0) AS new_sales, COALESCE(sales.renewals, 0) AS renewals
       FROM users u JOIN roles r ON r.id = u.role_id
       LEFT JOIN pay ON pay.user_id = u.id LEFT JOIN sales ON sales.user_id = u.id
      WHERE u.organization_id = $1 AND u.kind = 'staff' AND (pay.user_id IS NOT NULL OR sales.user_id IS NOT NULL)
      ORDER BY collected DESC LIMIT 6`,
    [auth(req).orgId, branchScope(req)],
  );
  res.json(rows);
});

dashboardRouter.get('/pipeline', can('dashboard.view', 'leads.read'), async (req, res) => {
  const scope = [auth(req).orgId, branchScope(req)];
  const [stages, sources, flow] = await Promise.all([
    query(
      `SELECT l.stage, count(*) AS count, COALESCE(sum(COALESCE(l.expected_value, p.price)), 0) AS value
         FROM leads l LEFT JOIN membership_plans p ON p.id = l.interested_plan_id
        WHERE l.organization_id = $1 AND l.branch_id = ANY($2)
          AND (l.stage NOT IN ('won','lost') OR l.stage_changed_at >= current_date - 29)
        GROUP BY l.stage`,
      scope,
    ),
    query(
      `SELECT COALESCE(s.name, 'Unknown') AS source, count(*) AS leads, count(*) FILTER (WHERE l.stage = 'won') AS won
         FROM leads l LEFT JOIN lead_sources s ON s.id = l.source_id
        WHERE l.organization_id = $1 AND l.branch_id = ANY($2) AND l.created_at >= current_date - 89
        GROUP BY 1 ORDER BY leads DESC LIMIT 6`,
      scope,
    ),
    // Of leads created in the last 90 days: how far did each get? Trials are a
    // side path (many win without one), so they're reported separately.
    one(
      `SELECT count(*) AS leads,
              count(*) FILTER (WHERE x.stages && ARRAY['contacted','interested','trial_booked','trial_completed','negotiation','won']) AS contacted,
              count(*) FILTER (WHERE x.stages && ARRAY['interested','trial_booked','trial_completed','negotiation','won']) AS engaged,
              count(*) FILTER (WHERE x.stages && ARRAY['trial_booked','trial_completed']) AS trials,
              count(*) FILTER (WHERE x.stages && ARRAY['trial_booked','trial_completed'] AND x.stage = 'won') AS trials_won,
              count(*) FILTER (WHERE x.stage = 'won') AS won
         FROM (SELECT l.id, l.stage, array_agg(h.to_stage) AS stages FROM leads l JOIN lead_stage_history h ON h.lead_id = l.id
                WHERE l.organization_id = $1 AND l.branch_id = ANY($2) AND l.created_at >= current_date - 89 GROUP BY l.id) x`,
      scope,
    ),
  ]);
  const order = ['new', 'contacted', 'interested', 'trial_booked', 'trial_completed', 'negotiation', 'won', 'lost'];
  const by = Object.fromEntries(stages.map((s) => [s.stage, s]));
  const f = Object.fromEntries(Object.entries(flow!).map(([k, v]) => [k, Number(v)]));
  const funnel = [
    { stage: 'leads', label: 'Leads', reached: f.leads },
    { stage: 'contacted', label: 'Contacted', reached: f.contacted },
    { stage: 'engaged', label: 'Interested', reached: f.engaged },
    { stage: 'won', label: 'Converted', reached: f.won },
  ];
  res.json({
    stages: order.map((stage) => ({ stage, count: Number(by[stage]?.count ?? 0), value: Number(by[stage]?.value ?? 0) })),
    funnel,
    trials: { booked: f.trials, won: f.trials_won },
    sources: sources.map((s) => ({ source: s.source, leads: Number(s.leads), won: Number(s.won) })),
  });
});

dashboardRouter.get('/today', can('dashboard.view'), async (req, res) => {
  const scope = [auth(req).orgId, branchScope(req)];
  const [classes, appointments] = await Promise.all([
    auth(req).permissions.has('classes.read')
      ? query(
          `SELECT cs.id, cs.starts_at, cs.ends_at, cs.capacity, cs.status, ct.name AS class_name, tu.full_name AS trainer_name, b.name AS branch_name,
                  (SELECT count(*) FROM class_bookings cb WHERE cb.session_id = cs.id AND cb.status IN ('booked','attended','no_show'))::int AS booked,
                  (SELECT count(*) FROM class_bookings cb WHERE cb.session_id = cs.id AND cb.status = 'waitlisted')::int AS waitlisted
             FROM class_sessions cs JOIN class_types ct ON ct.id = cs.class_type_id JOIN branches b ON b.id = cs.branch_id
             LEFT JOIN users tu ON tu.id = cs.trainer_id
            WHERE cs.organization_id = $1 AND cs.branch_id = ANY($2) AND cs.starts_at >= current_date AND cs.starts_at < current_date + 1
            ORDER BY cs.starts_at`,
          scope,
        )
      : [],
    auth(req).permissions.has('appointments.read')
      ? query(
          `SELECT a.*, su.full_name AS staff_name, COALESCE(mu.full_name, l.full_name) AS client_name
             FROM appointments a LEFT JOIN users su ON su.id = a.staff_id LEFT JOIN members m ON m.id = a.member_id
             LEFT JOIN users mu ON mu.id = m.user_id LEFT JOIN leads l ON l.id = a.lead_id
            WHERE a.organization_id = $1 AND a.branch_id = ANY($2) AND a.starts_at >= current_date AND a.starts_at < current_date + 1 AND a.status <> 'cancelled'
            ORDER BY a.starts_at`,
          scope,
        )
      : [],
  ]);
  res.json({ classes, appointments });
});
