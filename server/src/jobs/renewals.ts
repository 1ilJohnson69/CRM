import { generateSessions } from '../modules/ops/classes.js';
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

/**
 * Operations automation: keep the timetable three weeks ahead, close
 * finished classes, turn "stopped coming" into a win-back follow-up, and
 * remind members about tomorrow's classes and appointments.
 */
export async function runOpsAutomation() {
  await generateSessions();
  await pool.query(`UPDATE class_sessions SET status = 'completed' WHERE status = 'scheduled' AND ends_at < now() - interval '1 hour'`);

  await pool.query(`
    INSERT INTO follow_ups (organization_id, branch_id, member_id, type, purpose, due_at, assigned_to, notes, auto_generated)
    SELECT m.organization_id, m.branch_id, m.id, 'call', 'reactivation', date_trunc('day', now()) + interval '11 hours',
           m.assigned_staff_id,
           'No visit in ' || (current_date - COALESCE(vs.last_visit_at::date, m.join_date)) || ' days',
           true
      FROM members m
      JOIN organizations o ON o.id = m.organization_id
      JOIN member_current_membership cm ON cm.member_id = m.id
      JOIN member_visit_stats vs ON vs.member_id = m.id
     WHERE cm.status IN ('active', 'expiring_soon') AND NOT cm.is_pass
       AND COALESCE(vs.last_visit_at, m.join_date::timestamptz) < now() - make_interval(days => o.inactive_after_days)
       AND NOT EXISTS (SELECT 1 FROM follow_ups f WHERE f.member_id = m.id AND f.purpose IN ('reactivation', 'renewal')
                         AND (f.status = 'pending' OR f.created_at > now() - interval '30 days'))`);

  await pool.query(`
    WITH due AS (
      UPDATE appointments a SET reminder_sent_at = now()
       WHERE a.status = 'scheduled' AND a.member_id IS NOT NULL AND a.reminder_sent_at IS NULL
         AND a.starts_at > now() AND a.starts_at < now() + interval '24 hours'
      RETURNING a.*)
    INSERT INTO notifications (organization_id, branch_id, recipient_id, audience, type, title, body, entity_type, entity_id)
    SELECT d.organization_id, d.branch_id, m.user_id, 'member', 'appointment.reminder',
           CASE d.type WHEN 'pt' THEN 'PT session' WHEN 'nutrition' THEN 'Nutrition consult' WHEN 'assessment' THEN 'Fitness assessment' ELSE 'Appointment' END || ' tomorrow',
           to_char(d.starts_at AT TIME ZONE o.timezone, 'Dy DD Mon, HH12:MI AM') || COALESCE(' with ' || su.full_name, ''),
           'appointment', d.id
      FROM due d JOIN members m ON m.id = d.member_id JOIN organizations o ON o.id = d.organization_id LEFT JOIN users su ON su.id = d.staff_id`);

  await pool.query(`
    WITH due AS (
      UPDATE class_bookings cb SET reminder_sent_at = now() FROM class_sessions cs
       WHERE cs.id = cb.session_id AND cb.status = 'booked' AND cb.reminder_sent_at IS NULL AND cs.status = 'scheduled'
         AND cs.starts_at > now() AND cs.starts_at < now() + interval '24 hours'
      RETURNING cb.member_id, cs.id AS session_id, cs.starts_at, cs.class_type_id, cs.organization_id, cs.branch_id)
    INSERT INTO notifications (organization_id, branch_id, recipient_id, audience, type, title, body, entity_type, entity_id)
    SELECT d.organization_id, d.branch_id, m.user_id, 'member', 'class.reminder', ct.name || ' coming up',
           to_char(d.starts_at AT TIME ZONE o.timezone, 'Dy DD Mon, HH12:MI AM') || ' · cancel in the app if you can’t make it',
           'class_session', d.session_id
      FROM due d JOIN members m ON m.id = d.member_id JOIN class_types ct ON ct.id = d.class_type_id JOIN organizations o ON o.id = d.organization_id`);
}

/** Tell trainers a few days before a member's workout plan runs out. */
export async function runFitnessAutomation() {
  await pool.query(`
    WITH due AS (
      UPDATE workout_plans SET end_notified_at = now()
       WHERE status = 'active' AND member_id IS NOT NULL AND trainer_id IS NOT NULL AND end_notified_at IS NULL
         AND ends_on BETWEEN current_date AND current_date + 3
      RETURNING id, organization_id, branch_id, member_id, trainer_id, name, ends_on)
    INSERT INTO notifications (organization_id, branch_id, recipient_id, audience, type, title, body, entity_type, entity_id)
    SELECT d.organization_id, d.branch_id, d.trainer_id, 'staff', 'workout_plan.ending', u.full_name || '’s plan ends ' || to_char(d.ends_on, 'DD Mon'),
           d.name || ' — time to review progress and set the next block.', 'workout_plan', d.id
      FROM due d JOIN members m ON m.id = d.member_id JOIN users u ON u.id = m.user_id`);
}

export function scheduleJobs() {
  const run = () =>
    runRenewalReminders()
      .then(runFollowUpAutomation)
      .then(runOpsAutomation)
      .then(runFitnessAutomation)
      .catch((err) => console.error('scheduled jobs failed', err));
  run();
  setInterval(run, 60 * 60 * 1000).unref();
}
