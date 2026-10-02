import { one, tx } from './pool.js';
import { addToDate, round2, today } from '../lib/http.js';
import { ensureExpenseCategories } from '../modules/business/expenses.js';

// Deterministic PRNG so every seed produces the same demo data.
let s = 20265005;
const rand = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
const weighted = <T,>(xs: readonly [T, number][]) => {
  let r = rand() * xs.reduce((a, [, w]) => a + w, 0);
  for (const [x, w] of xs) if ((r -= w) <= 0) return x;
  return xs[0][0];
};
const int = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1));

const SUPPLIERS = [
  ['Peak Fuel Distributors', 'Manoj Rao', '+919845012345', 'orders@peakfuel.example', '29AAGCP1234K1Z2'],
  ['Forge Merch Studio', 'Shalini D', '+919880045678', 'hello@forgemerch.example', null],
  ['FitGear Wholesale', 'Imran Khan', '+919900067890', 'sales@fitgear.example', '29AABCF5678L1Z9'],
  ['Fresh Press Beverages', 'Anil Kumar', '+919742011122', 'supply@freshpress.example', null],
] as const;

// sku, name, category, brand, cost, price, gst, low threshold, supplier index, demand weight, track stock
const PRODUCTS: [string, string, string, string, number, number, number, number, number, number, boolean][] = [
  ['SUP-WHY-CHO', 'Whey Protein 1 kg · Chocolate', 'supplements', 'Peak Fuel', 1900, 2799, 18, 6, 0, 6, true],
  ['SUP-WHY-VAN', 'Whey Protein 1 kg · Vanilla', 'supplements', 'Peak Fuel', 1900, 2799, 18, 4, 0, 3, true],
  ['SUP-ISO-2KG', 'Whey Isolate 2 kg', 'supplements', 'Peak Fuel', 5200, 6999, 18, 3, 0, 1.2, true],
  ['SUP-CRE-250', 'Creatine Monohydrate 250 g', 'supplements', 'Peak Fuel', 650, 999, 18, 6, 0, 4, true],
  ['SUP-BCA-300', 'BCAA 300 g · Watermelon', 'supplements', 'Peak Fuel', 900, 1399, 18, 4, 0, 1.5, true],
  ['SUP-PRE-300', 'Pre-workout 300 g', 'supplements', 'Peak Fuel', 1100, 1699, 18, 4, 0, 1.5, true],
  ['SUP-MUL-60', 'Multivitamin · 60 tablets', 'supplements', 'Peak Fuel', 350, 599, 18, 6, 0, 2, true],
  ['SUP-OMG-60', 'Fish Oil · 60 capsules', 'supplements', 'Peak Fuel', 380, 649, 18, 5, 0, 1.5, true],
  ['SUP-GAI-3KG', 'Mass Gainer 3 kg', 'supplements', 'Peak Fuel', 2200, 3299, 18, 2, 0, 0.6, true],
  ['SUP-ELC-10', 'Electrolyte sachets · pack of 10', 'supplements', 'Peak Fuel', 180, 299, 18, 8, 0, 3, true],
  ['FNB-BAR-PRO', 'Protein Bar 60 g', 'food_beverage', 'Peak Fuel', 60, 110, 12, 24, 0, 14, true],
  ['FNB-PNB-1KG', 'Peanut Butter 1 kg', 'food_beverage', 'Peak Fuel', 260, 449, 12, 5, 0, 1.5, true],
  ['FNB-RTD-COF', 'Protein Cold Coffee 250 ml', 'food_beverage', 'Fresh Press', 45, 120, 5, 18, 3, 9, true],
  ['FNB-COC-WAT', 'Tender Coconut Water 200 ml', 'food_beverage', 'Fresh Press', 35, 60, 5, 18, 3, 8, true],
  ['FNB-WAT-1L', 'Mineral Water 1 L', 'food_beverage', 'Fresh Press', 12, 25, 5, 30, 3, 16, true],
  ['FNB-ENG-250', 'Sugar-free Energy Drink 250 ml', 'food_beverage', 'Fresh Press', 55, 99, 12, 12, 3, 5, true],
  ['FNB-SMO-MAD', 'Fresh Smoothie (made to order)', 'food_beverage', 'Forge Café', 55, 179, 5, 0, 3, 6, false],
  ['MER-TSH-BLK', 'Forge Training Tee · Black', 'merchandise', 'Forge', 220, 699, 12, 6, 1, 1.5, true],
  ['MER-HOO-CHR', 'Forge Hoodie · Charcoal', 'merchandise', 'Forge', 650, 1799, 12, 3, 1, 0.6, true],
  ['MER-SHK-700', 'Forge Shaker 700 ml', 'merchandise', 'Forge', 90, 299, 18, 8, 1, 3, true],
  ['MER-BAG-DUF', 'Forge Duffel Bag', 'merchandise', 'Forge', 450, 1199, 12, 3, 1, 0.5, true],
  ['MER-CAP-BLK', 'Forge Cap', 'merchandise', 'Forge', 150, 449, 12, 4, 1, 0.6, true],
  ['ACC-BLT-LEA', 'Leather Lifting Belt', 'accessories', 'Ironclad', 650, 1499, 18, 3, 2, 0.6, true],
  ['ACC-WRW-PR', 'Wrist Wraps · pair', 'accessories', 'Ironclad', 180, 449, 18, 5, 2, 1.2, true],
  ['ACC-GLV-M', 'Training Gloves', 'accessories', 'Ironclad', 200, 499, 18, 5, 2, 1.2, true],
  ['ACC-RBS-5', 'Resistance Band Set (5)', 'accessories', 'Ironclad', 350, 899, 18, 3, 2, 0.8, true],
  ['ACC-ROP-SPD', 'Speed Skipping Rope', 'accessories', 'Ironclad', 120, 299, 18, 4, 2, 0.8, true],
  ['ACC-TWL-MF', 'Microfibre Gym Towel', 'accessories', 'Forge', 110, 249, 12, 6, 1, 1.5, true],
  ['ACC-LCK-PAD', 'Padlock', 'accessories', 'Ironclad', 90, 199, 18, 5, 2, 1, true],
  ['SRV-LKR-MON', 'Locker rental · 1 month', 'services', 'Forge', 0, 500, 18, 0, -1, 1.5, false],
  ['SRV-TWL-DAY', 'Towel service · day', 'services', 'Forge', 0, 50, 18, 0, -1, 4, false],
  ['SRV-BCA-SCN', 'Body composition scan', 'services', 'Forge', 0, 299, 18, 0, -1, 1, false],
  ['SRV-GST-DAY', 'Guest pass · 1 day', 'services', 'Forge', 0, 499, 18, 0, -1, 1.2, false],
];

const WALK_IN = ['Rakesh', 'Sunita', 'Farhan', 'Deepa', 'Mohit', 'Lavanya', 'Gaurav', 'Swati', 'Ajay', 'Ritu', 'Vivek', 'Pallavi', 'Sanjay', 'Komal', 'Arvind'];
const SALARY: Record<string, [number, string, number | null]> = {
  branch_manager: [45000, 'monthly', null], front_desk: [18000, 'monthly', null], sales: [20000, 'monthly', 2],
  trainer: [26000, 'monthly', 10], nutritionist: [30000, 'monthly', null], accountant: [35000, 'monthly', null],
};
const RENT: Record<string, number> = { IND: 65000, KOR: 58000, HSR: 48000 };

export async function seedBusiness() {
  const has = await one(`SELECT count(*)::int AS n FROM products`);
  if (has!.n > 0) return;
  const org = await one(`SELECT id, loyalty_settings FROM organizations ORDER BY created_at LIMIT 1`);
  if (!org) return;

  await tx(async (c) => {
    const q = (text: string, params: unknown[] = []) => c.query(text, params).then((r) => r.rows);
    const now = today();
    const cats = await ensureExpenseCategories(c, org.id);
    const branches = await q(`SELECT id, code, name FROM branches WHERE organization_id = $1 ORDER BY name`, [org.id]);
    const admin = (await q(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.key = 'super_admin' AND u.organization_id = $1 LIMIT 1`, [org.id]))[0];
    const deskStaff = await q(
      `SELECT u.id, sb.branch_id FROM users u JOIN roles r ON r.id = u.role_id JOIN staff_branches sb ON sb.user_id = u.id
        WHERE u.organization_id = $1 AND r.key IN ('front_desk', 'branch_manager', 'sales')`,
      [org.id],
    );
    const sellerAt = (b: string) => pick(deskStaff.filter((d: any) => d.branch_id === b).map((d: any) => d.id).concat(admin.id));
    const counters: Record<string, number> = Object.fromEntries((await q(`SELECT key, value FROM counters WHERE organization_id = $1`, [org.id])).map((r: any) => [r.key, Number(r.value)]));
    const docNo = (prefix: string, key: string, date: string) => {
      const year = date.slice(0, 4);
      const k = `${key}:${year}`;
      counters[k] = (counters[k] ?? 0) + 1;
      return `${prefix}-${year}-${String(counters[k]).padStart(5, '0')}`;
    };
    const ts = (date: string, hour: number, min = int(0, 59)) => `${date} ${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:00+05:30`;

    // ---------------------------------------------------------- employees --
    const staff = await q(
      `SELECT u.id, u.full_name, r.key, (SELECT min(sb.branch_id::text) FROM staff_branches sb WHERE sb.user_id = u.id) AS branch_id
         FROM users u JOIN roles r ON r.id = u.role_id WHERE u.organization_id = $1 AND u.kind = 'staff'`,
      [org.id],
    );
    for (const st of staff) {
      const sal = SALARY[st.key];
      if (!sal) continue;
      const amount = sal[0] + int(-3, 6) * 1000;
      st.salary = amount;
      await q(
        `INSERT INTO employees (user_id, salary, salary_type, commission_pct, emergency_contact) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (user_id) DO UPDATE SET salary = EXCLUDED.salary, salary_type = EXCLUDED.salary_type, commission_pct = EXCLUDED.commission_pct,
                                             emergency_contact = COALESCE(employees.emergency_contact, EXCLUDED.emergency_contact)`,
        [st.id, amount, sal[1], sal[2], `Family · +9198${int(10000000, 99999999)}`],
      );
    }

    // ---------------------------------------------------- suppliers & products --
    const supplierIds: string[] = [];
    for (const [name, contact, phone, email, gstin] of SUPPLIERS) {
      const [r] = await q(`INSERT INTO suppliers (organization_id, name, contact_name, phone, email, gstin) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [org.id, name, contact, phone, email, gstin]);
      supplierIds.push(r.id);
    }
    const products = [];
    for (const [sku, name, category, brand, cost, price, gst, low, sup, weight, track] of PRODUCTS) {
      const [r] = await q(
        `INSERT INTO products (organization_id, sku, barcode, name, category, brand, cost_price, selling_price, tax_rate, track_stock, low_stock_threshold, supplier_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now() - interval '100 days') RETURNING id`,
        [org.id, sku, track ? `890${int(1000000000, 9999999999)}` : null, name, category, brand, cost, price, gst, track, low, sup >= 0 ? supplierIds[sup] : null],
      );
      products.push({ id: r.id, sku, name, category, cost, price, gst, low, sup, weight, track });
    }

    // Stock simulation: deliveries, sales, a few write-offs, all through the ledger.
    const stock: Record<string, number> = {};
    const key = (b: string, p: string) => `${b}:${p}`;
    const ledger = async (b: string, p: any, type: string, qty: number, at: string, extra: Record<string, unknown> = {}) => {
      const k = key(b, p.id);
      stock[k] = (stock[k] ?? 0) + qty;
      await q(
        `INSERT INTO inventory_transactions (organization_id, branch_id, product_id, type, quantity, balance_after, unit_cost, supplier_id, invoice_id, refund_id, expense_id, reason, created_by, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [org.id, b, p.id, type, qty, stock[k], p.cost, extra.supplierId ?? null, extra.invoiceId ?? null, extra.refundId ?? null, extra.expenseId ?? null, extra.reason ?? null, extra.by ?? admin.id, at],
      );
    };
    const expense = async (b: string, cat: string, amount: number, date: string, e: Record<string, unknown> = {}) => {
      const [r] = await q(
        `INSERT INTO expenses (organization_id, branch_id, category_id, expense_number, amount, expense_date, vendor, supplier_id, employee_id, salary_month, method, reference, description, recorded_by, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [org.id, b, cats[cat], docNo('EXP', 'expense', date), round2(amount), date, e.vendor ?? null, e.supplierId ?? null, e.employeeId ?? null, e.salaryMonth ?? null,
          e.method ?? 'bank_transfer', (e.method ?? 'bank_transfer') === 'cash' ? null : `UTR${int(100000000, 999999999)}`, e.description ?? null, admin.id, ts(date, 11)],
      );
      return r.id;
    };
    const deliver = async (b: string, items: { p: any; qty: number }[], date: string) => {
      const bySupplier = new Map<number, { p: any; qty: number }[]>();
      for (const it of items) bySupplier.set(it.p.sup, [...(bySupplier.get(it.p.sup) ?? []), it]);
      for (const [sup, its] of bySupplier) {
        const total = its.reduce((a, it) => a + it.p.cost * it.qty, 0);
        const exp = await expense(b, 'inventory', total, date, {
          vendor: SUPPLIERS[sup][0], supplierId: supplierIds[sup], method: 'bank_transfer',
          description: its.map((it) => `${it.qty} × ${it.p.name}`).join(', '),
        });
        for (const it of its) await ledger(b, it.p, 'stock_in', it.qty, ts(date, 10), { supplierId: supplierIds[sup], expenseId: exp, reason: 'Supplier delivery' });
      }
    };

    const tracked = products.filter((p) => p.track);
    const start = addToDate(now, 'day', -95);
    for (const b of branches) {
      await deliver(b.id, tracked.map((p) => ({ p, qty: Math.max(p.low * 2, Math.round(p.weight * 3) + 3) })), start);
    }

    // Members who shop, per branch, with an in-memory points balance for redemptions.
    const members = await q(
      `SELECT m.id, m.branch_id, u.full_name FROM members m JOIN users u ON u.id = m.user_id JOIN member_current_membership cm ON cm.member_id = m.id
        WHERE m.organization_id = $1 AND cm.status IN ('active','expiring_soon','frozen')`,
      [org.id],
    );
    const settings = org.loyalty_settings;

    // ------------------------------------------------ loyalty backfill (history) --
    await q(
      `INSERT INTO loyalty_transactions (organization_id, member_id, branch_id, reason, points, source_key, description, invoice_id, created_at)
       SELECT p.organization_id, p.member_id, p.branch_id, 'purchase', floor(p.amount / 100 * $2)::int, 'payment:' || p.id,
              'Payment ' || p.receipt_number || ' (' || i.invoice_number || ')', i.id, p.paid_at
         FROM payments p JOIN invoices i ON i.id = p.invoice_id
        WHERE p.organization_id = $1 AND p.status = 'recorded' AND p.member_id IS NOT NULL AND floor(p.amount / 100 * $2) > 0`,
      [org.id, settings.pointsPer100],
    );
    await q(
      `INSERT INTO loyalty_transactions (organization_id, member_id, branch_id, reason, points, source_key, description, invoice_id, created_at)
       SELECT DISTINCT ON (ms.id) ms.organization_id, ms.member_id, ms.branch_id, 'renewal', $2, 'membership:' || ms.id, 'Renewal bonus — thanks for staying with us', i.id,
              (SELECT max(p.paid_at) FROM payments p WHERE p.invoice_id = i.id AND p.status = 'recorded')
         FROM memberships ms JOIN invoice_items ii ON ii.membership_id = ms.id JOIN invoices i ON i.id = ii.invoice_id
        WHERE ms.organization_id = $1 AND ms.kind = 'renewal' AND i.status = 'paid'`,
      [org.id, settings.renewalPoints],
    );
    for (const m of settings.milestones) {
      await q(
        `INSERT INTO loyalty_transactions (organization_id, member_id, branch_id, reason, points, source_key, description, created_at)
         SELECT $1, x.member_id, x.branch_id, 'attendance_milestone', $3, $4, $5, x.checked_in_at
           FROM (SELECT a.member_id, a.branch_id, a.checked_in_at, row_number() OVER (PARTITION BY a.member_id ORDER BY a.checked_in_at) AS n
                   FROM attendance a WHERE a.organization_id = $1 AND a.status <> 'denied') x
          WHERE x.n = $2`,
        [org.id, m.visits, m.points, `visits:${m.visits}`, `${m.visits} visits milestone`],
      );
    }
    // Community events and challenges.
    const challengers = [...members].sort(() => rand() - 0.5).slice(0, 36);
    for (const [i, m] of challengers.entries()) {
      const isEvent = i % 3 === 0;
      await q(
        `INSERT INTO loyalty_transactions (organization_id, member_id, branch_id, reason, points, description, created_by, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [org.id, m.id, m.branch_id, isEvent ? 'event' : 'challenge', isEvent ? 150 : 300,
          isEvent ? 'Forge Anniversary 5K — finisher' : '30-day Summer Shred Challenge — completed', admin.id, ts(addToDate(now, 'day', isEvent ? -40 : -62), 19)],
      );
    }
    const balances: Record<string, number> = Object.fromEntries(
      (await q(`SELECT member_id, sum(points)::int AS b FROM loyalty_transactions WHERE organization_id = $1 GROUP BY 1`, [org.id])).map((r: any) => [r.member_id, r.b]),
    );

    // ------------------------------------------------------------ POS history --
    let salesCount = 0;
    const refundable: any[] = [];
    const pending: { date: string; b: string; p: any; qty: number }[] = [];
    const weights = products.map((p) => [p, p.weight] as [any, number]);
    for (let d = -92; d <= 0; d++) {
      const date = addToDate(now, 'day', d);
      // Deliveries ordered when stock ran low arrive two days later.
      for (const b of branches) {
        const due = pending.filter((x) => x.b === b.id && x.date === date);
        if (due.length) await deliver(b.id, due.map((x) => ({ p: x.p, qty: x.qty })), date);
      }
      for (let i = pending.length - 1; i >= 0; i--) if (pending[i].date === date) pending.splice(i, 1);

      for (const b of branches) {
        const n = int(1, b.code === 'HSR' ? 3 : 5) + (new Date(date).getUTCDay() === 6 ? 2 : 0);
        for (let k = 0; k < n; k++) {
          const lines: { p: any; qty: number }[] = [];
          const lineCount = weighted([[1, 6], [2, 3], [3, 1]] as [number, number][]);
          for (let l = 0; l < lineCount; l++) {
            const p = weighted(weights);
            if (lines.some((x) => x.p.id === p.id)) continue;
            const qty = p.category === 'food_beverage' && rand() < 0.25 ? 2 : 1;
            if (p.track && (stock[key(b.id, p.id)] ?? 0) < qty) continue;
            lines.push({ p, qty });
          }
          if (!lines.length) continue;
          const member = rand() < 0.62 ? pick(members.filter((m: any) => m.branch_id === b.id)) : null;
          const hour = weighted([[7, 3], [8, 3], [9, 2], [12, 1], [17, 2], [18, 4], [19, 4], [20, 2]] as [number, number][]);
          const at = ts(date, hour);
          const seller = sellerAt(b.id);
          let subtotal = 0, tax = 0;
          const items = lines.map((l) => {
            const gross = l.p.price * l.qty;
            const t = round2((gross * l.p.gst) / 100);
            subtotal += gross; tax += t;
            return { ...l, gross, tax: t, amount: round2(gross + t) };
          });
          let total = round2(subtotal + tax);
          let points = 0, pointsDiscount = 0;
          if (member && (balances[member.id] ?? 0) >= settings.minRedeem + 200 && rand() < 0.35 && total >= 500) {
            const cap = Math.floor((total * settings.maxRedeemPct) / 100 / settings.pointValue);
            points = Math.min(cap, balances[member.id] - 100);
            points = Math.floor(points / 50) * 50;
            if (points >= settings.minRedeem) { pointsDiscount = round2(points * settings.pointValue); total = round2(total - pointsDiscount); }
            else points = 0;
          }
          const onAccount = member && rand() < 0.03;
          const paid = onAccount ? 0 : total;
          const [inv] = await q(
            `INSERT INTO invoices (organization_id, branch_id, member_id, invoice_number, issue_date, subtotal, discount, tax, total, amount_paid, status, created_by,
                                   customer_name, customer_phone, source, points_redeemed, points_discount, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,$9,$10,$11,$12,$13,'pos',$14,$15,$16,$16) RETURNING id, invoice_number`,
            [org.id, b.id, member?.id ?? null, docNo('FRG', 'invoice', date), date, round2(subtotal), round2(tax), total, paid, paid >= total ? 'paid' : 'pending', seller,
              member ? null : `${pick(WALK_IN)} ${pick(['K', 'S', 'R', 'M', 'P', 'D'])}.`, member ? null : rand() < 0.5 ? `+9199${int(10000000, 99999999)}` : null, points, pointsDiscount, at],
          );
          const itemIds: string[] = [];
          for (const it of items) {
            const [ii] = await q(
              `INSERT INTO invoice_items (invoice_id, item_type, description, quantity, unit_price, tax_rate, tax, amount, product_id, unit_cost)
               VALUES ($1,'product',$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
              [inv.id, it.p.name, it.qty, it.p.price, it.p.gst, it.tax, it.amount, it.p.id, it.p.cost],
            );
            itemIds.push(ii.id);
            if (it.p.track) await ledger(b.id, it.p, 'sold', -it.qty, at, { invoiceId: inv.id, by: seller });
          }
          if (points) {
            balances[member.id] -= points;
            await q(
              `INSERT INTO loyalty_transactions (organization_id, member_id, branch_id, reason, points, source_key, description, invoice_id, created_by, created_at)
               VALUES ($1,$2,$3,'redemption',$4,$5,$6,$7,$8,$9)`,
              [org.id, member.id, b.id, -points, `invoice:${inv.id}`, `Redeemed on ${inv.invoice_number} (₹${pointsDiscount} off)`, inv.id, seller, at],
            );
          }
          if (paid > 0) {
            const method = weighted([['upi', 55], ['cash', 30], ['card', 15]] as [string, number][]);
            const [pay] = await q(
              `INSERT INTO payments (organization_id, branch_id, member_id, invoice_id, receipt_number, amount, method, reference, paid_at, collected_by, created_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$9) RETURNING id, receipt_number`,
              [org.id, b.id, member?.id ?? null, inv.id, docNo('RCT', 'receipt', date), paid, method, method === 'upi' ? `${int(100000000000, 999999999999)}` : null, at, seller],
            );
            if (member) {
              const earned = Math.floor((paid / 100) * settings.pointsPer100);
              if (earned > 0) {
                balances[member.id] = (balances[member.id] ?? 0) + earned;
                await q(
                  `INSERT INTO loyalty_transactions (organization_id, member_id, branch_id, reason, points, source_key, description, invoice_id, created_at)
                   VALUES ($1,$2,$3,'purchase',$4,$5,$6,$7,$8)`,
                  [org.id, member.id, b.id, earned, `payment:${pay.id}`, `Payment ${pay.receipt_number} (${inv.invoice_number})`, inv.id, at],
                );
              }
            }
            if (rand() < 0.03 && d < -2) refundable.push({ inv, items, itemIds, b: b.id, member, date, total, paid, method });
          }
          salesCount++;
        }
        // Reorder when stock hits the threshold — except a few lines left to run low for the demo.
        for (const p of tracked) {
          const qty = stock[key(b.id, p.id)] ?? 0;
          const leaveLow = ['SUP-ISO-2KG', 'FNB-RTD-COF', 'ACC-BLT-LEA'].includes(p.sku) && d > -20;
          if (qty <= p.low && !leaveLow && !pending.some((x) => x.b === b.id && x.p.id === p.id)) {
            pending.push({ date: addToDate(date, 'day', 2), b: b.id, p, qty: Math.max(p.low * 2, Math.round(p.weight * 3) + 3) - qty });
          }
        }
      }
      // Occasional damage write-off.
      if (rand() < 0.08) {
        const b = pick(branches);
        const p = pick(tracked.filter((x) => x.category === 'food_beverage' || x.category === 'supplements'));
        if ((stock[key(b.id, p.id)] ?? 0) > 2) await ledger(b.id, p, 'damaged', -1, ts(date, 21), { reason: pick(['Seal broken', 'Expired', 'Dented tub', 'Leaked in storage']) });
      }
    }

    // Returns: unopened items brought back within a couple of days.
    for (const r of refundable) {
      const idx = 0;
      const it = r.items[idx];
      const gross = r.items.reduce((a: number, x: any) => a + x.amount, 0);
      const amount = round2(Math.min(it.amount * (r.total / gross), r.paid));
      const date = addToDate(r.date, 'day', int(1, 2));
      const [rf] = await q(
        `INSERT INTO refunds (organization_id, branch_id, invoice_id, member_id, refund_number, amount, method, reference, reason, items, restocked, refunded_by, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11,$12) RETURNING id`,
        [org.id, r.b, r.inv.id, r.member?.id ?? null, docNo('RFD', 'refund', date), amount, r.method, r.method === 'upi' ? `${int(100000000000, 999999999999)}` : null,
          pick(['Wrong flavour', 'Changed mind — unopened', 'Wrong size']), JSON.stringify([{ description: it.p.name, quantity: it.qty, amount }]), admin.id, ts(date, 18)],
      );
      await q(`UPDATE invoice_items SET returned_qty = quantity WHERE id = $1`, [r.itemIds[idx]]);
      await q(`UPDATE invoices SET amount_refunded = $2, status = CASE WHEN $3 THEN 'refunded' ELSE status END WHERE id = $1`, [r.inv.id, amount, r.items.length === 1]);
      if (it.p.track) await ledger(r.b, it.p, 'returned', it.qty, ts(date, 18), { invoiceId: r.inv.id, refundId: rf.id, reason: 'Customer return' });
    }

    for (const [k, qty] of Object.entries(stock)) {
      const [b, p] = k.split(':');
      const prod = products.find((x) => x.id === p)!;
      await q(`INSERT INTO product_stock (product_id, branch_id, quantity, low_notified_at) VALUES ($1,$2,$3,$4)`, [p, b, qty, qty <= prod.low ? new Date() : null]);
    }
    for (const b of branches) {
      for (const p of tracked.filter((x) => (stock[key(b.id, x.id)] ?? 0) <= x.low)) {
        await q(
          `INSERT INTO notifications (organization_id, branch_id, audience, type, priority, title, body, entity_type, entity_id, created_at)
           VALUES ($1,$2,'staff','inventory.low',$3,$4,$5,'product',$6, now() - interval '3 hours')`,
          [org.id, b.id, stock[key(b.id, p.id)] === 0 ? 'high' : 'normal', `${stock[key(b.id, p.id)] === 0 ? 'Out of stock' : 'Low stock'}: ${p.name}`,
            `${stock[key(b.id, p.id)]} left at ${b.name} (alert at ${p.low}). SKU ${p.sku}`, p.id],
        );
      }
    }

    // ------------------------------------------------------------ expenses --
    for (let mo = 6; mo >= 0; mo--) {
      const first = addToDate(`${now.slice(0, 8)}01`, 'month', -mo);
      const at = (day: number) => {
        const d = addToDate(first, 'day', day - 1);
        return d <= now ? d : null;
      };
      for (const b of branches) {
        const code = String(b.code).slice(0, 3).toUpperCase();
        const rentOn = at(3);
        if (rentOn) await expense(b.id, 'rent', RENT[code] ?? 75000, rentOn, { vendor: `${b.name} property owner`, description: `Rent — ${b.name}` });
        const power = at(9);
        if (power) await expense(b.id, 'utilities', int(22, 34) * 1000 + int(0, 999), power, { vendor: 'BESCOM', description: 'Electricity' });
        const water = at(12);
        if (water) await expense(b.id, 'utilities', int(3, 5) * 1000 + 499, water, { vendor: 'ACT Fibernet & BWSSB', description: 'Internet and water', method: 'upi' });
        for (let k = 0; k < int(0, 2); k++) {
          const on = at(int(4, 27));
          if (on) await expense(b.id, 'maintenance', int(3, 22) * 1000, on, {
            vendor: pick(['CoolAir Services', 'ProFit Equipment Care', 'Sparkle Housekeeping', 'Sharma Electricals']),
            description: pick(['AC servicing', 'Treadmill belt replacement', 'Deep cleaning', 'Cable machine repair', 'Plumbing repair']), method: pick(['upi', 'cash', 'bank_transfer']),
          });
        }
        if (rand() < 0.7) {
          const on = at(int(5, 20));
          if (on) await expense(b.id, 'marketing', int(6, 22) * 1000, on, { vendor: pick(['Meta Ads', 'Google Ads', 'Print Hub', 'Society event sponsorship']), description: pick(['Instagram lead campaign', 'Flyers and standees', 'Search ads', 'Apartment fitness camp']), method: 'card' });
        }
        if (rand() < 0.12) {
          const on = at(int(5, 25));
          if (on) await expense(b.id, 'equipment', int(25, 90) * 1000, on, { vendor: 'FitGear Wholesale', supplierId: supplierIds[2], description: pick(['Dumbbell set 2.5–25 kg', 'Commercial spin bike', 'Plate-loaded hack squat', 'Rubber flooring tiles']) });
        }
        const misc = at(int(10, 25));
        if (misc) await expense(b.id, 'other', int(2, 6) * 1000, misc, { vendor: 'Local vendors', description: pick(['Pantry and cleaning supplies', 'Printer cartridges', 'First-aid restock']), method: 'cash' });
      }
      // Salaries for the previous month, paid on the 1st.
      if (mo > 0) {
        const month = addToDate(first, 'month', -0);
        const payDay = addToDate(month, 'month', 1);
        if (payDay <= now) {
          for (const st of staff.filter((x: any) => x.salary)) {
            await expense(st.branch_id ?? branches[0].id, 'salaries', st.salary, payDay, {
              vendor: st.full_name, employeeId: st.id, salaryMonth: month,
              description: `Salary for ${new Date(`${month}T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })}`,
            });
          }
        }
      }
    }

    // ------------------------------------------------------------ referrals --
    // Members who came in through a referral get linked to a member who joined earlier.
    const referred = await q(
      `SELECT m.id, m.branch_id, m.join_date, u.full_name, u.phone FROM members m JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = $1 AND m.source = 'Referral' AND NOT EXISTS (SELECT 1 FROM referrals r WHERE r.referred_member_id = m.id)
        ORDER BY m.join_date`,
      [org.id],
    );
    const pool_ = await q(`SELECT id, branch_id, join_date FROM members WHERE organization_id = $1`, [org.id]);
    // A handful of loyal members bring in most referrals.
    const champions = new Map<string, string[]>();
    for (const b of branches) champions.set(b.id, pool_.filter((m: any) => m.branch_id === b.id).sort(() => rand() - 0.5).slice(0, 6).map((m: any) => m.id));
    for (const m of referred) {
      const candidates = pool_.filter((x: any) => x.branch_id === m.branch_id && x.join_date < m.join_date && x.id !== m.id);
      if (!candidates.length) continue;
      const champs = (champions.get(m.branch_id) ?? []).filter((id) => candidates.some((x: any) => x.id === id));
      const referrer = champs.length && rand() < 0.6 ? pick(champs) : pick(candidates).id;
      const paid = await one(
        `SELECT min(p.paid_at) AS at FROM invoices i JOIN invoice_items ii ON ii.invoice_id = i.id JOIN payments p ON p.invoice_id = i.id
          WHERE i.member_id = $1 AND i.status = 'paid' AND ii.membership_id IS NOT NULL`,
        [m.id],
        c,
      );
      const status = !paid?.at ? 'joined' : rand() < 0.9 ? 'rewarded' : 'verified';
      const [r] = await q(
        `INSERT INTO referrals (organization_id, branch_id, referrer_member_id, referred_name, referred_phone, referred_member_id, status, source, joined_at, verified_at, rewarded_at,
                                reward_points, referee_points, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'member',$8::date,$9,$10,$11,$12,$8::date - 3) RETURNING id`,
        [org.id, m.branch_id, referrer, m.full_name, m.phone, m.id, status, m.join_date, paid?.at ?? null, status === 'rewarded' ? paid!.at : null,
          status === 'rewarded' ? settings.referralPoints : null, status === 'rewarded' ? settings.refereePoints : null],
      );
      await q(`UPDATE members SET referred_by_member_id = $2 WHERE id = $1`, [m.id, referrer]);
      if (status === 'rewarded') {
        await q(
          `INSERT INTO loyalty_transactions (organization_id, member_id, branch_id, reason, points, source_key, description, created_at) VALUES
             ($1,$2,$3,'referral',$4,$5,$6,$7), ($1,$8,$3,'referral_welcome',$9,$5,'Welcome bonus for joining through a referral',$7)`,
          [org.id, referrer, m.branch_id, settings.referralPoints, `referral:${r.id}`, `Referral reward — ${m.full_name} joined`, paid!.at, m.id, settings.refereePoints],
        );
      }
    }
    // On a fresh database the migration ran before any leads existed.
    await q(
      `INSERT INTO referrals (organization_id, branch_id, referrer_member_id, referred_name, referred_phone, lead_id, referred_member_id, status, source, joined_at, created_at)
       SELECT l.organization_id, l.branch_id, l.referred_by_member_id, l.full_name, l.phone, l.id,
              CASE WHEN l.converted_member_id <> l.referred_by_member_id THEN l.converted_member_id END,
              CASE WHEN l.converted_member_id IS NOT NULL AND l.converted_member_id <> l.referred_by_member_id THEN 'joined'
                   WHEN l.stage = 'lost' THEN 'rejected' ELSE 'pending' END,
              'lead', l.converted_at, l.created_at
         FROM leads l
        WHERE l.organization_id = $1 AND l.referred_by_member_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM referrals r WHERE r.referred_member_id = l.converted_member_id)
       ON CONFLICT DO NOTHING`,
      [org.id],
    );
    await q(`UPDATE referrals SET rejected_reason = 'Lead lost' WHERE organization_id = $1 AND status = 'rejected' AND rejected_reason IS NULL`, [org.id]);
    await q(`UPDATE members m SET referred_by_member_id = r.referrer_member_id FROM referrals r WHERE r.referred_member_id = m.id AND m.referred_by_member_id IS NULL`);
    // Lead referrals that converted and paid are verified and rewarded.
    const fromLeads = await q(
      `SELECT r.id, r.referrer_member_id, r.referred_member_id, r.referred_name, r.branch_id,
              (SELECT min(p.paid_at) FROM invoices i JOIN invoice_items ii ON ii.invoice_id = i.id JOIN payments p ON p.invoice_id = i.id
                WHERE i.member_id = r.referred_member_id AND i.status = 'paid' AND ii.membership_id IS NOT NULL) AS paid_at
         FROM referrals r WHERE r.organization_id = $1 AND r.status = 'joined' AND r.source = 'lead'`,
      [org.id],
    );
    for (const [i, r] of fromLeads.entries()) {
      if (!r.paid_at || i % 4 === 0) continue; // a few left for staff to verify
      await q(`UPDATE referrals SET status = 'rewarded', verified_at = $2, rewarded_at = $2, reward_points = $3, referee_points = $4 WHERE id = $1`, [r.id, r.paid_at, settings.referralPoints, settings.refereePoints]);
      await q(
        `INSERT INTO loyalty_transactions (organization_id, member_id, branch_id, reason, points, source_key, description, created_at) VALUES
           ($1,$2,$3,'referral',$4,$5,$6,$7), ($1,$8,$3,'referral_welcome',$9,$5,'Welcome bonus for joining through a referral',$7)`,
        [org.id, r.referrer_member_id, r.branch_id, settings.referralPoints, `referral:${r.id}`, `Referral reward — ${r.referred_name} joined`, r.paid_at, r.referred_member_id, settings.refereePoints],
      );
    }

    for (const [k, v] of Object.entries(counters)) {
      await q(`INSERT INTO counters (organization_id, key, value) VALUES ($1,$2,$3) ON CONFLICT (organization_id, key) DO UPDATE SET value = EXCLUDED.value`, [org.id, k, v]);
    }
    console.log(`Business data: ${products.length} products, ${salesCount} POS sales, ${refundable.length} returns, expenses and loyalty seeded.`);
  });
}
