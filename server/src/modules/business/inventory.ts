import { Router, type Request } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { one, query, tx } from '../../db/pool.js';
import { assertBranch, auth, branchScope, can } from '../../lib/auth.js';
import { audit, notify } from '../../lib/audit.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { isoDate, paginationSchema, paged, uuid } from '../../lib/http.js';
import { PAYMENT_METHODS } from '../billing/service.js';
import { createExpense, ensureExpenseCategories } from './expenses.js';

export const PRODUCT_CATEGORIES = ['supplements', 'merchandise', 'food_beverage', 'accessories', 'services'] as const;
export const MOVEMENT_TYPES = ['stock_in', 'stock_out', 'adjustment', 'damaged', 'sold', 'returned', 'transfer_in', 'transfer_out'] as const;
type MovementType = (typeof MOVEMENT_TYPES)[number];

/**
 * The only way stock changes: locks the branch row, applies the signed change,
 * refuses to go negative, writes the ledger and raises a low-stock alert the
 * first time stock falls to the product's threshold.
 */
export async function moveStock(
  c: PoolClient,
  ctx: { orgId: string; userId: string },
  m: {
    branchId: string; productId: string; type: MovementType; quantity: number; unitCost?: number | null; supplierId?: string | null;
    invoiceId?: string | null; refundId?: string | null; expenseId?: string | null; transferBranchId?: string | null; reason?: string | null;
  },
) {
  const product = await one(`SELECT id, name, sku, track_stock, low_stock_threshold FROM products WHERE id = $1 AND organization_id = $2`, [m.productId, ctx.orgId], c);
  if (!product) throw notFound('Product');
  if (!product.track_stock) return null;
  if (!m.quantity) throw badRequest('Quantity cannot be zero');
  await c.query(`INSERT INTO product_stock (product_id, branch_id, quantity) VALUES ($1,$2,0) ON CONFLICT DO NOTHING`, [m.productId, m.branchId]);
  const stock = await one(`SELECT * FROM product_stock WHERE product_id = $1 AND branch_id = $2 FOR UPDATE`, [m.productId, m.branchId], c);
  const next = stock!.quantity + m.quantity;
  if (next < 0) throw conflict(`Only ${stock!.quantity} × ${product.name} in stock at this branch`);
  const low = next <= product.low_stock_threshold;
  await c.query(
    `UPDATE product_stock SET quantity = $3, updated_at = now(),
            low_notified_at = CASE WHEN $4 THEN COALESCE(low_notified_at, now()) ELSE NULL END
      WHERE product_id = $1 AND branch_id = $2`,
    [m.productId, m.branchId, next, low],
  );
  const row = await one(
    `INSERT INTO inventory_transactions (organization_id, branch_id, product_id, type, quantity, balance_after, unit_cost, supplier_id, invoice_id, refund_id, expense_id, transfer_branch_id, reason, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [ctx.orgId, m.branchId, m.productId, m.type, m.quantity, next, m.unitCost ?? null, m.supplierId ?? null, m.invoiceId ?? null, m.refundId ?? null,
      m.expenseId ?? null, m.transferBranchId ?? null, m.reason ?? null, ctx.userId],
    c,
  );
  if (low && !stock!.low_notified_at && m.quantity < 0) {
    await notify(c, {
      orgId: ctx.orgId, branchId: m.branchId, type: 'inventory.low', priority: next === 0 ? 'high' : 'normal',
      title: next === 0 ? `Out of stock: ${product.name}` : `Low stock: ${product.name}`,
      body: `${next} left (alert at ${product.low_stock_threshold}). SKU ${product.sku}`, entityType: 'product', entityId: product.id,
    });
  }
  return row;
}

export const inventoryRouter = Router();

// --------------------------------------------------------------- products ----

const productSchema = z.object({
  sku: z.string().trim().min(2).max(40).transform((v) => v.toUpperCase()),
  barcode: z.string().trim().max(40).optional().nullable().transform((v) => v || null),
  name: z.string().trim().min(2).max(120),
  category: z.enum(PRODUCT_CATEGORIES),
  brand: z.string().trim().max(80).optional().nullable(),
  description: z.string().trim().max(1000).optional().nullable(),
  costPrice: z.coerce.number().min(0).default(0),
  sellingPrice: z.coerce.number().min(0),
  taxRate: z.coerce.number().min(0).max(40).default(0),
  trackStock: z.boolean().default(true),
  lowStockThreshold: z.coerce.number().int().min(0).default(5),
  supplierId: uuid.optional().nullable(),
  isActive: z.boolean().default(true),
});

const productSelect = (stockScope: string) => `
  SELECT p.*, s.name AS supplier_name,
         COALESCE((SELECT sum(ps.quantity) FROM product_stock ps WHERE ps.product_id = p.id AND ps.branch_id = ANY(${stockScope})), 0)::int AS stock,
         COALESCE((SELECT json_agg(json_build_object('branch_id', b.id, 'branch_name', b.name, 'quantity', COALESCE(ps.quantity, 0)) ORDER BY b.name)
                     FROM branches b LEFT JOIN product_stock ps ON ps.branch_id = b.id AND ps.product_id = p.id
                    WHERE b.id = ANY(${stockScope})), '[]') AS branches,
         COALESCE((SELECT sum(ii.quantity - ii.returned_qty) FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
                    WHERE ii.product_id = p.id AND i.branch_id = ANY(${stockScope}) AND i.status <> 'void' AND i.created_at >= current_date - 29), 0)::int AS sold_30d
    FROM products p LEFT JOIN suppliers s ON s.id = p.supplier_id`;

inventoryRouter.get('/products', can('inventory.read'), async (req, res) => {
  const q = paginationSchema.extend({
    search: z.string().trim().optional(),
    category: z.enum(PRODUCT_CATEGORIES).optional(),
    stock: z.enum(['low', 'out', 'ok']).optional(),
    supplierId: uuid.optional(),
    includeInactive: z.coerce.boolean().optional(),
  }).parse(req.query);
  const params: unknown[] = [auth(req).orgId, branchScope(req)];
  const where = [`p.organization_id = $1`];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replaceAll('$?', `$${params.length}`)); };
  if (q.search) add(`(p.name ILIKE $? OR p.sku ILIKE $? OR p.barcode = $?::text OR p.brand ILIKE $?)`, `%${q.search}%`);
  if (q.category) add(`p.category = $?`, q.category);
  if (q.supplierId) add(`p.supplier_id = $?`, q.supplierId);
  if (!q.includeInactive) where.push(`p.is_active`);
  const stockFilter = q.stock === 'out' ? `AND x.track_stock AND x.stock = 0`
    : q.stock === 'low' ? `AND x.track_stock AND x.stock <= x.low_stock_threshold`
    : q.stock === 'ok' ? `AND (NOT x.track_stock OR x.stock > x.low_stock_threshold)` : '';
  params.push(q.pageSize, (q.page - 1) * q.pageSize);
  const rows = await query(
    `SELECT x.*, count(*) OVER() AS total_count FROM (${productSelect('$2')} WHERE ${where.join(' AND ')}) x
      WHERE true ${stockFilter}
      ORDER BY (x.track_stock AND x.stock <= x.low_stock_threshold) DESC, x.category, x.name
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  res.json(paged(rows, q.page, q.pageSize));
});

inventoryRouter.get('/products/:id', can('inventory.read'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const product = await one(`${productSelect('$3')} WHERE p.id = $1 AND p.organization_id = $2`, [id, auth(req).orgId, branchScope(req)]);
  if (!product) throw notFound('Product');
  const [movements, monthly] = await Promise.all([
    query(
      `SELECT t.*, b.name AS branch_name, tb.name AS transfer_branch_name, u.full_name AS created_by_name, s.name AS supplier_name, i.invoice_number
         FROM inventory_transactions t JOIN branches b ON b.id = t.branch_id
         LEFT JOIN branches tb ON tb.id = t.transfer_branch_id LEFT JOIN users u ON u.id = t.created_by
         LEFT JOIN suppliers s ON s.id = t.supplier_id LEFT JOIN invoices i ON i.id = t.invoice_id
        WHERE t.product_id = $1 AND t.branch_id = ANY($2) ORDER BY t.created_at DESC LIMIT 60`,
      [id, branchScope(req)],
    ),
    query(
      `SELECT to_char(m, 'YYYY-MM-01') AS date,
              COALESCE((SELECT sum(ii.quantity - ii.returned_qty) FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
                         WHERE ii.product_id = $1 AND i.branch_id = ANY($2) AND i.status <> 'void'
                           AND i.created_at >= m AND i.created_at < m + interval '1 month'), 0)::int AS value
         FROM generate_series(date_trunc('month', current_date) - interval '5 months', date_trunc('month', current_date), interval '1 month') m`,
      [id, branchScope(req)],
    ),
  ]);
  res.json({ ...product, movements, monthly });
});

inventoryRouter.post('/products', can('inventory.manage'), async (req, res) => {
  const b = productSchema.extend({ openingStock: z.coerce.number().int().min(0).default(0), branchId: uuid.optional() }).parse(req.body);
  const row = await tx(async (c) => {
    const dup = await one(`SELECT id FROM products WHERE organization_id = $1 AND sku = $2`, [auth(req).orgId, b.sku], c);
    if (dup) throw conflict(`SKU ${b.sku} is already used`);
    const p = await one(
      `INSERT INTO products (organization_id, sku, barcode, name, category, brand, description, cost_price, selling_price, tax_rate, track_stock, low_stock_threshold, supplier_id, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [auth(req).orgId, b.sku, b.barcode, b.name, b.category, b.brand ?? null, b.description ?? null, b.costPrice, b.sellingPrice, b.taxRate,
        b.trackStock && b.category !== 'services', b.lowStockThreshold, b.supplierId ?? null, b.isActive],
      c,
    );
    if (b.openingStock && p.track_stock) {
      const branchId = b.branchId ?? (branchScope(req).length === 1 ? branchScope(req)[0] : null);
      if (!branchId) throw badRequest('Pick the branch that holds the opening stock');
      assertBranch(req, branchId);
      await moveStock(c, { orgId: auth(req).orgId, userId: auth(req).userId }, { branchId, productId: p.id, type: 'stock_in', quantity: b.openingStock, unitCost: b.costPrice, reason: 'Opening stock' });
    }
    await audit(c, req, { action: 'product.created', entityType: 'product', entityId: p.id, summary: `Product ${b.name} (${b.sku}) added at ₹${b.sellingPrice}`, after: b });
    return p;
  });
  res.status(201).json(row);
});

inventoryRouter.put('/products/:id', can('inventory.manage'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const b = productSchema.parse(req.body);
  await tx(async (c) => {
    const before = await one(`SELECT * FROM products WHERE id = $1 AND organization_id = $2 FOR UPDATE`, [id, auth(req).orgId], c);
    if (!before) throw notFound('Product');
    const dup = await one(`SELECT id FROM products WHERE organization_id = $1 AND sku = $2 AND id <> $3`, [auth(req).orgId, b.sku, id], c);
    if (dup) throw conflict(`SKU ${b.sku} is already used`);
    const stocked = await one(`SELECT COALESCE(sum(quantity), 0)::int AS n FROM product_stock WHERE product_id = $1`, [id], c);
    if (before.track_stock && !b.trackStock && stocked!.n > 0) throw conflict('Write off or sell the remaining stock before turning off stock tracking');
    await c.query(
      `UPDATE products SET sku=$2, barcode=$3, name=$4, category=$5, brand=$6, description=$7, cost_price=$8, selling_price=$9, tax_rate=$10,
              track_stock=$11, low_stock_threshold=$12, supplier_id=$13, is_active=$14, updated_at=now() WHERE id=$1`,
      [id, b.sku, b.barcode, b.name, b.category, b.brand ?? null, b.description ?? null, b.costPrice, b.sellingPrice, b.taxRate,
        b.trackStock && b.category !== 'services', b.lowStockThreshold, b.supplierId ?? null, b.isActive],
    );
    const changed = Object.fromEntries(
      ([['selling_price', b.sellingPrice], ['cost_price', b.costPrice], ['name', b.name], ['is_active', b.isActive], ['low_stock_threshold', b.lowStockThreshold]] as const)
        .filter(([k, v]) => before[k] !== v),
    );
    await audit(c, req, {
      action: 'product.updated', entityType: 'product', entityId: id, summary: `Product ${b.name} updated`,
      before: Object.fromEntries(Object.keys(changed).map((k) => [k, before[k]])), after: changed,
    });
  });
  res.status(204).end();
});

// -------------------------------------------------------------- movements ----

const movementSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('stock_in'), productId: uuid, branchId: uuid, quantity: z.coerce.number().int().min(1), unitCost: z.coerce.number().min(0).optional().nullable(),
    supplierId: uuid.optional().nullable(), reason: z.string().trim().max(300).optional().nullable(),
    // Optionally book the purchase as an Inventory expense in the same step.
    expense: z.object({ method: z.enum(PAYMENT_METHODS), reference: z.string().trim().max(80).optional().nullable() }).optional().nullable(),
  }),
  z.object({ type: z.enum(['stock_out', 'damaged']), productId: uuid, branchId: uuid, quantity: z.coerce.number().int().min(1), reason: z.string().trim().min(3).max(300) }),
  z.object({ type: z.literal('adjustment'), productId: uuid, branchId: uuid, countedQuantity: z.coerce.number().int().min(0), reason: z.string().trim().min(3).max(300) }),
  z.object({ type: z.literal('transfer'), productId: uuid, branchId: uuid, toBranchId: uuid, quantity: z.coerce.number().int().min(1), reason: z.string().trim().max(300).optional().nullable() }),
]);

const TYPE_LABEL: Record<string, string> = { stock_in: 'Stock received', stock_out: 'Stock out', damaged: 'Written off (damaged)', adjustment: 'Stock count adjusted', transfer: 'Transferred' };

inventoryRouter.post('/movements', can('inventory.manage'), async (req, res) => {
  const b = movementSchema.parse(req.body);
  assertBranch(req, b.branchId);
  const ctx = { orgId: auth(req).orgId, userId: auth(req).userId };
  const result = await tx(async (c) => {
    const product = await one(`SELECT * FROM products WHERE id = $1 AND organization_id = $2`, [b.productId, ctx.orgId], c);
    if (!product) throw notFound('Product');
    if (!product.track_stock) throw badRequest(`${product.name} isn't stock-tracked`);
    let rows: any[] = [];
    let summary = '';
    if (b.type === 'stock_in') {
      const unitCost = b.unitCost ?? product.cost_price;
      let expenseId: string | null = null;
      if (b.expense) {
        if (!auth(req).permissions.has('expenses.manage')) throw badRequest('You cannot record expenses');
        const cats = await ensureExpenseCategories(c, ctx.orgId);
        const supplier = b.supplierId ? await one(`SELECT name FROM suppliers WHERE id = $1 AND organization_id = $2`, [b.supplierId, ctx.orgId], c) : null;
        const exp = await createExpense(c, req, {
          branchId: b.branchId, categoryId: cats.inventory, amount: Math.round(unitCost * b.quantity * 100) / 100, method: b.expense.method, reference: b.expense.reference ?? null,
          vendor: supplier?.name ?? null, supplierId: b.supplierId ?? null, description: `${b.quantity} × ${product.name} (${product.sku})`,
        });
        expenseId = exp.id;
      }
      rows = [await moveStock(c, ctx, { branchId: b.branchId, productId: b.productId, type: 'stock_in', quantity: b.quantity, unitCost, supplierId: b.supplierId, reason: b.reason, expenseId })];
      if (b.unitCost != null && b.unitCost !== product.cost_price) await c.query(`UPDATE products SET cost_price = $2, updated_at = now() WHERE id = $1`, [product.id, b.unitCost]);
      summary = `Received ${b.quantity} × ${product.name}`;
    } else if (b.type === 'stock_out' || b.type === 'damaged') {
      rows = [await moveStock(c, ctx, { branchId: b.branchId, productId: b.productId, type: b.type, quantity: -b.quantity, unitCost: product.cost_price, reason: b.reason })];
      summary = `${TYPE_LABEL[b.type]}: ${b.quantity} × ${product.name} — ${b.reason}`;
    } else if (b.type === 'adjustment') {
      const cur = await one(`SELECT quantity FROM product_stock WHERE product_id = $1 AND branch_id = $2`, [b.productId, b.branchId], c);
      const delta = b.countedQuantity - (cur?.quantity ?? 0);
      if (!delta) throw badRequest('The count matches the system stock — nothing to adjust');
      rows = [await moveStock(c, ctx, { branchId: b.branchId, productId: b.productId, type: 'adjustment', quantity: delta, unitCost: product.cost_price, reason: b.reason })];
      summary = `Stock count for ${product.name}: ${cur?.quantity ?? 0} → ${b.countedQuantity} (${b.reason})`;
    } else if (b.type === 'transfer') {
      if (b.toBranchId === b.branchId) throw badRequest('Pick a different destination branch');
      assertBranch(req, b.toBranchId);
      rows = [
        await moveStock(c, ctx, { branchId: b.branchId, productId: b.productId, type: 'transfer_out', quantity: -b.quantity, transferBranchId: b.toBranchId, reason: b.reason }),
        await moveStock(c, ctx, { branchId: b.toBranchId, productId: b.productId, type: 'transfer_in', quantity: b.quantity, transferBranchId: b.branchId, reason: b.reason }),
      ];
      summary = `Transferred ${b.quantity} × ${product.name} between branches`;
    }
    await audit(c, req, { action: `inventory.${b.type}`, entityType: 'product', entityId: product.id, branchId: b.branchId, summary, after: b });
    return rows;
  });
  res.status(201).json(result);
});

inventoryRouter.get('/movements', can('inventory.read'), async (req, res) => {
  const q = paginationSchema.extend({ productId: uuid.optional(), type: z.enum(MOVEMENT_TYPES).optional(), from: isoDate.optional(), to: isoDate.optional() }).parse(req.query);
  const params: unknown[] = [auth(req).orgId, branchScope(req)];
  const where = [`t.organization_id = $1`, `t.branch_id = ANY($2)`];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replaceAll('$?', `$${params.length}`)); };
  if (q.productId) add(`t.product_id = $?`, q.productId);
  if (q.type) add(`t.type = $?`, q.type);
  if (q.from) add(`t.created_at >= $?::date`, q.from);
  if (q.to) add(`t.created_at < $?::date + 1`, q.to);
  params.push(q.pageSize, (q.page - 1) * q.pageSize);
  const rows = await query(
    `SELECT t.*, p.name AS product_name, p.sku, b.name AS branch_name, tb.name AS transfer_branch_name, u.full_name AS created_by_name,
            s.name AS supplier_name, i.invoice_number, count(*) OVER() AS total_count
       FROM inventory_transactions t JOIN products p ON p.id = t.product_id JOIN branches b ON b.id = t.branch_id
       LEFT JOIN branches tb ON tb.id = t.transfer_branch_id LEFT JOIN users u ON u.id = t.created_by
       LEFT JOIN suppliers s ON s.id = t.supplier_id LEFT JOIN invoices i ON i.id = t.invoice_id
      WHERE ${where.join(' AND ')} ORDER BY t.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  res.json(paged(rows, q.page, q.pageSize));
});

inventoryRouter.get('/summary', can('inventory.read'), async (req, res) => {
  const scope = [auth(req).orgId, branchScope(req)];
  const [totals, byCategory, top, slow] = await Promise.all([
    one(
      `SELECT COALESCE(sum(ps.quantity * p.cost_price), 0) AS stock_value_cost,
              COALESCE(sum(ps.quantity * p.selling_price), 0) AS stock_value_retail,
              count(DISTINCT p.id) FILTER (WHERE p.is_active) AS products,
              (SELECT count(*) FROM (SELECT p2.id FROM products p2 LEFT JOIN product_stock s2 ON s2.product_id = p2.id AND s2.branch_id = ANY($2)
                 WHERE p2.organization_id = $1 AND p2.is_active AND p2.track_stock GROUP BY p2.id, p2.low_stock_threshold
                 HAVING COALESCE(sum(s2.quantity), 0) <= p2.low_stock_threshold AND COALESCE(sum(s2.quantity), 0) > 0) z) AS low,
              (SELECT count(*) FROM (SELECT p2.id FROM products p2 LEFT JOIN product_stock s2 ON s2.product_id = p2.id AND s2.branch_id = ANY($2)
                 WHERE p2.organization_id = $1 AND p2.is_active AND p2.track_stock GROUP BY p2.id HAVING COALESCE(sum(s2.quantity), 0) = 0) z) AS out
         FROM products p LEFT JOIN product_stock ps ON ps.product_id = p.id AND ps.branch_id = ANY($2)
        WHERE p.organization_id = $1`,
      scope,
    ),
    query(
      `SELECT p.category, COALESCE(sum((ii.quantity - ii.returned_qty) * (ii.amount / NULLIF(ii.quantity, 0))), 0) AS revenue,
              COALESCE(sum((ii.quantity - ii.returned_qty) * COALESCE(ii.unit_cost, p.cost_price)), 0) AS cost,
              COALESCE(sum(ii.quantity - ii.returned_qty), 0)::int AS units
         FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id JOIN products p ON p.id = ii.product_id
        WHERE i.organization_id = $1 AND i.branch_id = ANY($2) AND i.status <> 'void' AND i.created_at >= current_date - 29
        GROUP BY p.category ORDER BY revenue DESC`,
      scope,
    ),
    query(
      `SELECT p.id, p.name, p.sku, sum(ii.quantity - ii.returned_qty)::int AS units, sum((ii.quantity - ii.returned_qty) * (ii.amount / NULLIF(ii.quantity, 0))) AS revenue
         FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id JOIN products p ON p.id = ii.product_id
        WHERE i.organization_id = $1 AND i.branch_id = ANY($2) AND i.status <> 'void' AND i.created_at >= current_date - 29
        GROUP BY p.id HAVING sum(ii.quantity - ii.returned_qty) > 0 ORDER BY revenue DESC LIMIT 6`,
      scope,
    ),
    // Stock that hasn't sold in 60 days: cash tied up on the shelf.
    query(
      `SELECT p.id, p.name, p.sku, sum(ps.quantity)::int AS stock, sum(ps.quantity * p.cost_price) AS value,
              (SELECT max(i.created_at) FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE ii.product_id = p.id AND i.status <> 'void') AS last_sold_at
         FROM products p JOIN product_stock ps ON ps.product_id = p.id AND ps.branch_id = ANY($2)
        WHERE p.organization_id = $1 AND p.is_active AND p.track_stock
        GROUP BY p.id HAVING sum(ps.quantity) > 0 AND NOT EXISTS (
          SELECT 1 FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
           WHERE ii.product_id = p.id AND i.status <> 'void' AND i.branch_id = ANY($2) AND i.created_at >= current_date - 59)
        ORDER BY value DESC LIMIT 6`,
      scope,
    ),
  ]);
  res.json({ ...totals, byCategory, top, slow });
});

// -------------------------------------------------------------- suppliers ----

const supplierSchema = z.object({
  name: z.string().trim().min(2).max(120),
  contactName: z.string().trim().max(120).optional().nullable(),
  phone: z.string().trim().max(20).optional().nullable(),
  email: z.string().trim().email().optional().nullable().or(z.literal('').transform(() => null)),
  gstin: z.string().trim().max(20).optional().nullable(),
  notes: z.string().trim().max(1000).optional().nullable(),
  isActive: z.boolean().default(true),
});

inventoryRouter.get('/suppliers', can('inventory.read'), async (req, res) => {
  res.json(await query(
    `SELECT s.*, (SELECT count(*) FROM products p WHERE p.supplier_id = s.id AND p.is_active)::int AS products,
            (SELECT max(t.created_at) FROM inventory_transactions t WHERE t.supplier_id = s.id) AS last_delivery_at,
            (SELECT COALESCE(sum(e.amount), 0) FROM expenses e WHERE e.supplier_id = s.id AND e.status = 'recorded' AND e.expense_date >= current_date - 364) AS spend_12m
       FROM suppliers s WHERE s.organization_id = $1 ORDER BY s.is_active DESC, s.name`,
    [auth(req).orgId],
  ));
});

async function saveSupplier(req: Request, id: string | null) {
  const b = supplierSchema.parse(req.body);
  return tx(async (c) => {
    const dup = await one(`SELECT id FROM suppliers WHERE organization_id = $1 AND lower(name) = lower($2) AND id IS DISTINCT FROM $3`, [auth(req).orgId, b.name, id], c);
    if (dup) throw conflict('A supplier with this name already exists');
    const row = id
      ? await one(
        `UPDATE suppliers SET name=$3, contact_name=$4, phone=$5, email=$6, gstin=$7, notes=$8, is_active=$9 WHERE id=$1 AND organization_id=$2 RETURNING *`,
        [id, auth(req).orgId, b.name, b.contactName ?? null, b.phone ?? null, b.email ?? null, b.gstin ?? null, b.notes ?? null, b.isActive], c)
      : await one(
        `INSERT INTO suppliers (organization_id, name, contact_name, phone, email, gstin, notes, is_active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [auth(req).orgId, b.name, b.contactName ?? null, b.phone ?? null, b.email ?? null, b.gstin ?? null, b.notes ?? null, b.isActive], c);
    if (!row) throw notFound('Supplier');
    await audit(c, req, { action: id ? 'supplier.updated' : 'supplier.created', entityType: 'supplier', entityId: row.id, summary: `Supplier ${b.name} ${id ? 'updated' : 'added'}` });
    return row;
  });
}

inventoryRouter.post('/suppliers', can('inventory.manage'), async (req, res) => {
  res.status(201).json(await saveSupplier(req, null));
});
inventoryRouter.put('/suppliers/:id', can('inventory.manage'), async (req, res) => {
  res.json(await saveSupplier(req, uuid.parse(req.params.id)));
});
