-- The membership a member is "on" right now: the one covering today if any,
-- otherwise the most recent one. Shared by the CRM, dashboard and Member App
-- so status is computed identically everywhere.
CREATE VIEW member_current_membership AS
SELECT m.id AS member_id,
       cm.id AS membership_id,
       cm.plan_id,
       cm.plan_name,
       cm.status AS stored_status,
       COALESCE(cm.effective_status, 'none') AS status,
       cm.start_date,
       cm.end_date,
       cm.frozen_until,
       cm.price,
       COALESCE(cm.is_pass, false) AS is_pass,
       CASE WHEN cm.end_date IS NULL THEN NULL ELSE cm.end_date - current_date END AS days_remaining,
       EXISTS (
         SELECT 1 FROM memberships nx
          WHERE nx.member_id = m.id AND nx.id <> cm.id
            AND nx.status IN ('active', 'frozen') AND nx.start_date > current_date
       ) AS has_upcoming
  FROM members m
  JOIN organizations o ON o.id = m.organization_id
  LEFT JOIN LATERAL (
    SELECT ms.*, p.name AS plan_name,
           -- Short passes (e.g. a day pass) are not "renewals" to chase.
           (p.duration_unit = 'day' AND p.duration_value < 7) AS is_pass,
           effective_membership_status(ms.status, ms.end_date, ms.frozen_until, o.expiring_soon_days) AS effective_status
      FROM memberships ms
      JOIN membership_plans p ON p.id = ms.plan_id
     WHERE ms.member_id = m.id
     ORDER BY (ms.status IN ('active', 'frozen') AND ms.start_date <= current_date AND ms.end_date >= current_date) DESC,
              (ms.status <> 'cancelled') DESC,
              ms.end_date DESC, ms.created_at DESC
     LIMIT 1
  ) cm ON true;

CREATE VIEW member_balances AS
SELECT m.id AS member_id,
       COALESCE(SUM(i.total - i.amount_paid) FILTER (WHERE i.status IN ('pending', 'partially_paid')), 0) AS outstanding,
       COALESCE(SUM(i.amount_paid) FILTER (WHERE i.status <> 'void'), 0) AS lifetime_value
  FROM members m
  LEFT JOIN invoices i ON i.member_id = m.id
 GROUP BY m.id;
