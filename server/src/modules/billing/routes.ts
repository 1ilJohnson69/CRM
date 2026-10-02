import { Router, type Request } from 'express';
import { z } from 'zod';
import { one, query, tx } from '../../db/pool.js';
import { assertBranch, auth, branchScope, can } from '../../lib/auth.js';
import { notFound } from '../../lib/errors.js';
import { isoDate, paginationSchema, paged, uuid } from '../../lib/http.js';
import { streamInvoicePdf } from './pdf.js';
import { createInvoice, ITEM_TYPES, PAYMENT_METHODS, recordPayment, voidPayment } from './service.js';

// -------------------------------------------------------------- payments ----

export const paymentsRouter = Router();

const paymentListSchema = paginationSchema.extend({
  search: z.string().trim().optional(),
  method: z.enum(PAYMENT_METHODS).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  memberId: uuid.optional(),
  collectedBy: uuid.optional(),
  status: z.enum(['recorded', 'voided']).optional(),
});

paymentsRouter.get('/', can('payments.read'), async (req, res) => {
  const q = paymentListSchema.parse(req.query);
  const params: unknown[] = [auth(req).orgId, branchScope(req)];
  const where = [`p.organization_id = $1`, `p.branch_id = ANY($2)`];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replaceAll('$?', `$${params.length}`));
  };
  if (q.search) add(`(COALESCE(u.full_name, i.customer_name) ILIKE $? OR p.reference ILIKE $? OR p.receipt_number ILIKE $? OR i.invoice_number ILIKE $? OR m.member_code ILIKE $?)`, `%${q.search}%`);
  if (q.method) add(`p.method = $?`, q.method);
  if (q.from) add(`p.paid_at >= $?::date`, q.from);
  if (q.to) add(`p.paid_at < $?::date + 1`, q.to);
  if (q.memberId) add(`p.member_id = $?`, q.memberId);
  if (q.collectedBy) add(`p.collected_by = $?`, q.collectedBy);
  if (q.status) add(`p.status = $?`, q.status);
  params.push(q.pageSize, (q.page - 1) * q.pageSize);

  const rows = await query(
    `SELECT p.id, p.receipt_number, p.amount, p.method, p.reference, p.paid_at, p.status, p.notes, p.void_reason,
            p.member_id, COALESCE(u.full_name, i.customer_name) AS member_name, u.avatar_url, m.member_code, i.source,
            i.id AS invoice_id, i.invoice_number, i.status AS invoice_status,
            (SELECT string_agg(DISTINCT ii.item_type, ',') FROM invoice_items ii WHERE ii.invoice_id = i.id) AS services,
            (SELECT ii.description FROM invoice_items ii WHERE ii.invoice_id = i.id LIMIT 1) AS description,
            cu.full_name AS collected_by_name, b.name AS branch_name,
            count(*) OVER() AS total_count,
            sum(p.amount) FILTER (WHERE p.status = 'recorded') OVER() AS total_amount
       FROM payments p
       JOIN invoices i ON i.id = p.invoice_id
       LEFT JOIN members m ON m.id = p.member_id LEFT JOIN users u ON u.id = m.user_id
       JOIN branches b ON b.id = p.branch_id
       LEFT JOIN users cu ON cu.id = p.collected_by
      WHERE ${where.join(' AND ')}
      ORDER BY p.paid_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const totalAmount = rows[0]?.total_amount ?? 0;
  const result = paged(rows.map(({ total_amount, ...r }) => r), q.page, q.pageSize);
  res.json({ ...result, summary: { totalAmount } });
});

const paymentSchema = z.object({
  invoiceId: uuid,
  amount: z.coerce.number().positive(),
  method: z.enum(PAYMENT_METHODS),
  reference: z.string().trim().max(80).optional().nullable(),
  paidAt: z.string().datetime({ offset: true }).optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable(),
});

paymentsRouter.post('/', can('payments.create'), async (req, res) => {
  const body = paymentSchema.parse(req.body);
  res.status(201).json(await tx((c) => recordPayment(c, req, body)));
});

paymentsRouter.post('/:id/void', can('payments.void'), async (req, res) => {
  const { reason } = z.object({ reason: z.string().trim().min(3) }).parse(req.body);
  await tx((c) => voidPayment(c, req, uuid.parse(req.params.id), reason));
  res.status(204).end();
});

// -------------------------------------------------------------- invoices ----

export const invoicesRouter = Router();

const invoiceListSchema = paginationSchema.extend({
  search: z.string().trim().optional(),
  status: z.enum(['pending', 'partially_paid', 'paid', 'refunded', 'void', 'outstanding']).optional(),
  memberId: uuid.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

invoicesRouter.get('/', can('invoices.read'), async (req, res) => {
  const q = invoiceListSchema.parse(req.query);
  const params: unknown[] = [auth(req).orgId, branchScope(req)];
  const where = [`i.organization_id = $1`, `i.branch_id = ANY($2)`];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replaceAll('$?', `$${params.length}`));
  };
  if (q.search) add(`(COALESCE(u.full_name, i.customer_name) ILIKE $? OR i.invoice_number ILIKE $? OR m.member_code ILIKE $?)`, `%${q.search}%`);
  if (q.status === 'outstanding') where.push(`i.status IN ('pending','partially_paid')`);
  else if (q.status) add(`i.status = $?`, q.status);
  if (q.memberId) add(`i.member_id = $?`, q.memberId);
  if (q.from) add(`i.issue_date >= $?::date`, q.from);
  if (q.to) add(`i.issue_date <= $?::date`, q.to);
  params.push(q.pageSize, (q.page - 1) * q.pageSize);

  const rows = await query(
    `SELECT i.id, i.invoice_number, i.issue_date, i.due_date, i.subtotal, i.discount, i.tax, i.total, i.amount_paid,
            (i.total - i.amount_paid) AS balance, i.status, i.member_id, COALESCE(u.full_name, i.customer_name) AS member_name, m.member_code,
            i.source, i.amount_refunded, i.points_discount,
            (SELECT ii.description FROM invoice_items ii WHERE ii.invoice_id = i.id LIMIT 1) AS description,
            b.name AS branch_name, count(*) OVER() AS total_count
       FROM invoices i
       LEFT JOIN members m ON m.id = i.member_id LEFT JOIN users u ON u.id = m.user_id
       JOIN branches b ON b.id = i.branch_id
      WHERE ${where.join(' AND ')}
      ORDER BY i.issue_date DESC, i.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  res.json(paged(rows, q.page, q.pageSize));
});

const invoiceSchema = z.object({
  memberId: uuid,
  notes: z.string().trim().optional(),
  dueDate: isoDate.optional(),
  items: z
    .array(
      z.object({
        itemType: z.enum(ITEM_TYPES).exclude(['membership']),
        description: z.string().trim().min(2),
        quantity: z.coerce.number().int().min(1).default(1),
        unitPrice: z.coerce.number().min(0),
        discount: z.coerce.number().min(0).default(0),
        taxRate: z.coerce.number().min(0).max(40).default(0),
      }),
    )
    .min(1),
  payment: z
    .object({ amount: z.coerce.number().positive(), method: z.enum(PAYMENT_METHODS), reference: z.string().trim().optional().nullable() })
    .optional()
    .nullable(),
});

// Ad-hoc charges (PT packages, merchandise, day passes…) until those
// modules have their own flows. Memberships are billed via /memberships.
invoicesRouter.post('/', can('invoices.read', 'payments.create'), async (req, res) => {
  const body = invoiceSchema.parse(req.body);
  const result = await tx(async (c) => {
    const member = await one(`SELECT id, branch_id FROM members WHERE id = $1 AND organization_id = $2`, [body.memberId, auth(req).orgId], c);
    if (!member) throw notFound('Member');
    assertBranch(req, member.branch_id);
    const invoice = await createInvoice(c, req, { memberId: member.id, branchId: member.branch_id, items: body.items, notes: body.notes, dueDate: body.dueDate });
    const payment = body.payment ? await recordPayment(c, req, { invoiceId: invoice.id, ...body.payment }) : null;
    return { invoice: await one(`SELECT * FROM invoices WHERE id = $1`, [invoice.id], c), payment };
  });
  res.status(201).json(result);
});

export async function loadInvoice(req: Request, id: string, memberId?: string) {
  const invoice = await one(`SELECT * FROM invoices WHERE id = $1 AND organization_id = $2`, [id, auth(req).orgId]);
  if (!invoice) throw notFound('Invoice');
  if (memberId ? invoice.member_id !== memberId : !auth(req).branchIds.includes(invoice.branch_id)) throw notFound('Invoice');
  const [items, payments, org, branch, member, refunds] = await Promise.all([
    query(`SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY id`, [id]),
    query(
      `SELECT p.*, u.full_name AS collected_by_name FROM payments p LEFT JOIN users u ON u.id = p.collected_by
        WHERE p.invoice_id = $1 ORDER BY p.paid_at`,
      [id],
    ),
    one(`SELECT name, legal_name, gstin, currency FROM organizations WHERE id = $1`, [invoice.organization_id]),
    one(`SELECT name, address, phone, email FROM branches WHERE id = $1`, [invoice.branch_id]),
    invoice.member_id
      ? one(`SELECT m.id, m.member_code, u.full_name, u.phone, u.email FROM members m JOIN users u ON u.id = m.user_id WHERE m.id = $1`, [invoice.member_id])
      : Promise.resolve({ id: null, member_code: null, full_name: invoice.customer_name, phone: invoice.customer_phone, email: null, walk_in: true }),
    query(`SELECT r.*, u.full_name AS refunded_by_name FROM refunds r LEFT JOIN users u ON u.id = r.refunded_by WHERE r.invoice_id = $1 ORDER BY r.created_at`, [id]),
  ]);
  return { invoice, items, payments, org, branch, member, refunds };
}

invoicesRouter.get('/:id', can('invoices.read'), async (req, res) => {
  res.json(await loadInvoice(req, uuid.parse(req.params.id)));
});

invoicesRouter.get('/:id/pdf', can('invoices.read'), async (req, res) => {
  const data = await loadInvoice(req, uuid.parse(req.params.id));
  streamInvoicePdf(res, { ...data, payments: data.payments.filter((p) => p.status === 'recorded') });
});
