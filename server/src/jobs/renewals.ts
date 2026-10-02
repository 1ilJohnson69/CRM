import { generateSessions } from '../modules/ops/classes.js';
import { pool } from '../db/pool.js';
import { runAutomations } from '../modules/automation/engine.js';
import { runScheduledCampaigns } from '../modules/marketing/campaigns.js';
import { dispatchOutbox } from '../modules/messaging/service.js';

/**
 * Staff digest of the week's expiries, once per branch per day. Member
 * reminders, renewal calls and win-backs are configurable automation rules
 * (see modules/automation).
 */
export async function runRenewalReminders() {
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

/** Each staff member's daily digest of their follow-ups. */
export async function runFollowUpAutomation() {
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
 * Operations housekeeping: keep the timetable three weeks ahead, close
 * finished classes and events, and remind members about tomorrow's classes
 * and appointments.
 */
export async function runOpsAutomation() {
  await generateSessions();
  await pool.query(`UPDATE events SET status = 'completed', updated_at = now() WHERE status = 'published' AND ends_at < now() - interval '1 day'`);
  await pool.query(`UPDATE event_registrations r SET status = 'no_show' FROM events e WHERE e.id = r.event_id AND e.status = 'completed' AND r.status = 'registered'`);
  await pool.query(`UPDATE class_sessions SET status = 'completed' WHERE status = 'scheduled' AND ends_at < now() - interval '1 hour'`);

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
      .then(runAutomations)
      .catch((err) => console.error('scheduled jobs failed', err));
  run();
  setInterval(run, 60 * 60 * 1000).unref();
  // Campaigns and the outbox are time-sensitive: check every minute.
  const tick = () => runScheduledCampaigns().then(dispatchOutbox).catch((err) => console.error('messaging jobs failed', err));
  setInterval(tick, 60 * 1000).unref();
}
