import crypto from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import express, { Router, type Request } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { config } from '../../config.js';
import { one, pool, query, tx, type Db } from '../../db/pool.js';
import { assertBranch, auth, branchScope, can } from '../../lib/auth.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { isoDate, paginationSchema, paged, uuid } from '../../lib/http.js';
import { documentNumber, PAYMENT_METHODS } from '../billing/service.js';
import { sniffImage } from '../fitness/service.js';

const DEFAULT_CATEGORIES = [
  ['rent', 'Rent'], ['utilities', 'Utilities'], ['salaries', 'Salaries'], ['maintenance', 'Maintenance'],
  ['marketing', 'Marketing'], ['equipment', 'Equipment'], ['inventory', 'Inventory'], ['other', 'Other'],
] as const;

/** System categories exist for every organisation; returns key → id. */
export async function ensureExpenseCategories(db: Db, orgId: string): Promise<Record<string, string>> {
  for (const [i, [key, name]] of DEFAULT_CATEGORIES.entries()) {
    await db.query(
      `INSERT INTO expense_categories (organization_id, key, name, is_system, sort) VALUES ($1,$2,$3,true,$4) ON CONFLICT (organization_id, key) DO NOTHING`,
      [orgId, key, name, i + 1],
    );
  }
  const rows = await query(`SELECT id, key FROM expense_categories WHERE organization_id = $1`, [orgId], db);
  return Object.fromEntries(rows.map((r) => [r.key, r.id]));
}

export interface ExpenseInput {
  branchId: string;
  categoryId: string;
  amount: number;
  expenseDate?: string | null;
  vendor?: string | null;
  supplierId?: string | null;
  employeeId?: string | null;
  salaryMonth?: string | null;
  method: (typeof PAYMENT_METHODS)[number];
  reference?: string | null;
  description?: string | null;
}

export async function createExpense(c: PoolClient, req: Request, e: ExpenseInput) {
  assertBranch(req, e.branchId);
  const orgId = auth(req).orgId;
  const cat = await one(`SELECT name, is_active FROM expense_categories WHERE id = $1 AND organization_id = $2`, [e.categoryId, orgId], c);
  if (!cat) throw badRequest('Unknown expense category');
  if (!cat.is_active) throw badRequest(`The ${cat.name} category is archived`);
  if ((e.method === 'upi' || e.method === 'bank_transfer') && !e.reference?.trim()) throw badRequest('Enter the UPI / bank transaction reference');
  if (e.salaryMonth) {
    const dup = await one(`SELECT expense_number FROM expenses WHERE employee_id = $1 AND salary_month = $2 AND status = 'recorded'`, [e.employeeId, e.salaryMonth], c);
    if (dup) throw conflict(`Salary for this month is already recorded (${dup.expense_number})`);
  }
  const number = await documentNumber(c, orgId, 'EXP', 'expense');
  const row = await one(
    `INSERT INTO expenses (organization_id, branch_id, category_id, expense_number, amount, expense_date, vendor, supplier_id, employee_id, salary_month, method, reference, description, recorded_by)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6::date, current_date),$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [orgId, e.branchId, e.categoryId, number, e.amount, e.expenseDate ?? null, e.vendor ?? null, e.supplierId ?? null, e.employeeId ?? null, e.salaryMonth ?? null,
      e.method, e.reference?.trim() || null, e.description ?? null, auth(req).userId],
    c,
  );
  await audit(c, req, {
    action: 'expense.recorded', entityType: 'expense', entityId: row.id, branchId: e.branchId,
    summary: `${cat.name} expense ${number} of ₹${e.amount.toLocaleString('en-IN')}${e.vendor ? ` to ${e.vendor}` : ''}`,
    after: { amount: e.amount, category: cat.name, method: e.method, vendor: e.vendor },
  });
  return row;
}

export const expensesRouter = Router();

// ------------------------------------------------------------- categories ----

expensesRouter.get('/categories', can('expenses.read'), async (req, res) => {
  await ensureExpenseCategories(pool, auth(req).orgId);
  res.json(await query(
    `SELECT c.*, (SELECT COALESCE(sum(e.amount), 0) FROM expenses e WHERE e.category_id = c.id AND e.status = 'recorded'
                    AND e.expense_date >= date_trunc('month', current_date) AND e.branch_id = ANY($2)) AS this_month
       FROM expense_categories c WHERE c.organization_id = $1 ORDER BY c.sort, c.name`,
    [auth(req).orgId, branchScope(req)],
  ));
});

expensesRouter.post('/categories', can('expenses.manage'), async (req, res) => {
  const { name } = z.object({ name: z.string().trim().min(2).max(60) }).parse(req.body);
  const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const row = await one(
    `INSERT INTO expense_categories (organization_id, key, name, sort) VALUES ($1,$2,$3,100) ON CONFLICT (organization_id, key) DO NOTHING RETURNING *`,
    [auth(req).orgId, key, name],
  );
  if (!row) throw conflict('That category already exists');
  await audit(pool, req, { action: 'expense_category.created', entityType: 'expense_category', entityId: row.id, summary: `Expense category ${name} added` });
  res.status(201).json(row);
});

expensesRouter.put('/categories/:id', can('expenses.manage'), async (req, res) => {
  const b = z.object({ name: z.string().trim().min(2).max(60), isActive: z.boolean() }).parse(req.body);
  const id = uuid.parse(req.params.id);
  const cat = await one(`SELECT * FROM expense_categories WHERE id = $1 AND organization_id = $2`, [id, auth(req).orgId]);
  if (!cat) throw notFound('Category');
  if (cat.is_system && !b.isActive) throw badRequest('Built-in categories can be renamed but not archived');
  await pool.query(`UPDATE expense_categories SET name = $2, is_active = $3 WHERE id = $1`, [id, b.name, b.isActive]);
  await audit(pool, req, { action: 'expense_category.updated', entityType: 'expense_category', entityId: id, summary: `Expense category ${cat.name} → ${b.name}${b.isActive ? '' : ' (archived)'}` });
  res.status(204).end();
});

// --------------------------------------------------------------- expenses ----

const listSchema = paginationSchema.extend({
  search: z.string().trim().optional(),
  categoryId: uuid.optional(),
  method: z.enum(PAYMENT_METHODS).optional(),
  status: z.enum(['recorded', 'voided']).optional(),
  employeeId: uuid.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

expensesRouter.get('/', can('expenses.read'), async (req, res) => {
  const q = listSchema.parse(req.query);
  const params: unknown[] = [auth(req).orgId, branchScope(req)];
  const where = [`e.organization_id = $1`, `e.branch_id = ANY($2)`];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replaceAll('$?', `$${params.length}`)); };
  if (q.search) add(`(e.vendor ILIKE $? OR e.description ILIKE $? OR e.expense_number ILIKE $? OR e.reference ILIKE $?)`, `%${q.search}%`);
  if (q.categoryId) add(`e.category_id = $?`, q.categoryId);
  if (q.method) add(`e.method = $?`, q.method);
  if (q.status) add(`e.status = $?`, q.status);
  if (q.employeeId) add(`e.employee_id = $?`, q.employeeId);
  if (q.from) add(`e.expense_date >= $?::date`, q.from);
  if (q.to) add(`e.expense_date <= $?::date`, q.to);
  // Salary rows name the employee and amount; only payroll viewers see them.
  if (!auth(req).permissions.has('staff.salary')) where.push(`e.salary_month IS NULL`);
  params.push(q.pageSize, (q.page - 1) * q.pageSize);
  const rows = await query(
    `SELECT e.id, e.expense_number, e.amount, e.expense_date, e.vendor, e.method, e.reference, e.description, e.status, e.void_reason,
            e.salary_month, e.receipt_type IS NOT NULL AS has_receipt, e.created_at,
            c.name AS category_name, c.key AS category_key, b.name AS branch_name, ru.full_name AS recorded_by_name, eu.full_name AS employee_name,
            s.name AS supplier_name, count(*) OVER() AS total_count,
            sum(e.amount) FILTER (WHERE e.status = 'recorded') OVER() AS total_amount
       FROM expenses e JOIN expense_categories c ON c.id = e.category_id JOIN branches b ON b.id = e.branch_id
       LEFT JOIN users ru ON ru.id = e.recorded_by LEFT JOIN users eu ON eu.id = e.employee_id LEFT JOIN suppliers s ON s.id = e.supplier_id
      WHERE ${where.join(' AND ')}
      ORDER BY e.expense_date DESC, e.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const totalAmount = rows[0]?.total_amount ?? 0;
  res.json({ ...paged(rows.map(({ total_amount, ...r }) => r), q.page, q.pageSize), summary: { totalAmount } });
});

const expenseSchema = z.object({
  branchId: uuid,
  categoryId: uuid,
  amount: z.coerce.number().positive().max(10_000_000),
  expenseDate: isoDate.optional().nullable(),
  vendor: z.string().trim().max(120).optional().nullable(),
  supplierId: uuid.optional().nullable(),
  method: z.enum(PAYMENT_METHODS),
  reference: z.string().trim().max(80).optional().nullable(),
  description: z.string().trim().max(1000).optional().nullable(),
});

expensesRouter.post('/', can('expenses.manage'), async (req, res) => {
  const b = expenseSchema.parse(req.body);
  const cat = await one(`SELECT key FROM expense_categories WHERE id = $1 AND organization_id = $2`, [b.categoryId, auth(req).orgId]);
  // Salaries go through the employee screen so they're tied to a person and month.
  if (cat?.key === 'salaries') throw badRequest('Record salaries from the employee’s profile');
  if (b.expenseDate && b.expenseDate > new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })) throw badRequest('Expense date cannot be in the future');
  res.status(201).json(await tx((c) => createExpense(c, req, b)));
});

expensesRouter.post('/:id/void', can('expenses.manage'), async (req, res) => {
  const { reason } = z.object({ reason: z.string().trim().min(3) }).parse(req.body);
  const id = uuid.parse(req.params.id);
  await tx(async (c) => {
    const e = await one(`SELECT * FROM expenses WHERE id = $1 AND organization_id = $2 FOR UPDATE`, [id, auth(req).orgId], c);
    if (!e || !auth(req).branchIds.includes(e.branch_id)) throw notFound('Expense');
    if (e.salary_month && !auth(req).permissions.has('staff.salary')) throw notFound('Expense');
    if (e.status === 'voided') throw conflict('Already voided');
    await c.query(`UPDATE expenses SET status = 'voided', void_reason = $2, updated_at = now() WHERE id = $1`, [id, reason]);
    await audit(c, req, {
      action: 'expense.voided', entityType: 'expense', entityId: id, branchId: e.branch_id,
      summary: `Expense ${e.expense_number} of ₹${e.amount.toLocaleString('en-IN')} voided: ${reason}`, before: { status: 'recorded' }, after: { status: 'voided', reason },
    });
  });
  res.status(204).end();
});

// ---------------------------------------------------------------- receipts ----

const MAX_RECEIPT = 8 * 1024 * 1024;
const rawReceipt = express.raw({ type: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'application/octet-stream'], limit: MAX_RECEIPT + 1024 });
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
const receiptDir = () => path.join(config.uploadDir, 'receipts');

expensesRouter.post('/:id/receipt', can('expenses.manage'), rawReceipt, async (req, res) => {
  const id = uuid.parse(req.params.id);
  const body: Buffer = req.body;
  if (!Buffer.isBuffer(body) || !body.length) throw badRequest('Attach the receipt');
  const type = sniffImage(body) ?? (body.subarray(0, 5).toString('ascii') === '%PDF-' ? 'application/pdf' : null);
  if (!type) throw badRequest('Receipts must be a JPEG, PNG, WebP or PDF');
  const e = await one(`SELECT * FROM expenses WHERE id = $1 AND organization_id = $2`, [id, auth(req).orgId]);
  if (!e || !auth(req).branchIds.includes(e.branch_id)) throw notFound('Expense');
  const key = `${crypto.randomUUID()}.${EXT[type]}`;
  await mkdir(receiptDir(), { recursive: true });
  await writeFile(path.join(receiptDir(), key), body, { mode: 0o600 });
  try {
    await tx(async (c) => {
      await c.query(`UPDATE expenses SET receipt_key = $2, receipt_type = $3, receipt_size = $4, updated_at = now() WHERE id = $1`, [id, key, type, body.length]);
      await audit(c, req, { action: 'expense.receipt', entityType: 'expense', entityId: id, branchId: e.branch_id, summary: `Receipt attached to ${e.expense_number}` });
    });
  } catch (err) {
    await unlink(path.join(receiptDir(), key)).catch(() => {});
    throw err;
  }
  if (e.receipt_key) await unlink(path.join(receiptDir(), path.basename(e.receipt_key))).catch(() => {});
  res.status(201).json({ ok: true });
});

expensesRouter.get('/:id/receipt', can('expenses.read'), async (req, res) => {
  const e = await one(`SELECT * FROM expenses WHERE id = $1 AND organization_id = $2`, [uuid.parse(req.params.id), auth(req).orgId]);
  if (!e || !auth(req).branchIds.includes(e.branch_id) || !e.receipt_key) throw notFound('Receipt');
  if (e.salary_month && !auth(req).permissions.has('staff.salary')) throw notFound('Receipt');
  const file = await readFile(path.join(receiptDir(), path.basename(e.receipt_key))).catch(() => null);
  if (!file) throw notFound('Receipt');
  res.setHeader('Content-Type', e.receipt_type);
  res.setHeader('Content-Disposition', `inline; filename="${e.expense_number}.${EXT[e.receipt_type]}"`);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(file);
});

// ------------------------------------------------------------ profit & loss ----

/**
 * Cash-basis P&L per month: money collected (net of refunds) against money
 * spent. Product cost of goods sold is shown separately for margin, since
 * stock purchases already appear as Inventory expenses.
 */
expensesRouter.get('/pnl', can('expenses.read'), async (req, res) => {
  const { months } = z.object({ months: z.coerce.number().int().refine((m) => [3, 6, 12].includes(m)).default(6) }).parse(req.query);
  const scope = [auth(req).orgId, branchScope(req), months];
  const [series, categories, cogs] = await Promise.all([
    query(
      `SELECT to_char(m, 'YYYY-MM-01') AS date,
              COALESCE((SELECT sum(amount) FROM payments p WHERE p.organization_id = $1 AND p.branch_id = ANY($2) AND p.status = 'recorded'
                         AND p.paid_at >= m AND p.paid_at < m + interval '1 month'), 0)
            - COALESCE((SELECT sum(amount) FROM refunds r WHERE r.organization_id = $1 AND r.branch_id = ANY($2)
                         AND r.created_at >= m AND r.created_at < m + interval '1 month'), 0) AS revenue,
              COALESCE((SELECT sum(amount) FROM expenses e WHERE e.organization_id = $1 AND e.branch_id = ANY($2) AND e.status = 'recorded'
                         AND e.expense_date >= m AND e.expense_date < m + interval '1 month'), 0) AS expenses
         FROM generate_series(date_trunc('month', current_date) - make_interval(months => $3::int - 1), date_trunc('month', current_date), interval '1 month') m
        ORDER BY m`,
      scope,
    ),
    query(
      `SELECT c.id, c.name, c.key, COALESCE(sum(e.amount), 0) AS amount
         FROM expense_categories c LEFT JOIN expenses e ON e.category_id = c.id AND e.status = 'recorded' AND e.branch_id = ANY($2)
              AND e.expense_date >= date_trunc('month', current_date) - make_interval(months => $3::int - 1)
        WHERE c.organization_id = $1 GROUP BY c.id HAVING COALESCE(sum(e.amount), 0) > 0 ORDER BY amount DESC`,
      scope,
    ),
    one(
      `SELECT COALESCE(sum((ii.quantity - ii.returned_qty) * (ii.amount / NULLIF(ii.quantity, 0))), 0) AS product_revenue,
              COALESCE(sum((ii.quantity - ii.returned_qty) * COALESCE(ii.unit_cost, 0)), 0) AS product_cost
         FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
        WHERE ii.product_id IS NOT NULL AND i.organization_id = $1 AND i.branch_id = ANY($2) AND i.status <> 'void'
          AND i.created_at >= date_trunc('month', current_date) - make_interval(months => $3::int - 1)`,
      scope,
    ),
  ]);
  const totals = series.reduce((s, r) => ({ revenue: s.revenue + Number(r.revenue), expenses: s.expenses + Number(r.expenses) }), { revenue: 0, expenses: 0 });
  res.json({ series: series.map((r) => ({ ...r, profit: Number(r.revenue) - Number(r.expenses) })), categories, cogs, totals: { ...totals, profit: totals.revenue - totals.expenses } });
});
