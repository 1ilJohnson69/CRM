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

/**
 * Turns renewal risk into work: every member 7 days from expiry (or already
 * lapsed within 3 days) gets one renewal follow-up for their assigned staff.
 * Also sends each staff member a daily digest of their follow-ups.
 */
export async function runFollowUpAutomation() {
  await pool.query(`
    INSERT INTO follow_ups (organization_id, branch_id, member_id, type, purpose, due_at, assigned_to, notes, auto_generated)
    SELECT m.organization_id, m.branch_id, m.id, 'call', 'renewal',
           date_trunc('day', now()) + interval '10 hours',
           COALESCE(m.assigned_staff_id, (SELECT sb.user_id FROM staff_branches sb JOIN users su ON su.id = sb.user_id AND su.is_active
                                            JOIN roles r ON r.id = su.role_id AND r.key = 'front_desk'
                                           WHERE sb.branch_id = m.branch_id ORDER BY su.created_at LIMIT 1)),
           cm.plan_name || ' ' || CASE WHEN cm.days_remaining < 0 THEN 'expired ' || -cm.days_remaining || ' days ago' ELSE 'expires in ' || cm.days_remaining || ' days' END,
           true
      FROM members m
      JOIN member_current_membership cm ON cm.member_id = m.id
     WHERE cm.status IN ('active', 'expiring_soon', 'expired') AND NOT cm.has_upcoming AND NOT cm.is_pass
       AND cm.days_remaining BETWEEN -3 AND 7
       AND NOT EXISTS (
         SELECT 1 FROM follow_ups f WHERE f.member_id = m.id AND f.purpose = 'renewal'
            AND (f.status = 'pending' OR f.created_at >= cm.end_date - 10))`);

  await pool.query(`
    INSERT INTO notifications (organization_id, recipient_id, audience, type, priority, title, body)
    SELECT f.organization_id, f.assigned_to, 'staff', 'followups.digest',
           CASE WHEN count(*) FILTER (WHERE f.due_at < date_trunc('day', now())) > 0 THEN 'high' ELSE 'normal' END,
           count(*) || ' follow-ups on your list today',
           count(*) FILTER (WHERE f.due_at < date_trunc('day', now())) || ' overdue · ' ||
           count(*) FILTER (WHERE f.purpose = 'renewal') || ' renewals · ' ||
           count(*) FILTER (WHERE f.lead_id IS NOT NULL) || ' leads'
      FROM follow_ups f
     WHERE f.status = 'pending' AND f.assigned_to IS NOT NULL AND f.due_at < date_trunc('day', now()) + interval '1 day'
       AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.type = 'followups.digest' AND n.recipient_id = f.assigned_to AND n.created_at >= current_date)
     GROUP BY f.organization_id, f.assigned_to`);
}

export function scheduleJobs() {
  const run = () =>
    runRenewalReminders()
      .then(runFollowUpAutomation)
      .catch((err) => console.error('scheduled jobs failed', err));
  run();
  setInterval(run, 60 * 60 * 1000).unref();
}
