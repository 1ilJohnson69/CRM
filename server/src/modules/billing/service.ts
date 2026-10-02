import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { one } from '../../db/pool.js';
import { audit, notify } from '../../lib/audit.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { round2 } from '../../lib/http.js';

export const PAYMENT_METHODS = ['cash', 'upi', 'card', 'bank_transfer', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const ITEM_TYPES = ['membership', 'pt', 'class', 'event', 'product', 'other'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export async function nextSequence(c: PoolClient, orgId: string, key: string): Promise<number> {
  const row = await one(
    `INSERT INTO counters (organization_id, key, value) VALUES ($1, $2, 1)
     ON CONFLICT (organization_id, key) DO UPDATE SET value = counters.value + 1
     RETURNING value`,
    [orgId, key],
    c,
  );
  return row!.value;
}

async function documentNumber(c: PoolClient, orgId: string, prefix: string, key: string) {
  const year = new Date().getFullYear();
  const seq = await nextSequence(c, orgId, `${key}:${year}`);
  return `${prefix}-${year}-${String(seq).padStart(5, '0')}`;
}

export interface InvoiceItemInput {
  itemType: ItemType;
  description: string;
  membershipId?: string | null;
  memberPtPackageId?: string | null;
  quantity?: number;
  unitPrice: number;
  discount?: number;
  taxRate?: number;
}

export async function createInvoice(
  c: PoolClient,
  req: Request,
  input: { memberId: string; branchId: string; items: InvoiceItemInput[]; notes?: string; dueDate?: string },
) {
  if (!input.items.length) throw badRequest('An invoice needs at least one item');
  const orgId = req.auth!.orgId;
  const org = await one(`SELECT invoice_prefix FROM organizations WHERE id = $1`, [orgId], c);

  const lines = input.items.map((item) => {
    const quantity = item.quantity ?? 1;
    const gross = round2(item.unitPrice * quantity);
    const discount = round2(item.discount ?? 0);
    if (discount > gross) throw badRequest(`Discount on "${item.description}" exceeds its price`);
    const taxRate = item.taxRate ?? 0;
    const tax = round2(((gross - discount) * taxRate) / 100);
    return { ...item, quantity, gross, discount, taxRate, tax, amount: round2(gross - discount + tax) };
  });
  const subtotal = round2(lines.reduce((s, l) => s + l.gross, 0));
  const discount = round2(lines.reduce((s, l) => s + l.discount, 0));
  const tax = round2(lines.reduce((s, l) => s + l.tax, 0));
  const total = round2(subtotal - discount + tax);
  const number = await documentNumber(c, orgId, org!.invoice_prefix, 'invoice');

  const invoice = await one(
    `INSERT INTO invoices (organization_id, branch_id, member_id, invoice_number, due_date, subtotal, discount, tax, total, amount_paid, status, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,$11,$12) RETURNING *`,
    [orgId, input.branchId, input.memberId, number, input.dueDate ?? null, subtotal, discount, tax, total, total === 0 ? 'paid' : 'pending', input.notes ?? null, req.auth!.userId],
    c,
  );
  for (const l of lines) {
    await c.query(
      `INSERT INTO invoice_items (invoice_id, item_type, description, membership_id, member_pt_package_id, quantity, unit_price, discount, tax_rate, tax, amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [invoice.id, l.itemType, l.description, l.membershipId ?? null, l.memberPtPackageId ?? null, l.quantity, l.unitPrice, l.discount, l.taxRate, l.tax, l.amount],
    );
  }
  if (total === 0) await activateInvoiceMemberships(c, invoice.id);

  await audit(c, req, {
    action: 'invoice.created',
    entityType: 'invoice',
    entityId: invoice.id,
    branchId: input.branchId,
    summary: `Invoice ${number} raised for ₹${total.toLocaleString('en-IN')}`,
    after: { invoice_number: number, total, items: lines.map((l) => ({ description: l.description, amount: l.amount })) },
  });
  return invoice;
}

export interface PaymentInput {
  invoiceId: string;
  amount: number;
  method: PaymentMethod;
  reference?: string | null;
  paidAt?: string | null;
  notes?: string | null;
}

/**
 * Records a manually collected payment. Everything that depends on the
 * payment (invoice balance, membership activation, audit, notifications)
 * happens in the caller's transaction so it is all-or-nothing.
 */
export async function recordPayment(c: PoolClient, req: Request, input: PaymentInput) {
  const invoice = await one(
    `SELECT i.*, u.full_name AS member_name, u.id AS member_user_id
       FROM invoices i JOIN members m ON m.id = i.member_id JOIN users u ON u.id = m.user_id
      WHERE i.id = $1 AND i.organization_id = $2 FOR UPDATE OF i`,
    [input.invoiceId, req.auth!.orgId],
    c,
  );
  if (!invoice) throw notFound('Invoice');
  if (!req.auth!.branchIds.includes(invoice.branch_id)) throw notFound('Invoice');
  if (['void', 'refunded'].includes(invoice.status)) throw conflict(`This invoice is ${invoice.status}`);
  const balance = round2(invoice.total - invoice.amount_paid);
  if (balance <= 0) throw conflict('This invoice is already fully paid');
  const amount = round2(input.amount);
  if (amount <= 0) throw badRequest('Amount must be greater than zero');
  if (amount > balance) throw badRequest(`Amount exceeds the outstanding balance of ₹${balance.toLocaleString('en-IN')}`);
  const reference = input.reference?.trim() || null;
  if ((input.method === 'upi' || input.method === 'bank_transfer') && !reference) {
    throw badRequest('Enter the UPI / bank transaction reference');
  }

  const receipt = await documentNumber(c, req.auth!.orgId, 'RCT', 'receipt');
  const payment = await one(
    `INSERT INTO payments (organization_id, branch_id, member_id, invoice_id, receipt_number, amount, method, reference, paid_at, collected_by, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::timestamptz, now()),$10,$11) RETURNING *`,
    [req.auth!.orgId, invoice.branch_id, invoice.member_id, invoice.id, receipt, amount, input.method, reference, input.paidAt ?? null, req.auth!.userId, input.notes ?? null],
    c,
  );

  const paid = round2(invoice.amount_paid + amount);
  const status = paid >= invoice.total ? 'paid' : 'partially_paid';
  await c.query(`UPDATE invoices SET amount_paid = $2, status = $3, updated_at = now() WHERE id = $1`, [invoice.id, paid, status]);
  const activated = await activateInvoiceMemberships(c, invoice.id);

  const methodLabel = input.method === 'bank_transfer' ? 'bank transfer' : input.method.toUpperCase();
  await audit(c, req, {
    action: 'payment.recorded',
    entityType: 'payment',
    entityId: payment.id,
    branchId: invoice.branch_id,
    summary: `₹${amount.toLocaleString('en-IN')} recorded via ${methodLabel} from ${invoice.member_name} (${invoice.invoice_number})`,
    after: { receipt_number: receipt, amount, method: input.method, reference, invoice_status: status },
  });
  await notify(c, {
    orgId: req.auth!.orgId,
    recipientId: invoice.member_user_id,
    audience: 'member',
    type: 'payment.recorded',
    title: 'Payment received',
    body: `We received ₹${amount.toLocaleString('en-IN')} (${receipt}). Thank you!`,
    entityType: 'payment',
    entityId: payment.id,
  });
  if (activated.length) {
    await notify(c, {
      orgId: req.auth!.orgId,
      recipientId: invoice.member_user_id,
      audience: 'member',
      type: 'membership.activated',
      title: 'Membership active',
      body: `Your membership is active until ${activated[0].end_date}.`,
      entityType: 'membership',
      entityId: activated[0].id,
    });
  }
  return { ...payment, invoice_status: status };
}

/** Pending memberships and PT packages on an invoice go live once any amount is collected. */
async function activateInvoiceMemberships(c: PoolClient, invoiceId: string) {
  await c.query(
    `UPDATE member_pt_packages SET status = 'active'
      WHERE status = 'pending'
        AND id IN (SELECT member_pt_package_id FROM invoice_items WHERE invoice_id = $1 AND member_pt_package_id IS NOT NULL)`,
    [invoiceId],
  );
  const res = await c.query(
    `UPDATE memberships SET status = 'active', updated_at = now()
      WHERE status = 'pending'
        AND id IN (SELECT membership_id FROM invoice_items WHERE invoice_id = $1 AND membership_id IS NOT NULL)
      RETURNING id, end_date`,
    [invoiceId],
  );
  return res.rows;
}

export async function voidPayment(c: PoolClient, req: Request, paymentId: string, reason: string) {
  const payment = await one(
    `SELECT p.*, i.invoice_number, i.total, i.amount_paid FROM payments p JOIN invoices i ON i.id = p.invoice_id
      WHERE p.id = $1 AND p.organization_id = $2 FOR UPDATE OF p, i`,
    [paymentId, req.auth!.orgId],
    c,
  );
  if (!payment || !req.auth!.branchIds.includes(payment.branch_id)) throw notFound('Payment');
  if (payment.status === 'voided') throw conflict('This payment is already voided');

  await c.query(`UPDATE payments SET status = 'voided', void_reason = $2 WHERE id = $1`, [paymentId, reason]);
  const paid = round2(payment.amount_paid - payment.amount);
  const status = paid <= 0 ? 'pending' : 'partially_paid';
  await c.query(`UPDATE invoices SET amount_paid = $2, status = $3, updated_at = now() WHERE id = $1`, [payment.invoice_id, Math.max(0, paid), status]);
  if (paid <= 0) {
    // Nothing collected any more: memberships billed on this invoice revert to pending.
    await c.query(
      `UPDATE memberships SET status = 'pending', updated_at = now()
        WHERE status = 'active' AND id IN (SELECT membership_id FROM invoice_items WHERE invoice_id = $1 AND membership_id IS NOT NULL)`,
      [payment.invoice_id],
    );
    await c.query(
      `UPDATE member_pt_packages SET status = 'pending'
        WHERE status = 'active' AND id IN (SELECT member_pt_package_id FROM invoice_items WHERE invoice_id = $1 AND member_pt_package_id IS NOT NULL)`,
      [payment.invoice_id],
    );
  }
  await audit(c, req, {
    action: 'payment.voided',
    entityType: 'payment',
    entityId: paymentId,
    branchId: payment.branch_id,
    summary: `Payment ${payment.receipt_number} of ₹${payment.amount.toLocaleString('en-IN')} voided: ${reason}`,
    before: { status: 'recorded', invoice_amount_paid: payment.amount_paid },
    after: { status: 'voided', invoice_amount_paid: Math.max(0, paid), reason },
  });
}
