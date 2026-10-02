import type { PoolClient } from 'pg';
import { z } from 'zod';
import { one, pool, query, tx, type Db } from '../../db/pool.js';
import { notify } from '../../lib/audit.js';
import { postPoints } from '../engagement/loyalty.js';
import { enqueueMessage, render, subjectVars } from '../messaging/service.js';

// ------------------------------------------------------------------ triggers --

const plural = (list: number[], unit = 'day') => `${list.join(', ')} ${unit}${list.length === 1 && list[0] === 1 ? '' : 's'}`;
const days = z.array(z.coerce.number().int().min(0).max(365)).min(1).max(12);

export const TRIGGERS = {
  membership_expiring: { label: 'Membership expiring', subject: 'member', params: z.object({ days }), describe: (p: any) => `${plural(p.days)} before a membership ends` },
  membership_expired: { label: 'Membership expired', subject: 'member', params: z.object({ days }), describe: (p: any) => `${plural(p.days)} after a membership ends without renewal` },
  member_inactive: { label: 'Member inactive', subject: 'member', params: z.object({ days: z.coerce.number().int().min(3).max(180) }), describe: (p: any) => `Active member with no visit for ${p.days} days` },
  birthday: { label: 'Birthday', subject: 'member', params: z.object({}), describe: () => 'On a member’s birthday' },
  payment_overdue: { label: 'Payment overdue', subject: 'member', params: z.object({ days }), describe: (p: any) => `${plural(p.days)} after an unpaid invoice was due` },
  member_joined: { label: 'New member', subject: 'member', params: z.object({ days }), describe: (p: any) => p.days.map((d: number) => (d === 0 ? 'on joining' : `${d} days after joining`)).join(', ') },
  lead_uncontacted: { label: 'Lead not contacted', subject: 'lead', params: z.object({ hours: z.coerce.number().int().min(1).max(168) }), describe: (p: any) => `New lead with no contact after ${p.hours} hours` },
  event_upcoming: { label: 'Event coming up', subject: 'member', params: z.object({ hours: z.coerce.number().int().min(1).max(168) }), describe: (p: any) => `${p.hours} hours before a registered event` },
} as const;
export type Trigger = keyof typeof TRIGGERS;

export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('notify_member'), title: z.string().trim().min(2).max(120), body: z.string().trim().min(2).max(500) }),
  z.object({ type: z.literal('send_message'), channel: z.enum(['whatsapp', 'sms', 'email']), templateKey: z.string().min(1) }),
  z.object({
    type: z.literal('create_follow_up'), purpose: z.enum(['general', 'sales', 'renewal', 'payment', 'reactivation', 'feedback']),
    followUpType: z.enum(['call', 'whatsapp', 'sms', 'email', 'in_person']).default('call'), note: z.string().trim().max(300).optional(),
  }),
  z.object({ type: z.literal('notify_staff'), title: z.string().trim().min(2).max(120), body: z.string().trim().max(500).optional(), priority: z.enum(['normal', 'high']).default('normal') }),
  z.object({ type: z.literal('award_points'), points: z.coerce.number().int().min(1).max(10000), description: z.string().trim().min(2).max(120) }),
]);
export type Action = z.infer<typeof actionSchema>;

interface Candidate { member_id?: string | null; lead_id?: string | null; branch_id: string; assigned_to?: string | null; key: string; vars?: Record<string, string> }

/** Each trigger compiles to one parameterised query returning who it fires for, and a key that makes the firing unique. */
async function candidates(db: Db, rule: any): Promise<Candidate[]> {
  const p = rule.params;
  const org = rule.organization_id;
  switch (rule.trigger as Trigger) {
    case 'membership_expiring':
      return query(
        `SELECT m.id AS member_id, m.branch_id, m.assigned_staff_id AS assigned_to, cm.membership_id || ':' || cm.days_remaining AS key
           FROM members m JOIN member_current_membership cm ON cm.member_id = m.id
          WHERE m.organization_id = $1 AND cm.status IN ('active','expiring_soon') AND NOT cm.has_upcoming AND NOT cm.is_pass AND cm.days_remaining = ANY($2::int[])`,
        [org, p.days], db);
    case 'membership_expired':
      return query(
        `SELECT m.id AS member_id, m.branch_id, m.assigned_staff_id AS assigned_to, cm.membership_id || ':' || (current_date - cm.end_date) AS key
           FROM members m JOIN member_current_membership cm ON cm.member_id = m.id
          WHERE m.organization_id = $1 AND cm.status = 'expired' AND NOT cm.has_upcoming AND NOT cm.is_pass AND (current_date - cm.end_date) = ANY($2::int[])`,
        [org, p.days], db);
    case 'member_inactive':
      // Keyed on the last visit, so a member who returns and lapses again is caught again.
      return query(
        `SELECT m.id AS member_id, m.branch_id, m.assigned_staff_id AS assigned_to,
                'since:' || COALESCE(vs.last_visit_at::date, m.join_date) AS key,
                (current_date - COALESCE(vs.last_visit_at::date, m.join_date))::text AS idle_days
           FROM members m JOIN member_current_membership cm ON cm.member_id = m.id JOIN member_visit_stats vs ON vs.member_id = m.id
          WHERE m.organization_id = $1 AND cm.status IN ('active','expiring_soon') AND NOT cm.is_pass
            AND COALESCE(vs.last_visit_at, m.join_date::timestamptz) < now() - make_interval(days => $2::int)`,
        [org, p.days], db).then((rows) => rows.map((r) => ({ ...r, vars: { idle_days: r.idle_days } })));
    case 'birthday':
      return query(
        `SELECT m.id AS member_id, m.branch_id, m.assigned_staff_id AS assigned_to, 'year:' || extract(year FROM current_date) AS key
           FROM members m JOIN member_current_membership cm ON cm.member_id = m.id
          WHERE m.organization_id = $1 AND cm.status IN ('active','expiring_soon','frozen')
            AND to_char(m.date_of_birth, 'MM-DD') = to_char(current_date, 'MM-DD')`,
        [org], db);
    case 'payment_overdue':
      return query(
        `SELECT i.member_id, i.branch_id, m.assigned_staff_id AS assigned_to, i.id || ':' || (current_date - COALESCE(i.due_date, i.issue_date)) AS key,
                '₹' || to_char(i.total - i.amount_paid, 'FM99,99,99,990') AS amount_due, i.invoice_number
           FROM invoices i JOIN members m ON m.id = i.member_id
          WHERE i.organization_id = $1 AND i.status IN ('pending','partially_paid') AND (current_date - COALESCE(i.due_date, i.issue_date)) = ANY($2::int[])`,
        [org, p.days], db).then((rows) => rows.map((r) => ({ ...r, vars: { amount_due: r.amount_due, invoice_number: r.invoice_number } })));
    case 'member_joined':
      return query(
        `SELECT m.id AS member_id, m.branch_id, m.assigned_staff_id AS assigned_to, 'joined:' || (current_date - m.join_date) AS key
           FROM members m WHERE m.organization_id = $1 AND (current_date - m.join_date) = ANY($2::int[])`,
        [org, p.days], db);
    case 'lead_uncontacted':
      return query(
        `SELECT NULL AS member_id, l.id AS lead_id, l.branch_id, l.assigned_to, 'lead' AS key
           FROM leads l WHERE l.organization_id = $1 AND l.stage = 'new' AND l.last_contacted_at IS NULL
            AND l.created_at < now() - make_interval(hours => $2::int) AND l.created_at > now() - interval '14 days'`,
        [org, p.hours], db);
    case 'event_upcoming':
      return query(
        `SELECT r.member_id, e.branch_id, NULL AS assigned_to, 'event:' || e.id AS key, e.title AS event_title,
                to_char(e.starts_at AT TIME ZONE 'Asia/Kolkata', 'Dy DD Mon, HH12:MI AM') AS event_date
           FROM event_registrations r JOIN events e ON e.id = r.event_id
          WHERE e.organization_id = $1 AND e.status = 'published' AND r.status = 'registered' AND r.member_id IS NOT NULL
            AND e.starts_at > now() AND e.starts_at < now() + make_interval(hours => $2::int)`,
        [org, p.hours], db).then((rows) => rows.map((r) => ({ ...r, vars: { event_title: r.event_title, event_date: r.event_date } })));
  }
}

const dueAt = () => {
  // Follow-ups land at 10am today if that's still ahead, otherwise within the hour.
  const ist = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const ten = new Date(`${ist}T10:00:00+05:30`);
  return ten.getTime() > Date.now() + 15 * 60_000 ? ten : new Date(Date.now() + 60 * 60_000);
};

async function deskStaff(c: Db, branchId: string) {
  return (await one(
    `SELECT sb.user_id FROM staff_branches sb JOIN users u ON u.id = sb.user_id AND u.is_active JOIN roles r ON r.id = u.role_id AND r.key IN ('front_desk','branch_manager')
      WHERE sb.branch_id = $1 ORDER BY r.key = 'front_desk' DESC, u.created_at LIMIT 1`,
    [branchId], c))?.user_id ?? null;
}

async function runAction(c: PoolClient, rule: any, cand: Candidate, a: Action, vars: Record<string, string>, subjectRow: any) {
  const orgId = rule.organization_id;
  const name = subjectRow.full_name;
  switch (a.type) {
    case 'notify_member': {
      if (!cand.member_id) return { type: a.type, skipped: 'Leads have no app' };
      if (rule.promotional && subjectRow.marketing_opt_out) return { type: a.type, skipped: 'Opted out' };
      const r = await enqueueMessage(c, { orgId, memberId: cand.member_id, channel: 'push', subject: render(a.title, vars), body: render(a.body, vars), rendered: true, ruleId: rule.id, promotional: rule.promotional });
      return { type: a.type, status: r.status, reason: r.reason };
    }
    case 'send_message': {
      const tpl = await one(`SELECT subject, body FROM message_templates WHERE organization_id = $1 AND key = $2 AND is_active`, [orgId, a.templateKey], c);
      if (!tpl) return { type: a.type, skipped: `Template ${a.templateKey} missing or inactive` };
      const r = await enqueueMessage(c, {
        orgId, memberId: cand.member_id, leadId: cand.lead_id, channel: a.channel, templateKey: a.templateKey,
        subject: tpl.subject ? render(tpl.subject, vars) : null, body: render(tpl.body, vars), rendered: true, ruleId: rule.id, promotional: rule.promotional,
      });
      return { type: a.type, channel: a.channel, status: r.status, reason: r.reason };
    }
    case 'create_follow_up': {
      const open = await one(
        `SELECT id FROM follow_ups WHERE status = 'pending' AND purpose = $3 AND (member_id = $1 OR lead_id = $2) LIMIT 1`,
        [cand.member_id ?? null, cand.lead_id ?? null, a.purpose], c);
      if (open) return { type: a.type, skipped: 'Already has an open follow-up' };
      const assignee = cand.assigned_to ?? (await deskStaff(c, cand.branch_id));
      const f = await one(
        `INSERT INTO follow_ups (organization_id, branch_id, member_id, lead_id, type, purpose, due_at, assigned_to, notes, auto_generated)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true) RETURNING id`,
        [orgId, cand.branch_id, cand.member_id ?? null, cand.lead_id ?? null, a.followUpType, a.purpose, dueAt(), assignee, render(a.note ?? rule.name, vars)], c);
      return { type: a.type, followUpId: f!.id };
    }
    case 'notify_staff': {
      await notify(c, {
        orgId, branchId: cand.branch_id, recipientId: cand.assigned_to ?? null, type: `automation.${rule.trigger}`, priority: a.priority,
        title: render(a.title, vars), body: a.body ? render(a.body, vars) : name,
        entityType: cand.member_id ? 'member' : 'lead', entityId: (cand.member_id ?? cand.lead_id)!,
      });
      return { type: a.type, status: 'sent' };
    }
    case 'award_points': {
      if (!cand.member_id) return { type: a.type, skipped: 'Leads have no points' };
      const t = await postPoints(c, { orgId, memberId: cand.member_id, branchId: cand.branch_id, reason: 'manual', points: a.points, sourceKey: `rule:${rule.id}:${cand.key}`, description: render(a.description, vars) });
      return { type: a.type, points: t ? a.points : 0 };
    }
  }
}

/** Runs one rule: fires once per new occurrence; each firing is its own transaction. */
export async function runRule(rule: any, opts: { dryRun?: boolean } = {}) {
  const list = (await candidates(pool, rule)).slice(0, 500);
  if (opts.dryRun) {
    const fresh = list.length
      ? await query(`SELECT occurrence_key FROM automation_runs WHERE rule_id = $1 AND occurrence_key = ANY($2)`, [rule.id, list.map((c) => `${c.member_id ?? c.lead_id}:${c.key}`)])
      : [];
    const done = new Set(fresh.map((f) => f.occurrence_key));
    return { matched: list.length, pending: list.filter((c) => !done.has(`${c.member_id ?? c.lead_id}:${c.key}`)).length };
  }
  let fired = 0;
  for (const cand of list) {
    const key = `${cand.member_id ?? cand.lead_id}:${cand.key}`;
    await tx(async (c) => {
      const run = await one(
        `INSERT INTO automation_runs (rule_id, organization_id, branch_id, member_id, lead_id, occurrence_key) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (rule_id, occurrence_key) DO NOTHING RETURNING id`,
        [rule.id, rule.organization_id, cand.branch_id, cand.member_id ?? null, cand.lead_id ?? null, key], c);
      if (!run) return;
      const subj = await subjectVars(c, { memberId: cand.member_id, leadId: cand.lead_id }, cand.vars ?? {});
      if (!subj) return;
      const results = [];
      for (const a of rule.actions as Action[]) results.push(await runAction(c, rule, cand, a, subj.vars, subj.row));
      await c.query(`UPDATE automation_runs SET results = $2 WHERE id = $1`, [run.id, JSON.stringify(results)]);
      fired++;
    });
  }
  await pool.query(`UPDATE automation_rules SET last_run_at = now() WHERE id = $1`, [rule.id]);
  return { matched: list.length, fired };
}

export async function runAutomations() {
  const orgs = await query(`SELECT id FROM organizations`);
  for (const o of orgs) await ensureDefaultRules(pool, o.id);
  const rules = await query(`SELECT * FROM automation_rules WHERE enabled ORDER BY created_at`);
  for (const r of rules) {
    try {
      await runRule(r);
    } catch (err) {
      console.error(`automation ${r.key} failed`, err);
    }
  }
}

// ------------------------------------------------------------- default rules --

export const DEFAULT_RULES: { key: string; name: string; description: string; trigger: Trigger; params: any; actions: Action[]; promotional?: boolean; enabled?: boolean }[] = [
  {
    key: 'renewal_reminders', name: 'Renewal reminders', description: 'Remind members in the app as their membership end date approaches.',
    trigger: 'membership_expiring', params: { days: [30, 15, 7, 3, 1, 0] },
    actions: [{ type: 'notify_member', title: 'Your membership ends {{expiry_date}}', body: '{{days_left}} days left on {{plan}}. Renew at the front desk to keep training without a break.' }],
  },
  {
    key: 'renewal_call', name: 'Renewal call', description: 'A week before expiry, put a renewal call on the assigned staff member’s list.',
    trigger: 'membership_expiring', params: { days: [7] },
    actions: [{ type: 'create_follow_up', purpose: 'renewal', followUpType: 'call', note: '{{plan}} expires {{expiry_date}}' }],
  },
  {
    key: 'renewal_whatsapp', name: 'Renewal WhatsApp', description: 'Send the renewal reminder template on WhatsApp 3 days before expiry.',
    trigger: 'membership_expiring', params: { days: [3] }, enabled: false,
    actions: [{ type: 'send_message', channel: 'whatsapp', templateKey: 'renewal_reminder' }],
  },
  {
    key: 'lapsed_call', name: 'Lapsed member call', description: 'The day after a membership lapses without renewal, call to win them back.',
    trigger: 'membership_expired', params: { days: [1] },
    actions: [{ type: 'create_follow_up', purpose: 'renewal', followUpType: 'call', note: '{{plan}} ended {{expiry_date}} — not renewed' }],
  },
  {
    key: 'win_back', name: 'Win back inactive members', description: 'Active members who stop coming get a reactivation call and an app nudge.',
    trigger: 'member_inactive', params: { days: 14 },
    actions: [
      { type: 'create_follow_up', purpose: 'reactivation', followUpType: 'call', note: 'No visit in {{idle_days}} days' },
      { type: 'notify_member', title: 'We miss you, {{first_name}}', body: 'It’s been {{idle_days}} days. Book a class or drop in — your coach is ready when you are.' },
    ],
  },
  {
    key: 'birthday', name: 'Birthday wishes', description: 'Wish members on their birthday with bonus points and a WhatsApp message.',
    trigger: 'birthday', params: {}, promotional: true,
    actions: [
      { type: 'notify_member', title: 'Happy birthday, {{first_name}}! 🎂', body: 'Here are 100 bonus points from everyone at {{gym}}.' },
      { type: 'award_points', points: 100, description: 'Birthday bonus' },
      { type: 'send_message', channel: 'whatsapp', templateKey: 'birthday' },
    ],
  },
  {
    key: 'payment_overdue', name: 'Overdue payment chase', description: 'Remind members with unpaid invoices and queue a call for the desk.',
    trigger: 'payment_overdue', params: { days: [3, 10] },
    actions: [
      { type: 'notify_member', title: 'Balance of {{amount_due}} pending', body: 'Invoice {{invoice_number}} is unpaid. You can clear it at the front desk by cash, UPI or card.' },
      { type: 'create_follow_up', purpose: 'payment', followUpType: 'call', note: '{{amount_due}} due on {{invoice_number}}' },
    ],
  },
  {
    key: 'welcome', name: 'Welcome new members', description: 'Welcome message on joining and a first-week check-in call.',
    trigger: 'member_joined', params: { days: [0] },
    actions: [{ type: 'send_message', channel: 'whatsapp', templateKey: 'welcome' }, { type: 'notify_member', title: 'Welcome to {{gym}}!', body: 'Your member ID is {{member_code}}. Your plan, payments and classes are all here in the app.' }],
  },
  {
    key: 'first_week_check_in', name: 'First-week check-in', description: 'Seven days in, ask how the first week went.',
    trigger: 'member_joined', params: { days: [7] },
    actions: [{ type: 'create_follow_up', purpose: 'feedback', followUpType: 'call', note: 'First-week check-in' }],
  },
  {
    key: 'lead_speed', name: 'Lead waiting for contact', description: 'Alert the assigned salesperson when a new lead has had no contact for a day.',
    trigger: 'lead_uncontacted', params: { hours: 24 },
    actions: [{ type: 'notify_staff', title: '{{full_name}} hasn’t been contacted', body: 'New lead waiting over 24 hours — leads go cold fast.', priority: 'high' }],
  },
  {
    key: 'event_reminder', name: 'Event reminder', description: 'Remind registered members the day before an event.',
    trigger: 'event_upcoming', params: { hours: 24 },
    actions: [{ type: 'notify_member', title: '{{event_title}} is tomorrow', body: '{{event_date}} at {{branch}}. See you there!' }],
  },
];

export async function ensureDefaultRules(db: Db, orgId: string) {
  for (const r of DEFAULT_RULES) {
    await db.query(
      `INSERT INTO automation_rules (organization_id, key, name, description, trigger, params, actions, promotional, enabled, is_system)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true) ON CONFLICT (organization_id, key) DO NOTHING`,
      [orgId, r.key, r.name, r.description, r.trigger, JSON.stringify(r.params), JSON.stringify(r.actions), !!r.promotional, r.enabled ?? true],
    );
  }
}
