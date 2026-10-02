import { one, tx } from './pool.js';
import { addToDate, round2, today } from '../lib/http.js';
import { ensureDefaultRules } from '../modules/automation/engine.js';
import { resolveAudience } from '../modules/marketing/campaigns.js';
import { render, subjectVars } from '../modules/messaging/service.js';

let s = 20266006;
const rand = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
const shuffle = <T,>(xs: T[]) => [...xs].sort(() => rand() - 0.5);

const TEMPLATES = [
  ['event_invite', 'Event invitation', 'whatsapp', 'member', null, 'Hi {{first_name}}! {{gym}} {{branch}} is hosting {{event_title}} on {{event_date}}. Spots are limited — register in the Forge app or at the front desk.'],
  ['promo_offer', 'Promotional offer', 'any', 'any', 'An offer for you — {{gym}}', 'Hi {{first_name}}, use code {{offer_code}} at {{gym}} {{branch}} before {{offer_valid_until}} for a special price on your next plan.'],
  ['class_reminder', 'Class reminder', 'any', 'member', null, 'Hi {{first_name}}, reminder: your class at {{gym}} {{branch}} is coming up. Cancel in the app if you can’t make it.'],
  ['appointment_reminder', 'Appointment reminder', 'any', 'member', null, 'Hi {{first_name}}, a reminder about your appointment at {{gym}} {{branch}}. Call {{branch_phone}} to reschedule.'],
] as const;

// title, type, description, days from today, hour, hours long, capacity, price, member price, points, guests
const EVENTS: [string, string, string, number, number, number, number | null, number, number | null, number, boolean][] = [
  ['Deadlift Technique Workshop', 'workshop', 'Hinge mechanics, bracing and setup with our head coach. Bring a notebook.', -52, 10, 2, 20, 499, 299, 50, true],
  ['Forge Anniversary 5K', 'special', 'A community run around the neighbourhood, followed by breakfast at the gym.', -40, 6, 3, 150, 0, null, 150, true],
  ['Nutrition 101 Seminar', 'seminar', 'Protein, carbs and portion sizes for Indian diets — with Q&A.', -24, 18, 1.5, 40, 0, null, 50, true],
  ['Summer Shred Challenge · finale', 'challenge', 'Weigh-ins, before/afters and prizes for the 6-week challenge.', -9, 18, 2, 60, 999, 699, 300, false],
  ['Mobility Masterclass', 'workshop', 'Hips, thoracic spine and shoulders — fix the stiffness that holds back your lifts.', 3, 8, 2, 15, 399, 249, 50, true],
  ['Navratri Dance Fitness Night', 'special', 'Garba-inspired cardio party. Wear something bright!', 6, 19, 2, 60, 0, null, 100, true],
  ['Strongest Member Competition', 'competition', 'Squat, bench and deadlift totals by weight class. Judges, medals and bragging rights.', 12, 9, 5, 40, 499, 299, 200, false],
  ['Women’s Strength Seminar', 'seminar', 'Training through life stages, with a Q&A on cycles, pregnancy and menopause.', 18, 11, 1.5, 30, 0, null, 50, true],
];
const GUESTS = ['Ravi Shankar', 'Anjali Desai', 'Mohammed Irfan', 'Shalini Rao', 'Gautam Bhat', 'Neelam Joshi', 'Karthik S', 'Fatima Sheikh'];

export async function seedAdvanced() {
  const has = await one(`SELECT count(*)::int AS n FROM events`);
  if (has!.n > 0) return;
  const org = await one(`SELECT id, name FROM organizations ORDER BY created_at LIMIT 1`);
  if (!org) return;

  await tx(async (c) => {
    const q = (text: string, params: unknown[] = []) => c.query(text, params).then((r) => r.rows);
    const now = today();
    await ensureDefaultRules(c, org.id);
    for (const [key, name, channel, audience, subject, body] of TEMPLATES) {
      await q(`INSERT INTO message_templates (organization_id, key, name, channel, audience, subject, body) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`, [org.id, key, name, channel, audience, subject, body]);
    }
    const counters: Record<string, number> = Object.fromEntries((await q(`SELECT key, value FROM counters WHERE organization_id = $1`, [org.id])).map((r: any) => [r.key, Number(r.value)]));
    const docNo = (prefix: string, key: string, date: string) => {
      const k = `${key}:${date.slice(0, 4)}`;
      counters[k] = (counters[k] ?? 0) + 1;
      return `${prefix}-${date.slice(0, 4)}-${String(counters[k]).padStart(5, '0')}`;
    };
    const branches = await q(`SELECT id, code, name FROM branches WHERE organization_id = $1 ORDER BY name`, [org.id]);
    const admin = (await q(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.key = 'super_admin' AND u.organization_id = $1 LIMIT 1`, [org.id]))[0];
    const trainers = await q(`SELECT u.id, sb.branch_id FROM users u JOIN roles r ON r.id = u.role_id JOIN staff_branches sb ON sb.user_id = u.id WHERE r.key = 'trainer'`);

    // ------------------------------------------------------------------ events --
    let regCount = 0;
    for (const [i, [title, type, description, offset, hour, hours, cap, price, memberPrice, points, guests]] of EVENTS.entries()) {
      const b = branches[i % branches.length];
      const date = addToDate(now, 'day', offset);
      const startsAt = new Date(`${date}T${String(hour).padStart(2, '0')}:00:00+05:30`);
      const endsAt = new Date(startsAt.getTime() + hours * 3600_000);
      const past = offset < 0;
      const draft = title.startsWith('Women');
      const host = pick(trainers.filter((t: any) => t.branch_id === b.id).concat([{ id: admin.id }]));
      const [e] = await q(
        `INSERT INTO events (organization_id, branch_id, title, type, description, starts_at, ends_at, location, capacity, price, member_price, allow_guests, attendance_points, host_id, status, created_by, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
        [org.id, b.id, title, type, description, startsAt, endsAt, type === 'special' && title.includes('5K') ? 'Start: gym entrance' : pick(['Main floor', 'Studio 1', 'Lifting platform area']),
          cap, price, memberPrice, guests, points, host.id, draft ? 'draft' : past ? 'completed' : 'published', admin.id, addToDate(date, 'day', -21)],
      );
      if (draft) continue;
      const pool = shuffle(await q(
        `SELECT m.id, m.user_id FROM members m JOIN member_current_membership cm ON cm.member_id = m.id WHERE m.branch_id = $1 AND cm.status IN ('active','expiring_soon')`, [b.id]));
      const fill = cap ? Math.min(pool.length, Math.round(cap * (past ? 0.6 + rand() * 0.35 : title.startsWith('Mobility') ? 1 : 0.3 + rand() * 0.4))) : 20;
      const people: { memberId: string | null; guest: string | null }[] = pool.slice(0, fill).map((m: any) => ({ memberId: m.id, guest: null }));
      if (guests) for (const g of GUESTS.slice(0, 2 + Math.floor(rand() * 3))) if (!cap || people.length < cap) people.push({ memberId: null, guest: g });
      const waitlist = title.startsWith('Mobility') ? pool.slice(fill, fill + 3).map((m: any) => ({ memberId: m.id, guest: null })) : [];
      for (const [k, p] of [...people.map((x) => [x, false] as const), ...waitlist.map((x) => [x, true] as const)].map((x, j) => [j, x] as const)) {
        const [person, waitlisted] = p;
        const daysBefore = Math.max(1, Math.round((20 - (k % 18)) * (past ? 1 : 0.5)));
        const regDay = addToDate(date, 'day', -daysBefore);
        const regAt = new Date(`${regDay}T${String(8 + Math.floor(rand() * 13)).padStart(2, '0')}:${String(Math.floor(rand() * 60)).padStart(2, '0')}:00+05:30`);
        const status = waitlisted ? 'waitlisted' : past ? (rand() < 0.82 ? 'attended' : 'no_show') : 'registered';
        const [reg] = await q(
          `INSERT INTO event_registrations (organization_id, event_id, member_id, guest_name, guest_phone, status, source, registered_by, created_at, attended_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [org.id, e.id, person.memberId, person.guest, person.guest ? `+9198${Math.floor(10000000 + rand() * 89999999)}` : null, status,
            person.memberId && rand() < 0.55 ? 'app' : 'crm', admin.id, regAt, status === 'attended' ? startsAt : null],
        );
        regCount++;
        const fee = person.memberId && memberPrice != null ? memberPrice : price;
        if (fee > 0 && !waitlisted) {
          const issue = regAt.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
          const gross = round2(fee / 1.18);
          const tax = round2(fee - gross);
          const paid = past || rand() < 0.7;
          const [inv] = await q(
            `INSERT INTO invoices (organization_id, branch_id, member_id, customer_name, customer_phone, invoice_number, issue_date, subtotal, tax, total, amount_paid, status, created_by, source, created_at)
             VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,$8,$9,$10,$11,$12,'crm',$13) RETURNING id`,
            [org.id, b.id, person.memberId, person.memberId ? null : person.guest, docNo('FRG', 'invoice', issue), issue, gross, tax, fee, paid ? fee : 0, paid ? 'paid' : 'pending', admin.id, regAt],
          );
          await q(
            `INSERT INTO invoice_items (invoice_id, item_type, description, quantity, unit_price, tax_rate, tax, amount, event_registration_id) VALUES ($1,'event',$2,1,$3,18,$4,$5,$6)`,
            [inv.id, `${type === 'challenge' ? 'Fitness challenge' : type[0].toUpperCase() + type.slice(1)}: ${title}`, gross, tax, fee, reg.id],
          );
          await q(`UPDATE event_registrations SET invoice_id = $2 WHERE id = $1`, [reg.id, inv.id]);
          if (paid) {
            const method = pick(['upi', 'upi', 'cash', 'card']);
            await q(
              `INSERT INTO payments (organization_id, branch_id, member_id, invoice_id, receipt_number, amount, method, reference, paid_at, collected_by, created_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$9)`,
              [org.id, b.id, person.memberId, inv.id, docNo('RCT', 'receipt', issue), fee, method, method === 'upi' ? String(Math.floor(1e11 + rand() * 9e11)) : null, regAt, admin.id],
            );
          }
        }
        if (status === 'attended' && person.memberId && points) {
          await q(
            `INSERT INTO loyalty_transactions (organization_id, member_id, branch_id, reason, points, source_key, description, created_by, created_at)
             VALUES ($1,$2,$3,'event',$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
            [org.id, person.memberId, b.id, points, `event:${e.id}`, `Attended ${title}`, admin.id, endsAt],
          );
        }
      }
    }

    // --------------------------------------------------------------- campaigns --
    const CAMPAIGNS = [
      { name: 'Diwali offer · 20% off annual plans', type: 'festival_offer', audience: { kind: 'preset', key: 'expired' }, channels: ['whatsapp', 'push'], days: -38,
        body: 'Hi {{first_name}}, this Diwali come back to {{gym}} with 20% off any annual plan — code {{offer_code}}, valid till {{offer_valid_until}}. Happy Diwali! 🪔', offer: 'DIWALI20', validDays: 14 },
      { name: 'Early-bird renewal', type: 'renewal', audience: { kind: 'preset', key: 'expiring' }, channels: ['whatsapp'], days: -21,
        body: 'Hi {{first_name}}, your {{plan}} ends {{expiry_date}}. Renew this week and get 2 extra weeks free with code {{offer_code}}.', offer: 'EARLY2W', validDays: 10 },
      { name: 'Refer-a-friend month', type: 'referral', audience: { kind: 'preset', key: 'active' }, channels: ['push'], days: -55,
        body: 'Bring a friend to {{gym}} this month — share your code {{referral_code}}. When they join you both earn bonus points!', offer: null, validDays: 0 },
      { name: 'We miss you · come back', type: 'reactivation', audience: { kind: 'preset', key: 'inactive' }, channels: ['push', 'sms'], days: -12,
        body: 'Hi {{first_name}}, it’s been a while! Book a free session with a coach this week and get back on track.', offer: null, validDays: 0 },
      { name: 'Trial invite · open leads', type: 'lead', audience: { kind: 'leads', stages: ['new', 'contacted', 'interested'] }, channels: ['whatsapp'], days: -6,
        body: 'Hi {{first_name}}, your free trial at {{gym}} {{branch}} is waiting. Reply with a time that suits you and we’ll book it.', offer: null, validDays: 0 },
    ];
    const allBranches = branches.map((b: any) => b.id);
    for (const cp of CAMPAIGNS) {
      const sentAt = new Date(`${addToDate(now, 'day', cp.days)}T11:00:00+05:30`);
      const validUntil = cp.validDays ? addToDate(now, 'day', cp.days + cp.validDays) : null;
      const [row] = await q(
        `INSERT INTO campaigns (organization_id, name, type, audience, branch_ids, channels, body, offer_code, offer_valid_until, status, sent_at, created_by, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'sent',$10,$11,$10) RETURNING id`,
        [org.id, cp.name, cp.type, JSON.stringify(cp.audience), allBranches, cp.channels, cp.body, cp.offer, validUntil, sentAt, admin.id],
      );
      const audience = await resolveAudience(org.id, cp.audience as any, allBranches);
      for (const r of audience.slice(0, 160)) {
        const subj = await subjectVars(c, { memberId: r.member_id, leadId: r.lead_id }, { offer_code: cp.offer ?? '', offer_valid_until: validUntil ?? '' });
        if (!subj) continue;
        for (const ch of cp.channels) {
          const to = ch === 'push' ? (r.member_id ? 'app' : null) : ch === 'email' ? r.email : r.phone;
          if (r.opt_out || !to) {
            await q(`INSERT INTO campaign_recipients (campaign_id, member_id, lead_id, channel, status, skip_reason, created_at) VALUES ($1,$2,$3,$4,'skipped',$5,$6)`,
              [row.id, r.member_id, r.lead_id, ch, r.opt_out ? 'Opted out of promotions' : 'No contact for this channel', sentAt]);
            continue;
          }
          const status = ch === 'push' ? 'delivered' : 'sent';
          const [log] = await q(
            `INSERT INTO communication_logs (organization_id, branch_id, lead_id, member_id, channel, direction, body, status, provider, recipient, campaign_id, promotional, logged_by, created_at, sent_at)
             VALUES ($1,$2,$3,$4,$5,'outbound',$6,$7,$8,$9,$10,true,$11,$12,$12) RETURNING id`,
            [org.id, subj.row.branch_id, r.lead_id, r.member_id, ch, render(cp.body, subj.vars), status, ch === 'push' ? 'Forge Member App' : 'manual', to, row.id, admin.id, sentAt],
          );
          await q(`INSERT INTO campaign_recipients (campaign_id, member_id, lead_id, channel, status, communication_log_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [row.id, r.member_id, r.lead_id, ch, status, log.id, sentAt]);
          if (ch === 'push' && subj.row.user_id) {
            await q(`INSERT INTO notifications (organization_id, branch_id, recipient_id, audience, type, title, body, entity_type, entity_id, created_at, read_at)
                     VALUES ($1,$2,$3,'member','campaign',$4,$5,'campaign',$6,$7,$8)`,
              [org.id, subj.row.branch_id, subj.row.user_id, org.name, render(cp.body, subj.vars), row.id, sentAt, rand() < 0.6 ? sentAt : null]);
          }
        }
      }
    }
    await q(
      `INSERT INTO campaigns (organization_id, name, type, audience, branch_ids, channels, subject, body, offer_code, offer_valid_until, status, scheduled_at, created_by)
       VALUES ($1,'New Year resolution · 3 months for 2', 'membership_promotion', $2, $3, ARRAY['whatsapp','email','push'], 'New year, new you — {{gym}}',
               'Hi {{first_name}}, start the year strong: 3 months for the price of 2 at {{gym}} with code {{offer_code}} (till {{offer_valid_until}}).', 'NY3FOR2', $4, 'scheduled', $5, $6),
              ($1,'Birthday month treat', 'birthday', '{"kind":"preset","key":"birthday_month"}', $3, ARRAY['push'], NULL,
               'Happy birthday month, {{first_name}}! Enjoy a free smoothie at the {{gym}} café this month 🎂', NULL, NULL, 'draft', NULL, $6)`,
      [org.id, JSON.stringify({ kind: 'preset', key: 'new' }), allBranches, addToDate(now, 'day', 45), new Date(`${addToDate(now, 'day', 4)}T10:00:00+05:30`), admin.id],
    );

    for (const [k, v] of Object.entries(counters)) {
      await q(`INSERT INTO counters (organization_id, key, value) VALUES ($1,$2,$3) ON CONFLICT (organization_id, key) DO UPDATE SET value = EXCLUDED.value`, [org.id, k, v]);
    }
    console.log(`Seeded phase 6: ${EVENTS.length} events, ${regCount} registrations, ${CAMPAIGNS.length + 2} campaigns, automation rules and templates.`);
  });
}
