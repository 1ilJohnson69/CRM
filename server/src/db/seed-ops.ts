import { one, tx } from './pool.js';
import { hashPassword } from '../lib/auth.js';
import { addToDate, today } from '../lib/http.js';
import { generateSessions } from '../modules/ops/classes.js';

let s = 20263003;
const rand = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
const weighted = <T,>(xs: readonly [T, number][]) => {
  let r = rand() * xs.reduce((a, [, w]) => a + w, 0);
  for (const [x, w] of xs) if ((r -= w) <= 0) return x;
  return xs[0][0];
};
const IST = '+05:30';
const at = (date: string, hour: number, min = 0) => `${date}T${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:00${IST}`;
const dow = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

const CLASS_TYPES: [string, string, string, number, number][] = [
  ['Yoga Flow', 'Breath-led vinyasa for mobility and calm', 'Mind & body', 60, 24],
  ['Zumba', 'High-energy dance cardio', 'Cardio', 45, 30],
  ['CrossFit WOD', 'Coached workout of the day', 'Strength', 60, 16],
  ['HIIT 30', 'Short, sharp intervals', 'Cardio', 30, 20],
  ['Strength Foundations', 'Technique-first barbell basics', 'Strength', 60, 12],
  ['Mobility & Recovery', 'Stretching, foam rolling and joint prep', 'Mind & body', 45, 20],
  ['Spin', 'Indoor cycling to the beat', 'Cardio', 45, 18],
];

// [class, weekdays, start] per branch slot
const TIMETABLE: [string, number[], string][] = [
  ['Yoga Flow', [1, 3, 5], '06:30'], ['HIIT 30', [1, 2, 3, 4, 5], '07:30'], ['Zumba', [2, 4, 6], '18:00'],
  ['CrossFit WOD', [1, 3, 5], '19:00'], ['Strength Foundations', [2, 4], '07:00'], ['Mobility & Recovery', [0, 6], '09:00'],
  ['Spin', [1, 3, 6], '17:30'], ['Yoga Flow', [2, 4], '19:30'],
];

const PT_PACKAGES: [string, number, number, number][] = [
  ['PT Starter · 8 sessions', 8, 45, 9999], ['PT Pack · 12 sessions', 12, 60, 14999], ['PT Pack · 24 sessions', 24, 120, 26999], ['PT Elite · 36 sessions', 36, 180, 37999],
];

/** Idempotent: does nothing if class types already exist. */
export async function seedOps() {
  const has = await one(`SELECT count(*)::int AS n FROM class_types`);
  if (has!.n > 0) return;
  const org = await one(`SELECT id FROM organizations ORDER BY created_at LIMIT 1`);
  if (!org) return;

  await tx(async (c) => {
    const q = (text: string, params: unknown[] = []) => c.query(text, params).then((r) => r.rows);
    const bulk = async (table: string, cols: string[], rows: unknown[][]) => {
      for (let i = 0; i < rows.length; i += 400) {
        const chunk = rows.slice(i, i + 400);
        const params: unknown[] = [];
        const values = chunk.map((r) => `(${r.map((v) => { params.push(v); return `$${params.length}`; }).join(',')})`).join(',');
        await c.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${values}`, params);
      }
    };
    const now = today();
    const nowMs = Date.now();
    const branches = await q(`SELECT id, name, code FROM branches WHERE organization_id = $1 ORDER BY name`, [org.id]);

    // Trainers: one more per branch, all bookable with availability.
    const trainerRole = (await q(`SELECT id FROM roles WHERE organization_id = $1 AND key = 'trainer'`, [org.id]))[0].id;
    const pw = await hashPassword('Forge@2026');
    const newTrainers: [string, string, number, string[]][] = [
      ['Aisha Khan', 'aisha@forge.fit', 0, ['Yoga', 'Mobility', 'Pre/post-natal']],
      ['Vikrant Shetty', 'vikrant@forge.fit', 1, ['Strength', 'Powerlifting', 'Fat loss']],
      ['Neha Pai', 'neha@forge.fit', 2, ['HIIT', 'Functional', 'Spin']],
      ['Kunal Bose', 'kunal@forge.fit', 1, ['CrossFit', 'Conditioning']],
    ];
    let phone = 9845000300;
    for (const [name, email, bi] of newTrainers) {
      const [u] = await q(
        `INSERT INTO users (organization_id, kind, role_id, full_name, email, phone, password_hash, must_change_password, last_login_at)
         VALUES ($1,'staff',$2,$3,$4,$5,$6,false, now() - interval '1 day') ON CONFLICT DO NOTHING RETURNING id`,
        [org.id, trainerRole, name, email, `+91${phone++}`, pw],
      );
      if (!u) continue;
      await q(`INSERT INTO employees (user_id, designation, joining_date) VALUES ($1,'Personal Trainer',$2)`, [u.id, addToDate(now, 'day', -Math.floor(150 + rand() * 500))]);
      await q(`INSERT INTO staff_branches VALUES ($1,$2)`, [u.id, branches[bi].id]);
    }
    const trainers = await q(
      `SELECT u.id, u.full_name, r.key, COALESCE(array_agg(sb.branch_id) FILTER (WHERE sb.branch_id IS NOT NULL), '{}') AS branches
         FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN staff_branches sb ON sb.user_id = u.id
        WHERE u.organization_id = $1 AND r.key IN ('trainer', 'nutritionist') GROUP BY u.id, r.key`,
      [org.id],
    );
    const specialties: Record<string, string[]> = Object.fromEntries(newTrainers.map(([n, , , sp]) => [n, sp]));
    specialties['Rohan Pillai'] = ['Strength', 'Hypertrophy', 'Athletic performance'];
    specialties['Isha Kapoor'] = ['Sports nutrition', 'Weight management'];
    for (const t of trainers) {
      await q(`INSERT INTO trainer_profiles (user_id, specialties, bio) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [t.id, specialties[t.full_name] ?? ['Personal training'], t.key === 'nutritionist' ? 'Certified sports nutritionist.' : 'Certified personal trainer.']);
      if (t.key === 'nutritionist') {
        // Rotates across branches.
        for (const [wd, bi] of [[2, 0], [4, 1], [6, 2], [3, 0], [5, 1]] as const) {
          await q(`INSERT INTO staff_availability (user_id, branch_id, weekday, start_time, end_time) VALUES ($1,$2,$3,'10:00','17:00')`, [t.id, branches[bi].id, wd]);
        }
      } else {
        for (const wd of [1, 2, 3, 4, 5, 6]) {
          await q(`INSERT INTO staff_availability (user_id, branch_id, weekday, start_time, end_time) VALUES ($1,$2,$3,'06:00','12:00'),($1,$2,$3,'16:00','21:00')`, [t.id, t.branches[0], wd]);
        }
      }
    }
    const trainersAt = (branchId: string) => trainers.filter((t: any) => t.key === 'trainer' && t.branches.includes(branchId));
    const nutritionist = trainers.find((t: any) => t.key === 'nutritionist');

    // Class types, timetable, history and upcoming sessions.
    const types: Record<string, any> = {};
    for (const [name, description, category, dur, cap] of CLASS_TYPES) {
      const [r] = await q(
        `INSERT INTO class_types (organization_id, name, description, category, default_duration_min, default_capacity) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [org.id, name, description, category, dur, cap],
      );
      types[name] = r;
    }
    for (const b of branches) {
      const slots = TIMETABLE.filter(() => rand() < 0.85);
      for (const [name, weekdays, start] of slots) {
        const t = types[name];
        const trainer = pick(trainersAt(b.id));
        const [sch] = await q(
          `INSERT INTO class_schedules (organization_id, branch_id, class_type_id, trainer_id, weekdays, start_time, duration_min, capacity, location, starts_on)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [org.id, b.id, t.id, trainer?.id ?? null, weekdays, start, t.default_duration_min, t.default_capacity, name.includes('Spin') ? 'Spin studio' : 'Studio A', addToDate(now, 'day', -63)],
        );
        // Past sessions (generator only creates future ones).
        for (let d = 63; d >= 1; d--) {
          const date = addToDate(now, 'day', -d);
          if (!weekdays.includes(dow(date))) continue;
          const [h, m] = start.split(':').map(Number);
          const startsAt = at(date, h, m);
          await q(
            `INSERT INTO class_sessions (organization_id, branch_id, class_type_id, schedule_id, trainer_id, starts_at, ends_at, capacity, location, status)
             VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$6::timestamptz + make_interval(mins => $7),$8,$9,'completed')`,
            [org.id, b.id, t.id, sch.id, trainer?.id ?? null, startsAt, t.default_duration_min, t.default_capacity, 'Studio A'],
          );
        }
      }
    }
    await generateSessions(c);
    // Today's sessions that already finished are completed.
    await q(`UPDATE class_sessions SET status = 'completed' WHERE organization_id = $1 AND ends_at < now() - interval '1 hour'`, [org.id]);

    // Bookings from members who are entitled to classes.
    const sessions = await q(`SELECT id, branch_id, starts_at, capacity, status FROM class_sessions WHERE organization_id = $1 ORDER BY starts_at`, [org.id]);
    const classMembers = await q(
      `SELECT m.id, m.branch_id FROM members m JOIN member_current_membership cm ON cm.member_id = m.id
         JOIN membership_plans p ON p.id = cm.plan_id WHERE m.organization_id = $1 AND p.class_access AND cm.status IN ('active','expiring_soon','frozen','expired')`,
      [org.id],
    );
    const poolBy: Record<string, string[]> = {};
    for (const m of classMembers) (poolBy[m.branch_id] ??= []).push(m.id);
    const bookings: unknown[][] = [];
    for (const sess of sessions) {
      const pool = poolBy[sess.branch_id] ?? [];
      if (!pool.length) continue;
      const past = new Date(sess.starts_at).getTime() < nowMs;
      const fill = past ? 0.45 + rand() * 0.5 : Math.max(0, (0.25 + rand() * 0.9) * (1 - (new Date(sess.starts_at).getTime() - nowMs) / (9 * 86400_000)));
      const n = Math.min(pool.length, Math.round(sess.capacity * fill) + (!past && rand() < 0.15 ? 3 : 0));
      const chosen = [...pool].sort(() => rand() - 0.5).slice(0, n);
      chosen.forEach((memberId, i) => {
        const status = past ? weighted([['attended', 84], ['no_show', 10], ['cancelled', 6]] as const) : i < sess.capacity ? 'booked' : 'waitlisted';
        const created = new Date(new Date(sess.starts_at).getTime() - (6 + rand() * 120) * 3600_000).toISOString();
        bookings.push([org.id, sess.id, memberId, status, rand() < 0.55 ? 'app' : 'crm', created, status === 'attended' ? sess.starts_at : null, status === 'cancelled' ? created : null]);
      });
    }
    await bulk('class_bookings', ['organization_id', 'session_id', 'member_id', 'status', 'source', 'created_at', 'attended_at', 'cancelled_at'], bookings);

    // Gym attendance: visit habits per member, within paid coverage, with morning/evening peaks.
    const coverage = await q(
      `SELECT ms.member_id, m.branch_id, ms.start_date, ms.end_date, ms.frozen_until, ms.status
         FROM memberships ms JOIN members m ON m.id = ms.member_id
        WHERE ms.organization_id = $1 AND ms.status IN ('active', 'frozen') AND ms.end_date >= current_date - 90`,
      [org.id],
    );
    const habit: Record<string, number> = {};
    const visits: unknown[][] = [];
    const desk = await q(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE u.organization_id = $1 AND r.key = 'front_desk'`, [org.id]);
    for (const cov of coverage) {
      // Some members drift away — they feed the "inactive" metrics.
      const weekly = (habit[cov.member_id] ??= weighted([[0.3, 2], [1.5, 3], [3, 5], [4.5, 3], [6, 1]] as const));
      const dropOff = rand() < 0.12 ? addToDate(now, 'day', -Math.floor(15 + rand() * 30)) : null;
      for (let d = 90; d >= 0; d--) {
        const date = addToDate(now, 'day', -d);
        if (date < cov.start_date || date > cov.end_date) continue;
        if (cov.status === 'frozen' && cov.frozen_until && date >= addToDate(cov.frozen_until, 'day', -14) && date <= cov.frozen_until) continue;
        if (dropOff && date > dropOff) continue;
        const weekendFactor = [0.55, 1.1, 1.05, 1.1, 1.05, 0.95, 0.8][dow(date)];
        if (rand() > (weekly / 7) * weekendFactor) continue;
        const slot = weighted([['early', 34], ['morning', 12], ['midday', 8], ['evening', 38], ['late', 8]] as const);
        const hour = { early: 5 + Math.floor(rand() * 3), morning: 8 + Math.floor(rand() * 2), midday: 11 + Math.floor(rand() * 4), evening: 17 + Math.floor(rand() * 3), late: 20 + Math.floor(rand() * 2) }[slot];
        const inAt = new Date(at(date, hour, Math.floor(rand() * 60)));
        if (inAt.getTime() > nowMs) continue;
        const minutes = 50 + Math.floor(rand() * 60);
        const outAt = new Date(inAt.getTime() + minutes * 60_000);
        const out = outAt.getTime() < nowMs && rand() < 0.75 ? outAt.toISOString() : null;
        visits.push([org.id, cov.branch_id, cov.member_id, inAt.toISOString(), out, weighted([['front_desk', 3], ['qr', 5], ['member_id', 1]] as const), 'allowed', null, pick(desk).id]);
      }
    }
    // A few denied attempts from lapsed members.
    const lapsed = await q(
      `SELECT m.id, m.branch_id FROM members m JOIN member_current_membership cm ON cm.member_id = m.id
        WHERE m.organization_id = $1 AND cm.status = 'expired' AND cm.end_date >= current_date - 20 LIMIT 12`,
      [org.id],
    );
    for (const l of lapsed) {
      const inAt = new Date(nowMs - (2 + rand() * 300) * 3600_000).toISOString();
      visits.push([org.id, l.branch_id, l.id, inAt, null, 'qr', 'denied', 'Membership has expired', pick(desk).id]);
    }
    await bulk('attendance', ['organization_id', 'branch_id', 'member_id', 'checked_in_at', 'checked_out_at', 'method', 'status', 'reason', 'recorded_by'], visits);

    // Staff shifts for the last three weeks.
    const staff = await q(
      `SELECT u.id, r.key, COALESCE((SELECT sb.branch_id FROM staff_branches sb WHERE sb.user_id = u.id LIMIT 1), $2) AS branch_id
         FROM users u JOIN roles r ON r.id = u.role_id WHERE u.organization_id = $1 AND u.kind = 'staff' AND r.key <> 'super_admin'`,
      [org.id, branches[0].id],
    );
    const shifts: unknown[][] = [];
    for (const st of staff) {
      for (let d = 21; d >= 0; d--) {
        const date = addToDate(now, 'day', -d);
        if (dow(date) === 0 && rand() < 0.7) continue;
        const startH = st.key === 'trainer' ? 6 : st.key === 'front_desk' ? (rand() < 0.5 ? 6 : 14) : 9;
        const inAt = new Date(at(date, startH, Math.floor(rand() * 20)));
        if (inAt.getTime() > nowMs) continue;
        const outAt = new Date(inAt.getTime() + (7.5 + rand() * 2) * 3600_000);
        shifts.push([org.id, st.branch_id, st.id, inAt.toISOString(), outAt.getTime() < nowMs ? outAt.toISOString() : null]);
      }
    }
    await bulk('staff_attendance', ['organization_id', 'branch_id', 'user_id', 'clock_in', 'clock_out'], shifts);

    // PT catalog, and packages behind the PT invoices already on file.
    const pkgs: Record<number, any> = {};
    for (const [name, sessionsN, validity, price] of PT_PACKAGES) {
      const [r] = await q(`INSERT INTO pt_packages (organization_id, name, sessions, validity_days, price) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [org.id, name, sessionsN, validity, price]);
      pkgs[sessionsN] = r;
    }
    const ptItems = await q(
      `SELECT ii.id AS item_id, ii.description, ii.unit_price, ii.discount, i.member_id, i.branch_id, i.issue_date, i.status, i.created_by
         FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
        WHERE i.organization_id = $1 AND ii.item_type = 'pt' AND i.issue_date >= current_date - 170 AND i.status <> 'void'`,
      [org.id],
    );
    const appts: unknown[][] = [];
    for (const it of ptItems) {
      const n = it.description.includes('24') ? 24 : 12;
      const pkg = pkgs[n];
      const trainer = pick(trainersAt(it.branch_id));
      const expires = addToDate(it.issue_date, 'day', pkg.validity_days - 1);
      const [mp] = await q(
        `INSERT INTO member_pt_packages (organization_id, branch_id, member_id, package_id, trainer_id, sessions_total, price, discount, starts_on, expires_on, status, created_by, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [org.id, it.branch_id, it.member_id, pkg.id, trainer?.id ?? null, n, it.unit_price, it.discount, it.issue_date, expires,
          it.status === 'pending' ? 'pending' : 'active', it.created_by, at(it.issue_date, 12)],
      );
      await q(`UPDATE invoice_items SET member_pt_package_id = $2 WHERE id = $1`, [it.item_id, mp.id]);
      if (it.status === 'pending' || !trainer) continue;
      // Twice a week at a consistent hour until used up or today.
      const hour = pick([6, 7, 8, 17, 18, 19]);
      const days = [pick([1, 2]), pick([4, 5])];
      let used = 0;
      for (let d = 1; d < pkg.validity_days && used < n; d++) {
        const date = addToDate(it.issue_date, 'day', d);
        if (!days.includes(dow(date))) continue;
        const startsAt = new Date(at(date, hour));
        const past = startsAt.getTime() < nowMs - 3600_000;
        if (!past && startsAt.getTime() > nowMs + 8 * 86400_000) break;
        const booked = appts.filter((a) => a[5] === mp.id && a[8] === 'scheduled').length;
        if (!past && used + booked >= n) break;
        const status = past ? weighted([['completed', 88], ['no_show', 6], ['cancelled', 6]] as const) : 'scheduled';
        const consumed = status === 'completed' || status === 'no_show';
        if (consumed) used++;
        appts.push([org.id, it.branch_id, 'pt', trainer.id, it.member_id, mp.id, startsAt.toISOString(), new Date(startsAt.getTime() + 3600_000).toISOString(), status, consumed,
          'PT floor', status === 'completed' ? pick(['Lower body + core', 'Push day, PR on bench', 'Conditioning circuit', 'Mobility + deadlift technique', 'Upper body pull']) : null, trainer.id]);
        if (!past && booked + 1 >= 2) break;
      }
    }

    // Assessments for new members and nutrition consults.
    const recentJoins = await q(`SELECT id, branch_id, join_date FROM members WHERE organization_id = $1 AND join_date >= current_date - 30`, [org.id]);
    for (const m of recentJoins) {
      if (rand() < 0.4) continue;
      const trainer = pick(trainersAt(m.branch_id));
      if (!trainer) continue;
      const date = addToDate(m.join_date, 'day', 2 + Math.floor(rand() * 5));
      const startsAt = new Date(at(date, pick([7, 10, 17, 18])));
      const past = startsAt.getTime() < nowMs;
      appts.push([org.id, m.branch_id, 'assessment', trainer.id, m.id, null, startsAt.toISOString(), new Date(startsAt.getTime() + 45 * 60_000).toISOString(),
        past ? weighted([['completed', 9], ['no_show', 1]] as const) : 'scheduled', false, 'Assessment room', past ? 'Baseline: weight, body fat, push-ups, plank' : null, trainer.id]);
    }
    const nutritionClients = await q(
      `SELECT m.id, m.branch_id FROM members m JOIN member_current_membership cm ON cm.member_id = m.id
         JOIN membership_plans p ON p.id = cm.plan_id WHERE m.organization_id = $1 AND p.name = 'Annual Elite' AND cm.status IN ('active','expiring_soon')`,
      [org.id],
    );
    for (const m of nutritionClients) {
      if (!nutritionist) break;
      for (const offset of [-21, -7, 3 + Math.floor(rand() * 5)]) {
        let date = addToDate(now, 'day', offset);
        while (![2, 3, 4, 5, 6].includes(dow(date))) date = addToDate(date, 'day', 1);
        const startsAt = new Date(at(date, 10 + Math.floor(rand() * 6)));
        const past = startsAt.getTime() < nowMs;
        appts.push([org.id, m.branch_id, 'nutrition', nutritionist.id, m.id, null, startsAt.toISOString(), new Date(startsAt.getTime() + 40 * 60_000).toISOString(),
          past ? 'completed' : 'scheduled', false, 'Consult room', past ? 'Reviewed food log; protein target 120g' : null, nutritionist.id]);
      }
    }
    await bulk('appointments', ['organization_id', 'branch_id', 'type', 'staff_id', 'member_id', 'member_pt_package_id', 'starts_at', 'ends_at', 'status', 'consumed_session', 'location', 'outcome_notes', 'created_by'], appts);

    // Trials for leads already in the trial stages.
    const trialLeads = await q(`SELECT id, branch_id, stage, trial_at, assigned_to FROM leads WHERE organization_id = $1 AND stage IN ('trial_booked','trial_completed') AND trial_at IS NOT NULL`, [org.id]);
    for (const l of trialLeads) {
      const trainer = pick(trainersAt(l.branch_id));
      await q(
        `INSERT INTO appointments (organization_id, branch_id, type, staff_id, lead_id, starts_at, ends_at, status, location, created_by)
         VALUES ($1,$2,'trial',$3,$4,$5::timestamptz,$5::timestamptz + interval '45 minutes',$6,'Gym floor',$7)`,
        [org.id, l.branch_id, trainer?.id ?? null, l.id, l.trial_at, l.stage === 'trial_completed' ? 'completed' : 'scheduled', l.assigned_to],
      );
    }
    console.log(`Seeded ops: ${Object.keys(types).length} class types, ${sessions.length} sessions, ${bookings.length} bookings, ${visits.length} visits, ${ptItems.length} PT packages, ${appts.length + trialLeads.length} appointments.`);
  });
}
