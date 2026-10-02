import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { one } from '../../db/pool.js';
import { audit, notify } from '../../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { addToDate, round2, today } from '../../lib/http.js';
import { createInvoice, recordPayment, type PaymentMethod } from '../billing/service.js';

const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export interface SaleInput {
  planId: string;
  kind?: 'new' | 'renewal' | 'upgrade' | 'downgrade';
  startDate?: string;
  discount?: number;
  notes?: string;
  payment?: { amount: number; method: PaymentMethod; reference?: string | null; paidAt?: string | null; notes?: string | null } | null;
}

/**
 * Sells a membership: decides start date and kind, raises the invoice and,
 * if a payment was collected at the desk, records it — all in one transaction.
 */
export async function sellMembership(c: PoolClient, req: Request, memberId: string, input: SaleInput) {
  const orgId = req.auth!.orgId;
  const member = await one(
    `SELECT m.*, u.full_name FROM members m JOIN users u ON u.id = m.user_id WHERE m.id = $1 AND m.organization_id = $2 FOR UPDATE OF m`,
    [memberId, orgId],
    c,
  );
  if (!member || !req.auth!.branchIds.includes(member.branch_id)) throw notFound('Member');

  const plan = await one(`SELECT * FROM membership_plans WHERE id = $1 AND organization_id = $2`, [input.planId, orgId], c);
  if (!plan || plan.status !== 'active') throw badRequest('That plan is not available');
  if (!plan.all_branches) {
    const ok = await one(`SELECT 1 FROM plan_branches WHERE plan_id = $1 AND branch_id = $2`, [plan.id, member.branch_id], c);
    if (!ok) throw badRequest('That plan is not offered at this member’s branch');
  }

  const isChange = input.kind === 'upgrade' || input.kind === 'downgrade';
  // Renewals chain off the latest membership; plan changes replace the one running today.
  const current = await one(
    `SELECT ms.*, effective_membership_status(ms.status, ms.end_date, ms.frozen_until, 0) AS eff
       FROM memberships ms
      WHERE ms.member_id = $1 AND ms.status IN ('active', 'frozen', 'pending')
        AND ($2::boolean IS FALSE OR (ms.start_date <= current_date AND ms.status <> 'pending'))
      ORDER BY ms.end_date DESC LIMIT 1 FOR UPDATE`,
    [memberId, isChange],
    c,
  );
  if (isChange) {
    const upcoming = await one(
      `SELECT 1 FROM memberships WHERE member_id = $1 AND status IN ('active', 'frozen', 'pending') AND start_date > current_date LIMIT 1`,
      [memberId],
      c,
    );
    if (upcoming) throw conflict('This member has an upcoming renewal. Cancel it before changing plans.');
  }

  const now = today();
  let kind = input.kind ?? 'new';
  if (!input.kind) kind = current ? 'renewal' : 'new';
  const changingPlan = kind === 'upgrade' || kind === 'downgrade';
  if (changingPlan) {
    if (!current || current.eff === 'expired' || current.start_date > now || current.status === 'pending') {
      throw badRequest('There is no running membership to change. Sell a renewal instead.');
    }
  }
  if (current?.status === 'pending' && kind === 'renewal') {
    throw conflict('This member already has an unpaid membership. Collect that payment or cancel it first.');
  }

  let startDate = input.startDate ?? now;
  let credit = 0;
  if (kind === 'renewal' && current && current.end_date >= now && !input.startDate) {
    startDate = addToDate(current.end_date, 'day', 1);
  }
  if (changingPlan) {
    startDate = now;
    // Pro-rated credit for the unused part of the running membership.
    const total = daysBetween(current.start_date, current.end_date) + 1;
    const unused = Math.max(0, daysBetween(now, current.end_date));
    credit = round2((Number(current.price) - Number(current.discount)) * (unused / total));
    await c.query(
      `UPDATE memberships SET end_date = GREATEST(start_date, $2::date - 1), status = CASE WHEN status = 'frozen' THEN 'active' ELSE status END,
              frozen_until = NULL, updated_at = now() WHERE id = $1`,
      [current.id, now],
    );
  }
  const endDate = addToDate(addToDate(startDate, plan.duration_unit, plan.duration_value), 'day', -1);

  const discount = round2(input.discount ?? 0);
  const price = Number(plan.price);
  if (discount > price) throw badRequest('Discount cannot exceed the plan price');
  if (discount > (price * Number(plan.max_discount_pct)) / 100 && !req.auth!.permissions.has('plans.manage')) {
    throw forbidden(`Discounts above ${plan.max_discount_pct}% on this plan need manager approval`);
  }
  const totalDiscount = round2(Math.min(price, discount + credit));

  const membership = await one(
    `INSERT INTO memberships (organization_id, member_id, plan_id, branch_id, kind, status, start_date, end_date, price, discount, previous_membership_id, created_by)
     VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8,$9,$10,$11) RETURNING *`,
    [orgId, memberId, plan.id, member.branch_id, kind, startDate, endDate, price, totalDiscount, current?.id ?? null, req.auth!.userId],
    c,
  );

  const invoice = await createInvoice(c, req, {
    memberId,
    branchId: member.branch_id,
    notes: input.notes,
    items: [
      {
        itemType: 'membership',
        description: `${plan.name} membership (${fmt(startDate)} – ${fmt(endDate)})${credit ? ` · ₹${credit.toLocaleString('en-IN')} credit from previous plan` : ''}`,
        membershipId: membership.id,
        unitPrice: price,
        discount: totalDiscount,
        taxRate: Number(plan.tax_rate),
      },
    ],
  });

  const verb = { new: 'sold', renewal: 'renewed', upgrade: 'upgraded to', downgrade: 'downgraded to' }[kind];
  await audit(c, req, {
    action: `membership.${kind === 'new' ? 'created' : kind === 'renewal' ? 'renewed' : kind}`,
    entityType: 'membership',
    entityId: membership.id,
    branchId: member.branch_id,
    summary: `${member.full_name} ${verb} ${plan.name} (${fmt(startDate)} – ${fmt(endDate)})`,
    before: current ? { membership_id: current.id, end_date: current.end_date, status: current.status } : null,
    after: { plan: plan.name, start_date: startDate, end_date: endDate, price, discount: totalDiscount, invoice: invoice.invoice_number },
  });

  let payment = null;
  if (input.payment && input.payment.amount > 0) {
    payment = await recordPayment(c, req, { invoiceId: invoice.id, ...input.payment });
  }
  const fresh = await one(`SELECT * FROM memberships WHERE id = $1`, [membership.id], c);
  const freshInvoice = await one(`SELECT * FROM invoices WHERE id = $1`, [invoice.id], c);
  return { membership: fresh, invoice: freshInvoice, payment };
}

const fmt = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });

async function loadMembership(c: PoolClient, req: Request, id: string) {
  const ms = await one(
    `SELECT ms.*, p.name AS plan_name, p.freeze_days_allowed, u.full_name AS member_name, u.id AS member_user_id,
            effective_membership_status(ms.status, ms.end_date, ms.frozen_until, 0) AS eff
       FROM memberships ms JOIN membership_plans p ON p.id = ms.plan_id
       JOIN members m ON m.id = ms.member_id JOIN users u ON u.id = m.user_id
      WHERE ms.id = $1 AND ms.organization_id = $2 FOR UPDATE OF ms`,
    [id, req.auth!.orgId],
    c,
  );
  if (!ms || !req.auth!.branchIds.includes(ms.branch_id)) throw notFound('Membership');
  return ms;
}

export async function freezeMembership(c: PoolClient, req: Request, id: string, days: number, reason: string, override = false) {
  const ms = await loadMembership(c, req, id);
  if (ms.eff !== 'active') throw conflict(`Only an active membership can be frozen (this one is ${ms.eff.replace('_', ' ')})`);
  const remaining = ms.freeze_days_allowed - ms.freeze_days_used;
  if (days > remaining) {
    if (!override) throw badRequest(`Only ${remaining} freeze day${remaining === 1 ? '' : 's'} left on this plan`);
    if (!req.auth!.permissions.has('plans.manage')) throw forbidden('Exceeding the freeze allowance needs manager approval');
  }
  const start = today();
  const frozenUntil = addToDate(start, 'day', days - 1);
  const newEnd = addToDate(ms.end_date, 'day', days);
  await c.query(
    `UPDATE memberships SET status = 'frozen', frozen_until = $2, end_date = $3, freeze_days_used = freeze_days_used + $4, updated_at = now() WHERE id = $1`,
    [id, frozenUntil, newEnd, days],
  );
  await c.query(
    `INSERT INTO membership_freezes (membership_id, start_date, end_date, reason, created_by) VALUES ($1,$2,$3,$4,$5)`,
    [id, start, frozenUntil, reason, req.auth!.userId],
  );
  await audit(c, req, {
    action: 'membership.frozen',
    entityType: 'membership',
    entityId: id,
    branchId: ms.branch_id,
    summary: `${ms.member_name}'s ${ms.plan_name} frozen for ${days} days`,
    before: { status: ms.status, end_date: ms.end_date },
    after: { status: 'frozen', frozen_until: frozenUntil, end_date: newEnd, reason },
  });
  await notify(c, {
    orgId: req.auth!.orgId,
    recipientId: ms.member_user_id,
    audience: 'member',
    type: 'membership.frozen',
    title: 'Membership frozen',
    body: `Your membership is frozen until ${fmt(frozenUntil)}. New expiry: ${fmt(newEnd)}.`,
    entityType: 'membership',
    entityId: id,
  });
}

export async function unfreezeMembership(c: PoolClient, req: Request, id: string) {
  const ms = await loadMembership(c, req, id);
  if (ms.status !== 'frozen') throw conflict('This membership is not frozen');
  const now = today();
  const unused = ms.frozen_until && ms.frozen_until >= now ? daysBetween(now, ms.frozen_until) + 1 : 0;
  const newEnd = addToDate(ms.end_date, 'day', -unused);
  await c.query(
    `UPDATE memberships SET status = 'active', frozen_until = NULL, end_date = $2, freeze_days_used = GREATEST(0, freeze_days_used - $3), updated_at = now() WHERE id = $1`,
    [id, newEnd, unused],
  );
  await c.query(
    `UPDATE membership_freezes SET ended_early_on = $2 WHERE membership_id = $1 AND ended_early_on IS NULL AND end_date >= $2`,
    [id, now],
  );
  await audit(c, req, {
    action: 'membership.unfrozen',
    entityType: 'membership',
    entityId: id,
    branchId: ms.branch_id,
    summary: `${ms.member_name}'s ${ms.plan_name} unfrozen${unused ? ` (${unused} unused days returned)` : ''}`,
    before: { status: 'frozen', end_date: ms.end_date, frozen_until: ms.frozen_until },
    after: { status: 'active', end_date: newEnd },
  });
}

export async function extendMembership(c: PoolClient, req: Request, id: string, days: number, reason: string) {
  const ms = await loadMembership(c, req, id);
  if (ms.status === 'cancelled') throw conflict('A cancelled membership cannot be extended');
  const newEnd = addToDate(ms.end_date, 'day', days);
  await c.query(`UPDATE memberships SET end_date = $2, updated_at = now() WHERE id = $1`, [id, newEnd]);
  await audit(c, req, {
    action: 'membership.extended',
    entityType: 'membership',
    entityId: id,
    branchId: ms.branch_id,
    summary: `${ms.member_name}'s ${ms.plan_name} extended by ${days} days — ${reason}`,
    before: { end_date: ms.end_date },
    after: { end_date: newEnd, reason },
  });
}

export async function cancelMembership(c: PoolClient, req: Request, id: string, reason: string) {
  const ms = await loadMembership(c, req, id);
  if (ms.status === 'cancelled') throw conflict('This membership is already cancelled');
  await c.query(
    `UPDATE memberships SET status = 'cancelled', cancelled_at = now(), cancel_reason = $2, frozen_until = NULL, updated_at = now() WHERE id = $1`,
    [id, reason],
  );
  // An unpaid invoice for a cancelled membership should not linger as outstanding.
  await c.query(
    `UPDATE invoices SET status = 'void', updated_at = now()
      WHERE status = 'pending' AND amount_paid = 0
        AND id IN (SELECT invoice_id FROM invoice_items WHERE membership_id = $1)`,
    [id],
  );
  await audit(c, req, {
    action: 'membership.cancelled',
    entityType: 'membership',
    entityId: id,
    branchId: ms.branch_id,
    summary: `${ms.member_name}'s ${ms.plan_name} cancelled — ${reason}`,
    before: { status: ms.status },
    after: { status: 'cancelled', reason },
  });
}
