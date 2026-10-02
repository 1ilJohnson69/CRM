import { pool, tx, one } from './pool.js';
import { migrate } from './migrate.js';
import { hashPassword } from '../lib/auth.js';
import { DEFAULT_ROLES, PERMISSIONS } from '../lib/permissions.js';
import { addToDate, round2, today } from '../lib/http.js';
import { seedCrm } from './seed-crm.js';
import { seedOps } from './seed-ops.js';
import { seedFitness } from './seed-fitness.js';
import { seedBusiness } from './seed-business.js';
import { seedAdvanced } from './seed-advanced.js';

// Deterministic PRNG so every seed produces the same demo data.
let s = 20261002;
const rand = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
const weighted = <T,>(xs: readonly [T, number][]) => {
  let r = rand() * xs.reduce((a, [, w]) => a + w, 0);
  for (const [x, w] of xs) if ((r -= w) <= 0) return x;
  return xs[0][0];
};

const FIRST_M = ['Aarav', 'Vihaan', 'Arjun', 'Rohan', 'Karan', 'Aditya', 'Rahul', 'Siddharth', 'Ishaan', 'Kabir', 'Dev', 'Nikhil', 'Varun', 'Pranav', 'Yash', 'Harsh', 'Manav', 'Tejas', 'Abhishek', 'Kunal', 'Akash', 'Rishi', 'Sameer', 'Naveen', 'Vikram'];
const FIRST_F = ['Ananya', 'Diya', 'Priya', 'Saanvi', 'Isha', 'Meera', 'Kavya', 'Riya', 'Aditi', 'Nisha', 'Pooja', 'Sneha', 'Tanvi', 'Shreya', 'Neha', 'Aisha', 'Zara', 'Lakshmi', 'Divya', 'Ira', 'Myra', 'Anika', 'Sara', 'Trisha', 'Nandini'];
const LAST = ['Sharma', 'Iyer', 'Reddy', 'Nair', 'Menon', 'Rao', 'Gupta', 'Kapoor', 'Mehta', 'Shetty', 'Pillai', 'Joshi', 'Verma', 'Bhat', 'Kulkarni', 'Hegde', 'Das', 'Chopra', 'Malhotra', 'Patel', 'Singh', 'Krishnan', 'Banerjee', 'Gowda', 'Naidu'];
const SOURCES = ['Walk-in', 'Instagram', 'Referral', 'Website', 'Google', 'Corporate tie-up'];

async function main() {
  await migrate();
  const existing = await one(`SELECT count(*)::int AS n FROM organizations`);
  if (existing!.n > 0) {
    // Upgrading an existing database: only add data for modules it lacks.
    await seedCrm();
    await seedOps();
    await seedFitness();
    await seedBusiness();
    await seedAdvanced();
    await clampFuture();
    console.log('Core data already present.');
    return;
  }

  await tx(async (c) => {
    const q = (text: string, params: unknown[] = []) => c.query(text, params).then((r) => r.rows);
    const now = today();

    const [org] = await q(
      `INSERT INTO organizations (name, legal_name, gstin, invoice_prefix) VALUES ('Forge Fitness', 'Forge Fitness Pvt. Ltd.', '29ABCDE1234F1Z5', 'FRG') RETURNING id`,
    );
    const branches: { id: string; name: string }[] = [];
    for (const [name, code, address] of [
      ['Indiranagar', 'IND', '100 Feet Rd, Indiranagar, Bengaluru 560038'],
      ['Koramangala', 'KOR', '80 Feet Rd, Koramangala 4th Block, Bengaluru 560034'],
      ['HSR Layout', 'HSR', '27th Main, HSR Layout Sector 1, Bengaluru 560102'],
    ]) {
      const [b] = await q(
        `INSERT INTO branches (organization_id, name, code, address, phone, email) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name`,
        [org.id, name, code, address, `+9180${Math.floor(40000000 + rand() * 9999999)}`, `${code.toLowerCase()}@forge.fit`],
      );
      branches.push(b);
    }

    for (const p of PERMISSIONS) await q(`INSERT INTO permissions (key, module, description) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [p.key, p.module, p.description]);
    const roles: Record<string, string> = {};
    for (const r of DEFAULT_ROLES) {
      const [row] = await q(
        `INSERT INTO roles (organization_id, key, name, description, all_branches, is_system) VALUES ($1,$2,$3,$4,$5,true) RETURNING id`,
        [org.id, r.key, r.name, r.description, r.allBranches],
      );
      roles[r.key] = row.id;
      for (const p of r.permissions) await q(`INSERT INTO role_permissions VALUES ($1,$2)`, [row.id, p]);
    }

    const staffPassword = await hashPassword('Forge@2026');
    const staffDefs: [string, string, string, number[] | null, string][] = [
      ['Vikram Rao', 'admin@forge.fit', 'super_admin', null, 'Founder & Director'],
      ['Meera Iyer', 'meera@forge.fit', 'branch_manager', [0], 'Branch Manager'],
      ['Arjun Menon', 'arjun@forge.fit', 'branch_manager', [1], 'Branch Manager'],
      ['Sneha Kulkarni', 'sneha@forge.fit', 'front_desk', [0], 'Front Desk Executive'],
      ['Rahul Nair', 'rahul@forge.fit', 'front_desk', [1], 'Front Desk Executive'],
      ['Divya Shetty', 'divya@forge.fit', 'front_desk', [2], 'Front Desk Executive'],
      ['Karan Malhotra', 'karan@forge.fit', 'sales', [0, 1], 'Membership Advisor'],
      ['Ananya Gupta', 'ananya@forge.fit', 'sales', [2], 'Membership Advisor'],
      ['Rohan Pillai', 'rohan@forge.fit', 'trainer', [0], 'Head Coach'],
      ['Isha Kapoor', 'isha@forge.fit', 'nutritionist', [0, 1, 2], 'Nutritionist'],
      ['Nikhil Joshi', 'accounts@forge.fit', 'accountant', null, 'Finance Lead'],
    ];
    const staff: { id: string; role: string; branches: number[] }[] = [];
    let phoneSeq = 9845000100;
    for (const [name, email, role, br, designation] of staffDefs) {
      const [u] = await q(
        `INSERT INTO users (organization_id, kind, role_id, full_name, email, phone, password_hash, must_change_password, last_login_at)
         VALUES ($1,'staff',$2,$3,$4,$5,$6,false, now() - random() * interval '3 days') RETURNING id`,
        [org.id, roles[role], name, email, `+91${phoneSeq++}`, staffPassword],
      );
      await q(`INSERT INTO employees (user_id, designation, joining_date) VALUES ($1,$2,$3)`, [u.id, designation, addToDate(now, 'day', -Math.floor(200 + rand() * 900))]);
      for (const b of br ?? []) await q(`INSERT INTO staff_branches VALUES ($1,$2)`, [u.id, branches[b].id]);
      staff.push({ id: u.id, role, branches: br ?? [0, 1, 2] });
    }
    const collectorsFor = (bi: number) => staff.filter((st) => ['front_desk', 'sales', 'branch_manager'].includes(st.role) && st.branches.includes(bi));

    const planDefs = [
      { name: 'Monthly', unit: 'month', value: 1, price: 2499, freeze: 0, classes: false, pt: false, disc: 5, benefits: ['Full gym floor access', 'Locker & shower'] },
      { name: 'Quarterly', unit: 'month', value: 3, price: 6999, freeze: 10, classes: false, pt: false, disc: 10, benefits: ['Full gym floor access', 'Locker & shower', '1 fitness assessment'] },
      { name: 'Half-Yearly', unit: 'month', value: 6, price: 12499, freeze: 20, classes: true, pt: false, disc: 10, benefits: ['Gym + group classes', '2 fitness assessments', '2 guest passes'] },
      { name: 'Annual', unit: 'month', value: 12, price: 21999, freeze: 45, classes: true, pt: false, disc: 15, benefits: ['Gym + group classes', 'Quarterly assessments', '6 guest passes'] },
      { name: 'Annual Elite', unit: 'month', value: 12, price: 34999, freeze: 60, classes: true, pt: true, disc: 15, benefits: ['All-access incl. recovery zone', '12 PT sessions', 'Nutrition consult', '12 guest passes'] },
      { name: 'Day Pass', unit: 'day', value: 1, price: 499, freeze: 0, classes: false, pt: false, disc: 0, benefits: ['Single-day gym access'] },
    ] as const;
    const plans: any[] = [];
    for (const p of planDefs) {
      const [row] = await q(
        `INSERT INTO membership_plans (organization_id, name, description, duration_unit, duration_value, price, tax_rate, benefits, class_access, pt_access,
                                       freeze_days_allowed, guest_passes, max_discount_pct, facility_access)
         VALUES ($1,$2,$3,$4,$5,$6,18,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [org.id, p.name, `${p.name} membership`, p.unit, p.value, p.price, p.benefits, p.classes, p.pt, p.freeze, p.name.includes('Annual') ? 6 : 0, p.disc,
          p.pt ? ['gym', 'classes', 'recovery'] : p.classes ? ['gym', 'classes'] : ['gym']],
      );
      plans.push(row);
    }
    const planWeights: [number, number][] = [[0, 34], [1, 26], [2, 16], [3, 15], [4, 5], [5, 4]];

    const counters: Record<string, number> = {};
    const nextNo = (key: string, year: string) => (counters[`${key}:${year}`] = (counters[`${key}:${year}`] ?? 0) + 1);
    const memberPassword = await hashPassword('Member@2026');
    const audits: unknown[][] = [];
    const at = (date: string) => {
      if (date >= now) return new Date(Date.now() - Math.floor(rand() * 5 * 3600_000)).toISOString();
      return `${date}T${String(7 + Math.floor(rand() * 14)).padStart(2, '0')}:${String(Math.floor(rand() * 60)).padStart(2, '0')}:00+05:30`;
    };

    async function bill(memberId: string, bi: number, date: string, items: { type: string; description: string; price: number; discount: number; membershipId?: string }[], payFraction: number, staffId: string, name: string) {
      const year = date.slice(0, 4);
      const number = `FRG-${year}-${String(nextNo('invoice', year)).padStart(5, '0')}`;
      const lines = items.map((it) => {
        const tax = round2((it.price - it.discount) * 0.18);
        return { ...it, tax, amount: round2(it.price - it.discount + tax) };
      });
      const subtotal = lines.reduce((a, l) => a + l.price, 0);
      const discount = lines.reduce((a, l) => a + l.discount, 0);
      const tax = round2(lines.reduce((a, l) => a + l.tax, 0));
      const total = round2(subtotal - discount + tax);
      const paid = payFraction >= 1 ? total : round2(Math.round(total * payFraction / 100) * 100);
      const status = paid >= total ? 'paid' : paid > 0 ? 'partially_paid' : 'pending';
      const ts = at(date);
      const [inv] = await q(
        `INSERT INTO invoices (organization_id, branch_id, member_id, invoice_number, issue_date, subtotal, discount, tax, total, amount_paid, status, created_by, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [org.id, branches[bi].id, memberId, number, date, subtotal, discount, tax, total, paid, status, staffId, ts],
      );
      for (const l of lines) {
        await q(
          `INSERT INTO invoice_items (invoice_id, item_type, description, membership_id, unit_price, discount, tax_rate, tax, amount) VALUES ($1,$2,$3,$4,$5,$6,18,$7,$8)`,
          [inv.id, l.type, l.description, l.membershipId ?? null, l.price, l.discount, l.tax, l.amount],
        );
      }
      if (paid > 0) {
        const method = weighted([['upi', 58], ['card', 18], ['cash', 16], ['bank_transfer', 8]] as const);
        const reference = method === 'upi' ? `${Math.floor(400000000000 + rand() * 99999999999)}` : method === 'bank_transfer' ? `NEFT${Math.floor(rand() * 1e10)}` : method === 'card' ? `POS-${Math.floor(rand() * 1e6)}` : null;
        const receipt = `RCT-${year}-${String(nextNo('receipt', year)).padStart(5, '0')}`;
        const [pay] = await q(
          `INSERT INTO payments (organization_id, branch_id, member_id, invoice_id, receipt_number, amount, method, reference, paid_at, collected_by, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$9) RETURNING id`,
          [org.id, branches[bi].id, memberId, inv.id, receipt, paid, method, reference, ts, staffId],
        );
        const label = method === 'bank_transfer' ? 'bank transfer' : method.toUpperCase();
        audits.push([org.id, branches[bi].id, staffId, 'payment.recorded', 'payment', pay.id, `₹${paid.toLocaleString('en-IN')} recorded via ${label} from ${name} (${number})`, ts]);
      }
      return { status };
    }

    let memberSeq = 0;
    const N = 460;
    for (let i = 0; i < N; i++) {
      const female = rand() < 0.44;
      const name = `${pick(female ? FIRST_F : FIRST_M)} ${pick(LAST)}`;
      const bi = weighted([[0, 45], [1, 35], [2, 20]] as const);
      // Recent months are busier: square the random so joins skew later.
      const joinedAgo = Math.floor(Math.pow(rand(), 1.35) * 430);
      const join = addToDate(now, 'day', -joinedAgo);
      const phone = `+91${9000000000 + Math.floor(rand() * 999999999)}`;
      const email = rand() < 0.85 ? `${name.toLowerCase().replace(' ', '.')}${i}@example.com` : null;
      const assigned = pick(collectorsFor(bi));

      const [u] = await q(
        `INSERT INTO users (organization_id, kind, full_name, email, phone, password_hash, must_change_password, last_login_at, created_at)
         VALUES ($1,'member',$2,$3,$4,$5,false,$6,$7) RETURNING id`,
        [org.id, name, email, phone, memberPassword, rand() < 0.6 ? at(addToDate(now, 'day', -Math.floor(rand() * 20))) : null, at(join)],
      );
      const code = `M${10000 + ++memberSeq}`;
      const dob = addToDate('1975-01-01', 'day', Math.floor(rand() * 11000));
      const [m] = await q(
        `INSERT INTO members (user_id, organization_id, branch_id, member_code, date_of_birth, gender, address, emergency_contact_name, emergency_contact_phone,
                              join_date, source, assigned_staff_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [u.id, org.id, branches[bi].id, code, dob, female ? 'female' : 'male', `${branches[bi].name}, Bengaluru`, `${pick(FIRST_F)} ${pick(LAST)}`,
          `+91${9100000000 + Math.floor(rand() * 899999999)}`, join, pick(SOURCES), assigned.id, at(join)],
      );
      audits.push([org.id, branches[bi].id, assigned.id, 'member.created', 'member', m.id, `New member ${name} (${code}) registered`, at(join)]);

      let planIdx = weighted(planWeights);
      let start = join;
      let prevId: string | null = null;
      let kind = 'new';
      while (start <= now) {
        const plan = plans[planIdx];
        const end = addToDate(addToDate(start, plan.duration_unit, plan.duration_value), 'day', -1);
        const discount = rand() < 0.3 ? round2(Math.floor((plan.price * plan.max_discount_pct * rand()) / 100 / 50) * 50) : 0;
        const recent = start >= addToDate(now, 'day', -25);
        const payFraction = plan.duration_unit === 'day' ? 1 : recent && rand() < 0.12 ? (rand() < 0.4 ? 0 : 0.5) : rand() < 0.04 ? 0.6 : 1;
        const collector = pick(collectorsFor(bi));
        const cancelled = rand() < 0.025;
        const [ms] = await q(
          `INSERT INTO memberships (organization_id, member_id, plan_id, branch_id, kind, status, start_date, end_date, price, discount, previous_membership_id,
                                    created_by, created_at, cancelled_at, cancel_reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
          [org.id, m.id, plan.id, branches[bi].id, kind, cancelled ? 'cancelled' : payFraction > 0 ? 'active' : 'pending', start, end, plan.price, discount, prevId,
            collector.id, at(start), cancelled ? at(addToDate(start, 'day', 5)) : null, cancelled ? 'Relocating to another city' : null],
        );
        const verb = kind === 'new' ? 'joined on' : 'renewed';
        audits.push([org.id, branches[bi].id, collector.id, kind === 'new' ? 'membership.created' : 'membership.renewed', 'membership', ms.id, `${name} ${verb} ${plan.name}`, at(start)]);

        const items = [{ type: 'membership', description: `${plan.name} membership`, price: plan.price, discount, membershipId: ms.id }];
        if (rand() < 0.14 && plan.duration_unit === 'month') items.push({ type: 'pt', description: weighted([['PT pack · 12 sessions', 3], ['PT pack · 24 sessions', 1]] as const), price: rand() < 0.75 ? 14999 : 26999, discount: 0, membershipId: undefined as any });
        if (rand() < 0.1) items.push({ type: 'product', description: pick(['Whey protein 1kg', 'Forge shaker + towel', 'Creatine 250g', 'Lifting belt']), price: pick([3299, 899, 1499, 2499]), discount: 0, membershipId: undefined as any });
        await bill(m.id, bi, start, items, payFraction, collector.id, name);
        if (cancelled) break;

        // Occasional standalone class-pack / product purchase mid-membership.
        if (rand() < 0.12) {
          const mid = addToDate(start, 'day', Math.floor(rand() * 25));
          if (mid <= now) {
            await bill(m.id, bi, mid, [rand() < 0.5
              ? { type: 'class', description: pick(['Yoga 10-class pack', 'HIIT 8-class pack', 'Mobility workshop']), price: pick([2999, 2499, 1499]), discount: 0 }
              : { type: 'product', description: pick(['Whey protein 1kg', 'Pre-workout 300g', 'Resistance band set']), price: pick([3299, 1999, 1299]), discount: 0 }],
              1, pick(collectorsFor(bi)).id, name);
          }
        }

        if (end >= now || payFraction === 0) break;
        if (plan.duration_unit === 'day') break;
        if (rand() > 0.7) break; // lapsed
        const gap = rand() < 0.75 ? 1 : Math.floor(2 + rand() * 18);
        start = addToDate(end, 'day', gap);
        prevId = ms.id;
        kind = 'renewal';
        if (rand() < 0.15) planIdx = Math.min(4, planIdx + 1);
      }
    }

    // A handful of currently frozen memberships.
    const freezable = await q(
      `SELECT ms.id, ms.end_date FROM memberships ms JOIN membership_plans p ON p.id = ms.plan_id
        WHERE ms.status = 'active' AND p.freeze_days_allowed >= 15 AND ms.start_date <= current_date - 20 AND ms.end_date >= current_date + 30
        ORDER BY ms.id LIMIT 14`,
    );
    for (const f of freezable) {
      const days = 15;
      const startF = addToDate(now, 'day', -Math.floor(rand() * 6));
      await q(`UPDATE memberships SET status='frozen', frozen_until=$2, end_date=$3, freeze_days_used=$4 WHERE id=$1`, [f.id, addToDate(startF, 'day', days - 1), addToDate(f.end_date, 'day', days), days]);
      await q(`INSERT INTO membership_freezes (membership_id, start_date, end_date, reason) VALUES ($1,$2,$3,'Travel')`, [f.id, startF, addToDate(startF, 'day', days - 1)]);
    }

    audits.sort((a, b) => String(a[7]).localeCompare(String(b[7])));
    for (const a of audits) {
      await q(`INSERT INTO audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, summary, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, a);
    }
    for (const [key, value] of Object.entries(counters)) await q(`INSERT INTO counters VALUES ($1,$2,$3)`, [org.id, key, value]);
    await q(`INSERT INTO counters VALUES ($1,'member',$2)`, [org.id, memberSeq]);
    console.log(`Seeded ${N} members, ${plans.length} plans, ${staff.length} staff, ${audits.length} audit entries.`);
  });
  await seedCrm();
  await seedOps();
  await seedFitness();
  await seedBusiness();
  await seedAdvanced();
  await clampFuture();
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

/**
 * Demo data is generated by day and hour; anything that landed later than
 * the moment the seed runs is pulled back so nothing is dated in the future.
 */
async function clampFuture() {
  const cols: [string, string][] = [
    ['payments', 'paid_at'], ['payments', 'created_at'], ['invoices', 'created_at'], ['inventory_transactions', 'created_at'], ['loyalty_transactions', 'created_at'],
    ['communication_logs', 'created_at'], ['audit_logs', 'created_at'], ['notifications', 'created_at'], ['refunds', 'created_at'], ['expenses', 'created_at'],
  ];
  for (const [table, col] of cols) {
    await pool.query(`UPDATE ${table} SET ${col} = now() - (random() * interval '90 minutes') WHERE ${col} > now()`);
  }
}
