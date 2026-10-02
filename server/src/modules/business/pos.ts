import { Router } from 'express';
import { z } from 'zod';
import { one, query, tx } from '../../db/pool.js';
import { assertBranch, auth, branchScope, can } from '../../lib/auth.js';
import { audit, notify } from '../../lib/audit.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { isoDate, paginationSchema, paged, round2, uuid } from '../../lib/http.js';
import { createInvoice, documentNumber, PAYMENT_METHODS, recordPayment } from '../billing/service.js';
import { loyaltySettings, postPoints, quoteRedemption } from '../engagement/loyalty.js';
import { moveStock, PRODUCT_CATEGORIES } from './inventory.js';

export const posRouter = Router();

/** Sellable catalogue with stock at the selling branch. */
posRouter.get('/catalog', can('pos.sell'), async (req, res) => {
  const q = z.object({ branchId: uuid.optional(), search: z.string().trim().optional(), category: z.enum(PRODUCT_CATEGORIES).optional() }).parse(req.query);
  const branchId = q.branchId ?? (branchScope(req).length === 1 ? branchScope(req)[0] : null);
  if (branchId) assertBranch(req, branchId);
  res.json(await query(
    `SELECT p.id, p.sku, p.barcode, p.name, p.category, p.brand, p.selling_price, p.tax_rate, p.track_stock, p.low_stock_threshold,
            COALESCE(ps.quantity, 0)::int AS stock,
            (SELECT count(*) FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
              WHERE ii.product_id = p.id AND i.created_at >= current_date - 29 AND i.status <> 'void')::int AS popularity
       FROM products p LEFT JOIN product_stock ps ON ps.product_id = p.id AND ps.branch_id = $2
      WHERE p.organization_id = $1 AND p.is_active
        AND ($3::text IS NULL OR p.name ILIKE $3 OR p.sku ILIKE $3 OR p.barcode = $4 OR p.brand ILIKE $3)
        AND ($5::text IS NULL OR p.category = $5)
      ORDER BY popularity DESC, p.name LIMIT 200`,
    [auth(req).orgId, branchId, q.search ? `%${q.search}%` : null, q.search ?? null, q.category ?? null],
  ));
});

const saleSchema = z.object({
  branchId: uuid.optional(),
  memberId: uuid.optional().nullable(),
  customer: z.object({ name: z.string().trim().min(2).max(80), phone: z.string().trim().max(20).optional().nullable() }).optional().nullable(),
  items: z.array(z.object({
    productId: uuid,
    quantity: z.coerce.number().int().min(1).max(999),
    discount: z.coerce.number().min(0).default(0),
  })).min(1).max(60),
  redeemPoints: z.coerce.number().int().min(0).default(0),
  payments: z.array(z.object({
    method: z.enum(PAYMENT_METHODS),
    amount: z.coerce.number().positive(),
    reference: z.string().trim().max(80).optional().nullable(),
  })).max(3).default([]),
  // Members may take items "on account": the balance stays on their invoice.
  onAccount: z.boolean().default(false),
  notes: z.string().trim().max(500).optional().nullable(),
});

posRouter.post('/sales', can('pos.sell'), async (req, res) => {
  const b = saleSchema.parse(req.body);
  const branchId = b.branchId ?? (branchScope(req).length === 1 ? branchScope(req)[0] : null);
  if (!branchId) throw badRequest('Pick the branch you are selling from');
  assertBranch(req, branchId);
  if (!b.memberId && !b.customer) throw badRequest('Pick a member or enter the walk-in customer’s name');
  if (b.onAccount && !b.memberId) throw badRequest('Only members can buy on account');
  if (b.redeemPoints && !b.memberId) throw badRequest('Only members can redeem points');
  if (b.payments.length && !auth(req).permissions.has('payments.create')) throw badRequest('You cannot record payments');
  const ctx = { orgId: auth(req).orgId, userId: auth(req).userId };

  const result = await tx(async (c) => {
    let member: any = null;
    if (b.memberId) {
      member = await one(`SELECT m.id, m.branch_id, u.full_name FROM members m JOIN users u ON u.id = m.user_id WHERE m.id = $1 AND m.organization_id = $2`, [b.memberId, ctx.orgId], c);
      if (!member) throw notFound('Member');
    }
    // Merge repeated lines for the same product so the stock check sees the full quantity.
    const merged = new Map<string, { productId: string; quantity: number; discount: number }>();
    for (const it of b.items) {
      const prev = merged.get(it.productId);
      merged.set(it.productId, prev ? { ...prev, quantity: prev.quantity + it.quantity, discount: prev.discount + it.discount } : { ...it });
    }
    const products = await query(`SELECT * FROM products WHERE id = ANY($1) AND organization_id = $2`, [[...merged.keys()], ctx.orgId], c);
    const byId = new Map(products.map((p) => [p.id, p]));
    const lines = [...merged.values()].map((it) => {
      const p = byId.get(it.productId);
      if (!p) throw notFound('Product');
      if (!p.is_active) throw badRequest(`${p.name} is no longer sold`);
      if (it.discount > p.selling_price * it.quantity) throw badRequest(`Discount on ${p.name} exceeds its price`);
      return { product: p, ...it };
    });
    const preTotal = round2(lines.reduce((s, l) => {
      const net = l.product.selling_price * l.quantity - l.discount;
      return s + net + (net * l.product.tax_rate) / 100;
    }, 0));
    const points = b.redeemPoints ? await quoteRedemption(c, ctx.orgId, b.memberId!, b.redeemPoints, preTotal) : null;

    const invoice = await createInvoice(c, req, {
      memberId: member?.id ?? null,
      customer: member ? null : b.customer!,
      branchId,
      source: 'pos',
      notes: b.notes ?? undefined,
      points,
      items: lines.map((l) => ({
        itemType: 'product' as const, description: l.product.name, productId: l.product.id, unitCost: l.product.cost_price,
        quantity: l.quantity, unitPrice: l.product.selling_price, discount: l.discount, taxRate: l.product.tax_rate,
      })),
    });
    for (const l of lines) {
      await moveStock(c, ctx, { branchId, productId: l.product.id, type: 'sold', quantity: -l.quantity, unitCost: l.product.cost_price, invoiceId: invoice.id });
    }
    if (points) {
      await postPoints(c, {
        orgId: ctx.orgId, memberId: member.id, branchId, reason: 'redemption', points: -points.points, sourceKey: `invoice:${invoice.id}`,
        description: `Redeemed on ${invoice.invoice_number} (₹${points.discount.toLocaleString('en-IN')} off)`, invoiceId: invoice.id, createdBy: ctx.userId, notifyMember: false,
      });
    }

    const paid = round2(b.payments.reduce((s, p) => s + p.amount, 0));
    if (paid > invoice.total + 0.001) throw badRequest(`Payments (₹${paid}) exceed the bill (₹${invoice.total})`);
    if (paid < invoice.total - 0.001 && !b.onAccount) throw badRequest(`₹${round2(invoice.total - paid).toLocaleString('en-IN')} still to collect`);
    const receipts = [];
    for (const p of b.payments) receipts.push(await recordPayment(c, req, { invoiceId: invoice.id, amount: p.amount, method: p.method, reference: p.reference }));

    await audit(c, req, {
      action: 'pos.sale', entityType: 'invoice', entityId: invoice.id, branchId,
      summary: `POS sale ${invoice.invoice_number} to ${member?.full_name ?? b.customer!.name}: ${lines.map((l) => `${l.quantity} × ${l.product.name}`).join(', ')}`,
      after: { total: invoice.total, paid, points: points?.points ?? 0, on_account: b.onAccount && paid < invoice.total },
    });
    return { invoice: await one(`SELECT * FROM invoices WHERE id = $1`, [invoice.id], c), payments: receipts };
  });
  res.status(201).json(result);
});

posRouter.get('/sales', can('pos.sell'), async (req, res) => {
  const q = paginationSchema.extend({ date: isoDate.optional(), search: z.string().trim().optional(), memberId: uuid.optional() }).parse(req.query);
  const params: unknown[] = [auth(req).orgId, branchScope(req)];
  const where = [`i.organization_id = $1`, `i.branch_id = ANY($2)`, `EXISTS (SELECT 1 FROM invoice_items x WHERE x.invoice_id = i.id AND x.product_id IS NOT NULL)`];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replaceAll('$?', `$${params.length}`)); };
  if (q.date) add(`i.created_at >= $?::date AND i.created_at < $?::date + 1`, q.date);
  if (q.search) add(`(COALESCE(u.full_name, i.customer_name) ILIKE $? OR i.invoice_number ILIKE $? OR i.customer_phone ILIKE $?)`, `%${q.search}%`);
  if (q.memberId) add(`i.member_id = $?`, q.memberId);
  params.push(q.pageSize, (q.page - 1) * q.pageSize);
  const rows = await query(
    `SELECT i.id, i.invoice_number, i.created_at, i.total, i.amount_paid, i.amount_refunded, i.status, i.points_redeemed, i.points_discount,
            i.member_id, COALESCE(u.full_name, i.customer_name) AS customer_name, m.member_code, i.member_id IS NULL AS walk_in,
            cu.full_name AS sold_by_name,
            (SELECT json_agg(json_build_object('id', ii.id, 'description', ii.description, 'quantity', ii.quantity, 'returned_qty', ii.returned_qty,
                     'unit_price', ii.unit_price, 'amount', ii.amount, 'product_id', ii.product_id) ORDER BY ii.description)
               FROM invoice_items ii WHERE ii.invoice_id = i.id) AS items,
            (SELECT string_agg(DISTINCT p.method, ',') FROM payments p WHERE p.invoice_id = i.id AND p.status = 'recorded') AS methods,
            count(*) OVER() AS total_count
       FROM invoices i LEFT JOIN members m ON m.id = i.member_id LEFT JOIN users u ON u.id = m.user_id LEFT JOIN users cu ON cu.id = i.created_by
      WHERE ${where.join(' AND ')} ORDER BY i.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  res.json(paged(rows, q.page, q.pageSize));
});

/** Today's till: sales, takings by method and refunds — what the cash count is checked against. */
posRouter.get('/summary', can('pos.sell'), async (req, res) => {
  const { date } = z.object({ date: isoDate.optional() }).parse(req.query);
  const scope = [auth(req).orgId, branchScope(req), date ?? null];
  const day = `COALESCE($3::date, current_date)`;
  const [sales, methods, refunds, top] = await Promise.all([
    one(
      `SELECT count(*)::int AS sales, COALESCE(sum(i.total), 0) AS total, COALESCE(sum(i.total - i.amount_paid), 0) AS on_account,
              COALESCE(sum(i.points_discount), 0) AS points_discount,
              COALESCE(sum((SELECT sum(ii.quantity) FROM invoice_items ii WHERE ii.invoice_id = i.id)), 0)::int AS units
         FROM invoices i WHERE i.organization_id = $1 AND i.branch_id = ANY($2) AND i.source = 'pos' AND i.status <> 'void'
          AND i.created_at >= ${day} AND i.created_at < ${day} + 1`,
      scope,
    ),
    query(
      `SELECT p.method, sum(p.amount) AS amount, count(*)::int AS n FROM payments p JOIN invoices i ON i.id = p.invoice_id
        WHERE p.organization_id = $1 AND p.branch_id = ANY($2) AND i.source = 'pos' AND p.status = 'recorded'
          AND p.paid_at >= ${day} AND p.paid_at < ${day} + 1 GROUP BY p.method ORDER BY amount DESC`,
      scope,
    ),
    query(
      `SELECT r.method, sum(r.amount) AS amount, count(*)::int AS n FROM refunds r
        WHERE r.organization_id = $1 AND r.branch_id = ANY($2) AND r.created_at >= ${day} AND r.created_at < ${day} + 1 GROUP BY r.method`,
      scope,
    ),
    query(
      `SELECT ii.description AS name, sum(ii.quantity - ii.returned_qty)::int AS units, sum(ii.amount) AS revenue
         FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
        WHERE i.organization_id = $1 AND i.branch_id = ANY($2) AND ii.product_id IS NOT NULL AND i.status <> 'void'
          AND i.created_at >= ${day} AND i.created_at < ${day} + 1
        GROUP BY ii.description ORDER BY revenue DESC LIMIT 5`,
      scope,
    ),
  ]);
  res.json({ ...sales, methods, refunds, top });
});

// ------------------------------------------------------------------ returns ----

const refundSchema = z.object({
  items: z.array(z.object({ invoiceItemId: uuid, quantity: z.coerce.number().int().min(1) })).min(1),
  restock: z.boolean().default(true),
  method: z.enum(PAYMENT_METHODS),
  reference: z.string().trim().max(80).optional().nullable(),
  reason: z.string().trim().min(3).max(300),
});

/**
 * Returns product lines from a sale. The refund is each returned unit's share
 * of what the customer actually paid (after line discount, tax and any points
 * discount), capped at the money collected and not yet refunded.
 */
posRouter.post('/sales/:id/refund', can('pos.refund'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const b = refundSchema.parse(req.body);
  if ((b.method === 'upi' || b.method === 'bank_transfer') && !b.reference) throw badRequest('Enter the UPI / bank transaction reference');
  const ctx = { orgId: auth(req).orgId, userId: auth(req).userId };
  const result = await tx(async (c) => {
    const inv = await one(`SELECT * FROM invoices WHERE id = $1 AND organization_id = $2 FOR UPDATE`, [id, ctx.orgId], c);
    if (!inv || !auth(req).branchIds.includes(inv.branch_id)) throw notFound('Sale');
    if (inv.status === 'void') throw conflict('This sale is void');
    const items = await query(`SELECT * FROM invoice_items WHERE invoice_id = $1 FOR UPDATE`, [id], c);
    const gross = items.reduce((s, i) => s + Number(i.amount), 0);
    const factor = gross > 0 ? inv.total / gross : 0; // spreads the points discount across lines
    let amount = 0;
    const returned: { description: string; quantity: number; amount: number }[] = [];
    for (const r of b.items) {
      const it = items.find((i) => i.id === r.invoiceItemId);
      if (!it || !it.product_id) throw badRequest('Only product lines from this sale can be returned');
      if (r.quantity > it.quantity - it.returned_qty) throw badRequest(`Only ${it.quantity - it.returned_qty} × ${it.description} left to return`);
      const value = round2((it.amount / it.quantity) * r.quantity * factor);
      amount += value;
      returned.push({ description: it.description, quantity: r.quantity, amount: value });
    }
    amount = round2(Math.min(amount, inv.amount_paid - inv.amount_refunded));
    if (amount <= 0) throw conflict('Nothing has been paid on this sale to refund — void or adjust the invoice instead');

    const number = await documentNumber(c, ctx.orgId, 'RFD', 'refund');
    const refund = await one(
      `INSERT INTO refunds (organization_id, branch_id, invoice_id, member_id, refund_number, amount, method, reference, reason, items, restocked, refunded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [ctx.orgId, inv.branch_id, id, inv.member_id, number, amount, b.method, b.reference ?? null, b.reason, JSON.stringify(returned), b.restock, ctx.userId],
      c,
    );
    for (const r of b.items) {
      const it = items.find((i) => i.id === r.invoiceItemId)!;
      await c.query(`UPDATE invoice_items SET returned_qty = returned_qty + $2 WHERE id = $1`, [it.id, r.quantity]);
      if (b.restock) await moveStock(c, ctx, { branchId: inv.branch_id, productId: it.product_id, type: 'returned', quantity: r.quantity, unitCost: it.unit_cost, invoiceId: id, refundId: refund.id, reason: b.reason });
    }
    const allBack = items.every((i) => {
      const r = b.items.find((x) => x.invoiceItemId === i.id);
      return i.returned_qty + (r?.quantity ?? 0) >= i.quantity;
    });
    await c.query(
      `UPDATE invoices SET amount_refunded = amount_refunded + $2, status = CASE WHEN $3 THEN 'refunded' ELSE status END, updated_at = now() WHERE id = $1`,
      [id, amount, allBack],
    );
    if (inv.member_id) {
      // Points earned on the refunded amount go back.
      const s = await loyaltySettings(c, ctx.orgId);
      const back = Math.floor((amount / 100) * s.pointsPer100);
      if (back > 0) {
        await postPoints(c, {
          orgId: ctx.orgId, memberId: inv.member_id, branchId: inv.branch_id, reason: 'reversal', points: -back, sourceKey: `refund:${refund.id}`,
          description: `Refund ${number} on ${inv.invoice_number}`, invoiceId: id, createdBy: ctx.userId,
        });
      }
      const user = await one(`SELECT user_id FROM members WHERE id = $1`, [inv.member_id], c);
      await notify(c, {
        orgId: ctx.orgId, recipientId: user!.user_id, audience: 'member', type: 'refund.issued',
        title: 'Refund issued', body: `₹${amount.toLocaleString('en-IN')} refunded for ${returned.map((r) => `${r.quantity} × ${r.description}`).join(', ')}.`,
        entityType: 'invoice', entityId: id,
      });
    }
    await audit(c, req, {
      action: 'pos.refund', entityType: 'invoice', entityId: id, branchId: inv.branch_id,
      summary: `Refund ${number} of ₹${amount.toLocaleString('en-IN')} on ${inv.invoice_number}: ${b.reason}${b.restock ? ' (restocked)' : ''}`,
      after: { amount, method: b.method, items: returned, restocked: b.restock },
    });
    return refund;
  });
  res.status(201).json(result);
});
