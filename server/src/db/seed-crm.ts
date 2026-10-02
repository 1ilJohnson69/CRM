import { one, tx } from './pool.js';
import { addToDate, today } from '../lib/http.js';

// Separate PRNG stream so Phase 2 data is deterministic and independent of core seed.
let s = 20262002;
const rand = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
const weighted = <T,>(xs: readonly [T, number][]) => {
  let r = rand() * xs.reduce((a, [, w]) => a + w, 0);
  for (const [x, w] of xs) if ((r -= w) <= 0) return x;
  return xs[0][0];
};

const FIRST = ['Aarav', 'Ritika', 'Mohit', 'Sana', 'Kiran', 'Farhan', 'Gauri', 'Tarun', 'Pallavi', 'Dhruv', 'Megha', 'Arnav', 'Simran', 'Neel', 'Rhea', 'Omkar', 'Jhanvi', 'Yuvraj', 'Kritika', 'Sahil', 'Bhavya', 'Lakshay', 'Nupur', 'Rohit', 'Tara', 'Vivek', 'Ishita', 'Aman', 'Prachi', 'Harshit'];
const LAST = ['Agarwal', 'Bose', 'Chauhan', 'Desai', 'Fernandes', 'Ghosh', 'Hussain', 'Iyengar', 'Jain', 'Kamath', 'Lobo', 'Mishra', 'Narayan', 'Oberoi', 'Prasad', 'Qureshi', 'Rangan', 'Saxena', 'Thakur', 'Upadhyay', 'Vaidya', 'Wadhwa', 'Yadav', 'Zaveri'];
const GOALS = ['Fat loss', 'Muscle gain', 'General fitness', 'Strength', 'Marathon prep', 'Post-injury rehab', 'Flexibility & mobility', 'Wedding prep'];
const LOST_REASONS = ['Too expensive', 'Joined another gym', 'Location not convenient', 'Not ready yet', 'No response after 5 attempts', 'Timing doesn’t suit'];
const SOURCE_MAP: Record<string, string> = { Instagram: 'Instagram', Referral: 'Referral', Website: 'Website', Google: 'Google', 'Corporate tie-up': 'Campaign' };

const TEMPLATES: [string, string, string, string, string | null, string][] = [
  ['lead_intro', 'Lead · first reply', 'whatsapp', 'lead', null, 'Hi {{first_name}}! This is the team at {{gym}} {{branch}} 👋 Thanks for your interest. When would you like to drop by for a free trial session? You can also call us on {{branch_phone}}.'],
  ['trial_invite', 'Lead · trial confirmation', 'whatsapp', 'lead', null, 'Hi {{first_name}}, your free trial at {{gym}} {{branch}} is booked for {{trial_date}}. Bring a water bottle and comfortable shoes. See you there!'],
  ['lead_follow_up', 'Lead · follow-up', 'whatsapp', 'lead', null, 'Hi {{first_name}}, just checking in from {{gym}}. Happy to answer any questions about the {{plan}} plan — reply here or call {{branch_phone}}.'],
  ['welcome', 'Member · welcome', 'whatsapp', 'member', null, 'Welcome to {{gym}}, {{first_name}}! Your member ID is {{member_code}}. Your {{plan}} membership is active until {{expiry_date}}. Download the Forge app to see your plan and payments.'],
  ['payment_confirmation', 'Member · payment received', 'any', 'member', 'Payment received — {{gym}}', 'Hi {{first_name}}, we’ve received your payment. Your {{plan}} membership is valid until {{expiry_date}}. Thank you!'],
  ['renewal_reminder', 'Member · renewal reminder', 'whatsapp', 'member', null, 'Hi {{first_name}}, your {{plan}} membership at {{gym}} expires on {{expiry_date}} ({{days_left}} days left). Renew at the front desk to keep training without a break 💪'],
  ['membership_expired', 'Member · expired, win-back', 'whatsapp', 'member', null, 'Hi {{first_name}}, we miss you at {{gym}} {{branch}}! Your {{plan}} membership ended on {{expiry_date}}. Come back this week and we’ll help you pick up where you left off.'],
  ['payment_due', 'Member · payment due', 'any', 'member', 'Balance due — {{gym}}', 'Hi {{first_name}}, a balance of {{amount_due}} is pending on your account. You can clear it at the front desk by cash, UPI or card.'],
  ['birthday', 'Member · birthday', 'whatsapp', 'member', null, 'Happy birthday, {{first_name}}! 🎉 Everyone at {{gym}} wishes you a strong year ahead.'],
  ['general_follow_up', 'General follow-up', 'any', 'any', 'Following up — {{gym}}', 'Hi {{first_name}}, this is {{gym}} {{branch}} following up. Let us know a good time to talk.'],
];

const SEGMENTS: [string, string, Record<string, unknown>][] = [
  ['Expiring in 7 days', 'Active members whose plan ends this week with no renewal booked', { expiresWithinDays: 7 }],
  ['Expired · last 30 days', 'Recently lapsed — the best win-back window', { expiredWithinDays: 30 }],
  ['Win-back · not contacted', 'Expired within 90 days and nobody has reached out in 30 days', { expiredWithinDays: 90, noContactDays: 30 }],
  ['High value · ₹50K+', 'Lifetime value of ₹50,000 or more', { lifetimeValueMin: 50000 }],
  ['Outstanding dues', 'Members with an unpaid balance', { hasOutstanding: true }],
  ['Personal training', 'Bought PT in the last year or on a PT plan', { hasPersonalTraining: true }],
  ['New members · 30 days', 'Joined in the last 30 days', { joinedWithinDays: 30 }],
  ['Referrers', 'Members who referred someone who joined', { referredSomeone: true }],
  ['Birthdays this month', 'For birthday wishes and offers', { birthdayThisMonth: true }],
];

const STAGES = ['new', 'contacted', 'interested', 'trial_booked', 'trial_completed', 'negotiation'] as const;

/** Idempotent: does nothing if leads already exist. */
export async function seedCrm() {
  const has = await one(`SELECT count(*)::int AS n FROM leads`);
  if (has!.n > 0) return;
  const org = await one(`SELECT id FROM organizations ORDER BY created_at LIMIT 1`);
  if (!org) return;

  await tx(async (c) => {
    const q = (text: string, params: unknown[] = []) => c.query(text, params).then((r) => r.rows);
    const now = today();
    const ts = (date: string, hourMin = 9, hourMax = 20) => {
      if (date >= now) return new Date(Date.now() - Math.floor(rand() * 4 * 3600_000)).toISOString();
      return `${date}T${String(hourMin + Math.floor(rand() * (hourMax - hourMin))).padStart(2, '0')}:${String(Math.floor(rand() * 60)).padStart(2, '0')}:00+05:30`;
    };

    const sources: Record<string, string> = {};
    let i = 0;
    for (const name of ['Walk-in', 'Instagram', 'Website', 'Google', 'Referral', 'WhatsApp', 'Phone', 'Facebook', 'Campaign', 'Existing member', 'Other']) {
      const [r] = await q(`INSERT INTO lead_sources (organization_id, name, sort) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id`, [org.id, name, i++]);
      sources[name] = r?.id ?? (await q(`SELECT id FROM lead_sources WHERE organization_id = $1 AND name = $2`, [org.id, name]))[0].id;
    }
    for (const [key, name, channel, audience, subject, body] of TEMPLATES) {
      await q(`INSERT INTO message_templates (organization_id, key, name, channel, audience, subject, body) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`, [org.id, key, name, channel, audience, subject, body]);
    }
    for (const [name, description, rules] of SEGMENTS) {
      await q(`INSERT INTO segments (organization_id, name, description, rules, is_system) VALUES ($1,$2,$3,$4,true) ON CONFLICT DO NOTHING`, [org.id, name, description, JSON.stringify(rules)]);
    }

    const branches = await q(`SELECT id, name FROM branches WHERE organization_id = $1 ORDER BY name`, [org.id]);
    const sellers = await q(
      `SELECT u.id, r.key, COALESCE(array_agg(sb.branch_id) FILTER (WHERE sb.branch_id IS NOT NULL), '{}') AS branches
         FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN staff_branches sb ON sb.user_id = u.id
        WHERE u.organization_id = $1 AND r.key IN ('sales', 'front_desk', 'branch_manager') GROUP BY u.id, r.key`,
      [org.id],
    );
    const sellerFor = (branchId: string) => {
      const sales = sellers.filter((x: any) => x.branches.includes(branchId) && x.key === 'sales');
      return pick(sales.length && rand() < 0.7 ? sales : sellers.filter((x: any) => x.branches.includes(branchId)));
    };
    const plans = await q(`SELECT id, name, price FROM membership_plans WHERE organization_id = $1 AND duration_unit = 'month'`, [org.id]);

    async function addHistory(leadId: string, path: string[], start: string, end: string, by: string) {
      const span = Math.max(1, (Date.parse(end) - Date.parse(start)) / 86400000);
      for (let k = 0; k < path.length; k++) {
        const day = addToDate(start, 'day', Math.round((span * k) / Math.max(1, path.length - 1)));
        await q(`INSERT INTO lead_stage_history (lead_id, from_stage, to_stage, changed_by, changed_at) VALUES ($1,$2,$3,$4,$5)`,
          [leadId, k ? path[k - 1] : null, path[k], by, ts(day)]);
      }
    }
    async function comm(target: { leadId?: string; memberId?: string }, branchId: string, by: string, date: string, channel: string, body: string, outcome: string | null, template: string | null = null) {
      await q(
        `INSERT INTO communication_logs (organization_id, branch_id, lead_id, member_id, channel, direction, template_key, body, outcome, logged_by, created_at)
         VALUES ($1,$2,$3,$4,$5,'outbound',$6,$7,$8,$9,$10)`,
        [org.id, branchId, target.leadId ?? null, target.memberId ?? null, channel, template, body, outcome, by, ts(date)],
      );
    }

    // 1. Historical won leads, linked to members who actually joined through a channel.
    const joined = await q(
      `SELECT m.id, m.branch_id, m.join_date, m.source, m.gender, u.full_name, u.phone, u.email, m.assigned_staff_id,
              (SELECT ms.plan_id FROM memberships ms WHERE ms.member_id = m.id ORDER BY ms.start_date LIMIT 1) AS plan_id
         FROM members m JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = $1 AND m.source <> 'Walk-in' AND m.join_date >= current_date - 330`,
      [org.id],
    );
    const allMembers = await q(`SELECT id, join_date FROM members WHERE organization_id = $1`, [org.id]);
    let won = 0;
    for (const m of joined) {
      if (rand() > 0.75) continue;
      const created = addToDate(m.join_date, 'day', -Math.floor(2 + rand() * 18));
      const source = SOURCE_MAP[m.source] ?? 'Other';
      const referrer = source === 'Referral' ? allMembers.filter((x: any) => x.join_date < created) : [];
      const by = m.assigned_staff_id ?? sellerFor(m.branch_id).id;
      const path = weighted([[['new', 'contacted', 'interested', 'won'], 4], [['new', 'contacted', 'trial_booked', 'trial_completed', 'won'], 4], [['new', 'contacted', 'interested', 'negotiation', 'won'], 2]] as const);
      const [l] = await q(
        `INSERT INTO leads (organization_id, branch_id, full_name, phone, email, gender, source_id, referred_by_member_id, interested_plan_id, goal,
                            stage, assigned_to, converted_member_id, converted_at, last_contacted_at, created_by, created_at, stage_changed_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'won',$11,$12,$13,$13,$11,$14,$13,$13) RETURNING id`,
        [org.id, m.branch_id, m.full_name, m.phone, m.email, m.gender, sources[source], referrer.length ? pick(referrer).id : null, m.plan_id,
          pick(GOALS), by, m.id, ts(m.join_date), ts(created)],
      );
      await addHistory(l.id, [...path], created, m.join_date, by);
      await comm({ leadId: l.id }, m.branch_id, by, addToDate(created, 'day', 1), 'call', 'Intro call — shared plans and pricing', 'connected');
      await comm({ leadId: l.id }, m.branch_id, by, addToDate(created, 'day', 1), 'whatsapp', 'Sent trial invite', null, 'lead_intro');
      won++;
    }

    // 2. Lost leads over the last four months.
    for (let k = 0; k < 70; k++) {
      const b = pick(branches);
      const created = addToDate(now, 'day', -Math.floor(10 + rand() * 110));
      const closed = addToDate(created, 'day', Math.floor(3 + rand() * 20));
      const by = sellerFor(b.id).id;
      const name = `${pick(FIRST)} ${pick(LAST)}`;
      const plan = pick(plans);
      const reachedTo = weighted([[1, 3], [2, 3], [3, 2], [5, 2]] as const);
      const [l] = await q(
        `INSERT INTO leads (organization_id, branch_id, full_name, phone, source_id, interested_plan_id, goal, stage, lost_reason,
                            assigned_to, created_by, created_at, stage_changed_at, updated_at, last_contacted_at, position)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'lost',$8,$9,$9,$10,$11,$11,$11,$12) RETURNING id`,
        [org.id, b.id, name, `+91${8000000000 + Math.floor(rand() * 999999999)}`, sources[pick(['Instagram', 'Website', 'Google', 'Facebook', 'Phone', 'Walk-in', 'WhatsApp'])],
          plan.id, pick(GOALS), pick(LOST_REASONS), by, ts(created), ts(closed), k],
      );
      await addHistory(l.id, [...STAGES.slice(0, reachedTo), 'lost'], created, closed, by);
      await comm({ leadId: l.id }, b.id, by, addToDate(created, 'day', 1), 'call', 'Discussed membership options', weighted([['connected', 2], ['no_answer', 1]] as const));
    }

    // 3. The live pipeline: open leads from the last ~6 weeks.
    const stageWeights: [typeof STAGES[number], number][] = [['new', 18], ['contacted', 22], ['interested', 16], ['trial_booked', 10], ['trial_completed', 8], ['negotiation', 8]];
    const position: Record<string, number> = {};
    for (let k = 0; k < 96; k++) {
      const b = weighted([[branches[0], 4], [branches[1], 4], [branches[2], 3]] as const);
      const stage = weighted(stageWeights);
      const ageDays = stage === 'new' ? Math.floor(rand() * 4) : Math.floor(2 + rand() * 40);
      const created = addToDate(now, 'day', -ageDays);
      const by = sellerFor(b.id).id;
      const name = `${pick(FIRST)} ${pick(LAST)}`;
      const plan = pick(plans);
      const sourceName = weighted([['Instagram', 6], ['Website', 4], ['Google', 4], ['Walk-in', 3], ['Referral', 3], ['WhatsApp', 2], ['Facebook', 2], ['Phone', 1]] as const);
      const referrer = sourceName === 'Referral' ? pick(allMembers).id : null;
      const trialAt = stage === 'trial_booked' ? `${addToDate(now, 'day', Math.floor(rand() * 5))}T${String(7 + Math.floor(rand() * 11)).padStart(2, '0')}:00:00+05:30`
        : stage === 'trial_completed' ? ts(addToDate(now, 'day', -Math.floor(1 + rand() * 6))) : null;
      const key = `${b.id}:${stage}`;
      position[key] = (position[key] ?? 0) + 1;
      const contacted = stage !== 'new';
      const [l] = await q(
        `INSERT INTO leads (organization_id, branch_id, full_name, phone, email, gender, source_id, referred_by_member_id, interested_plan_id, interested_service,
                            budget, goal, stage, position, expected_value, trial_at, assigned_to, last_contacted_at, created_by, created_at, stage_changed_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$17,$19,$20,$20) RETURNING id`,
        [org.id, b.id, name, `+91${7000000000 + Math.floor(rand() * 999999999)}`, rand() < 0.6 ? `${name.toLowerCase().replace(' ', '.')}${k}@example.com` : null,
          rand() < 0.5 ? 'female' : 'male', sources[sourceName], referrer, plan.id, rand() < 0.25 ? 'Personal training' : 'Gym membership',
          rand() < 0.5 ? Math.round(plan.price * (0.8 + rand() * 0.5) / 500) * 500 : null, pick(GOALS), stage, position[key],
          stage === 'negotiation' && rand() < 0.5 ? Math.round(plan.price * 0.9) : null, trialAt, by,
          contacted ? ts(addToDate(created, 'day', Math.min(ageDays, 1))) : null, ts(created), ts(addToDate(created, 'day', Math.floor(ageDays / 2)))],
      );
      const path = STAGES.slice(0, STAGES.indexOf(stage) + 1).filter((st) => !st.startsWith('trial') || stage.startsWith('trial'));
      await addHistory(l.id, path, created, addToDate(created, 'day', Math.floor(ageDays / 2)), by);
      if (contacted) {
        await comm({ leadId: l.id }, b.id, by, addToDate(created, 'day', 0), 'whatsapp', 'Sent intro and trial invite', null, 'lead_intro');
        await comm({ leadId: l.id }, b.id, by, addToDate(created, 'day', 1), 'call', pick(['Interested in morning batch', 'Asked about couple discount', 'Comparing with a gym near office', 'Wants to start next month']), weighted([['connected', 3], ['interested', 2], ['no_answer', 1], ['callback', 1]] as const));
      }
      // Next action: a realistic mix of overdue, today and upcoming.
      const when = weighted([['overdue', 3], ['today', 4], ['upcoming', 5]] as const);
      const due = when === 'overdue' ? new Date(Date.now() - (1 + rand() * 72) * 3600_000)
        : when === 'today' ? new Date(new Date().setHours(10 + Math.floor(rand() * 9), 0, 0, 0))
          : new Date(Date.now() + (1 + Math.floor(rand() * 6)) * 86400_000);
      await q(
        `INSERT INTO follow_ups (organization_id, branch_id, lead_id, type, purpose, due_at, assigned_to, notes, created_by, created_at, auto_generated)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$7,$9,$10)`,
        [org.id, b.id, l.id, weighted([['call', 5], ['whatsapp', 3], ['in_person', 1]] as const), stage.startsWith('trial') ? 'trial' : 'sales', due.toISOString(), by,
          stage === 'new' ? 'First contact' : stage === 'negotiation' ? 'Share final offer' : stage === 'trial_completed' ? 'Ask how the trial went' : 'Check in on decision',
          ts(created), stage === 'new'],
      );
    }

    // 4. Member-side communication and completed renewal follow-ups.
    const recentMembers = await q(
      `SELECT m.id, m.branch_id, m.assigned_staff_id, cm.status FROM members m JOIN member_current_membership cm ON cm.member_id = m.id
        WHERE m.organization_id = $1 AND cm.end_date BETWEEN current_date - 40 AND current_date + 20 ORDER BY m.member_code`,
      [org.id],
    );
    for (const m of recentMembers) {
      if (rand() < 0.35) continue;
      const by = m.assigned_staff_id ?? sellerFor(m.branch_id).id;
      const day = addToDate(now, 'day', -Math.floor(1 + rand() * 25));
      const channel = weighted([['whatsapp', 3], ['call', 2], ['sms', 1]] as const);
      const template = m.status === 'expired' ? 'membership_expired' : 'renewal_reminder';
      await comm({ memberId: m.id }, m.branch_id, by, day, channel, channel === 'call' ? 'Renewal call' : 'Renewal reminder sent', channel === 'call' ? pick(['connected', 'no_answer', 'callback']) : null, channel === 'call' ? null : template);
      if (channel === 'call') {
        await q(
          `INSERT INTO follow_ups (organization_id, branch_id, member_id, type, purpose, due_at, assigned_to, status, outcome, outcome_notes, completed_at, completed_by, created_by, created_at, auto_generated)
           VALUES ($1,$2,$3,'call','renewal',$4,$5,'done',$6,$7,$4,$5,$5,$4,true)`,
          [org.id, m.branch_id, m.id, ts(day), by, pick(['connected', 'callback', 'no_answer']), pick(['Will renew on visit', 'Asked to call next week', 'Considering quarterly instead'])],
        );
      }
    }
    console.log(`Seeded CRM: ${won} converted leads, 70 lost, 96 open, templates and segments.`);
  });
}
