import { pool } from '../db/pool.js';

/**
 * Renewal reminders. Idempotent per day: safe to run on every boot and
 * hourly. Member notifications go to the Member App; staff get one digest
 * per branch.
 */
export async function runRenewalReminders() {
  await pool.query(`
    INSERT INTO notifications (organization_id, branch_id, recipient_id, audience, type, priority, title, body, entity_type, entity_id)
    SELECT m.organization_id, m.branch_id, m.user_id, 'member', 'membership.expiry_reminder',
           CASE WHEN cm.days_remaining <= 1 THEN 'high' ELSE 'normal' END,
           CASE WHEN cm.days_remaining = 0 THEN 'Your membership expires today'
                ELSE 'Your membership expires in ' || cm.days_remaining || ' day' || CASE WHEN cm.days_remaining = 1 THEN '' ELSE 's' END END,
           'Renew ' || cm.plan_name || ' at the front desk to keep your access uninterrupted.',
           'membership', cm.membership_id
      FROM members m
      JOIN organizations o ON o.id = m.organization_id
      JOIN member_current_membership cm ON cm.member_id = m.id
     WHERE cm.status IN ('active', 'expiring_soon') AND NOT cm.has_upcoming AND NOT cm.is_pass
       AND cm.days_remaining = ANY(o.renewal_reminder_days)
       AND NOT EXISTS (
         SELECT 1 FROM notifications n WHERE n.type = 'membership.expiry_reminder'
            AND n.entity_id = cm.membership_id AND n.created_at >= current_date)`);

  await pool.query(`
    INSERT INTO notifications (organization_id, branch_id, audience, type, priority, title, body)
    SELECT m.organization_id, m.branch_id, 'staff', 'renewals.digest',
           CASE WHEN count(*) FILTER (WHERE cm.days_remaining = 0) > 0 THEN 'high' ELSE 'normal' END,
           count(*) || ' memberships expire this week at ' || b.name,
           count(*) FILTER (WHERE cm.days_remaining = 0) || ' expire today. Open the dashboard to contact and renew.'
      FROM members m
      JOIN branches b ON b.id = m.branch_id
      JOIN member_current_membership cm ON cm.member_id = m.id
     WHERE cm.status IN ('active', 'expiring_soon') AND NOT cm.has_upcoming AND NOT cm.is_pass AND cm.days_remaining BETWEEN 0 AND 7
       AND NOT EXISTS (
         SELECT 1 FROM notifications n WHERE n.type = 'renewals.digest' AND n.branch_id = m.branch_id AND n.created_at >= current_date)
     GROUP BY m.organization_id, m.branch_id, b.name`);
}

export function scheduleJobs() {
  const run = () => runRenewalReminders().catch((err) => console.error('renewal reminders failed', err));
  run();
  setInterval(run, 60 * 60 * 1000).unref();
}
