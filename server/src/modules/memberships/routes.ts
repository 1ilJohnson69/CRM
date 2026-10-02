import { Router } from 'express';
import { z } from 'zod';
import { one, query, tx } from '../../db/pool.js';
import { auth, branchScope, can } from '../../lib/auth.js';
import { audit } from '../../lib/audit.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { isoDate, paginationSchema, paged, uuid } from '../../lib/http.js';
import { PAYMENT_METHODS } from '../billing/service.js';
import { cancelMembership, extendMembership, freezeMembership, sellMembership, unfreezeMembership } from './service.js';

// ---------------------------------------------------------------- plans ----

export const plansRouter = Router();

const planSchema = z.object({
  name: z.string().trim().min(2),
  description: z.string().trim().optional().nullable(),
  durationUnit: z.enum(['day', 'month']),
  durationValue: z.coerce.number().int().positive(),
  price: z.coerce.number().min(0),
  taxRate: z.coerce.number().min(0).max(40).default(0),
  benefits: z.array(z.string().trim().min(1)).default([]),
  classAccess: z.boolean().default(false),
  ptAccess: z.boolean().default(false),
  facilityAccess: z.array(z.string()).default(['gym']),
  freezeDaysAllowed: z.coerce.number().int().min(0).default(0),
  guestPasses: z.coerce.number().int().min(0).default(0),
  maxDiscountPct: z.coerce.number().min(0).max(100).default(0),
  allBranches: z.boolean().default(true),
  branchIds: z.array(uuid).default([]),
  status: z.enum(['active', 'archived']).default('active'),
});

plansRouter.get('/', can('plans.read'), async (req, res) => {
  const rows = await query(
    `SELECT p.*,
            COALESCE(array_agg(pb.branch_id) FILTER (WHERE pb.branch_id IS NOT NULL), '{}') AS branch_ids,
            (SELECT count(*) FROM member_current_membership cm WHERE cm.plan_id = p.id AND cm.status IN ('active','expiring_soon','frozen')) AS active_members
       FROM membership_plans p LEFT JOIN plan_branches pb ON pb.plan_id = p.id
      WHERE p.organization_id = $1
      GROUP BY p.id ORDER BY p.status, p.duration_unit DESC, p.duration_value, p.price`,
    [auth(req).orgId],
  );
  res.json(rows);
});

async function savePlan(req: any, id: string | null, body: z.infer<typeof planSchema>) {
  return tx(async (c) => {
    const values = [body.name, body.description ?? null, body.durationUnit, body.durationValue, body.price, body.taxRate, body.benefits,
      body.classAccess, body.ptAccess, body.facilityAccess, body.freezeDaysAllowed, body.guestPasses, body.maxDiscountPct, body.allBranches, body.status];
    let plan;
    let before = null;
    if (id) {
      before = await one(`SELECT * FROM membership_plans WHERE id = $1 AND organization_id = $2`, [id, auth(req).orgId], c);
      if (!before) throw notFound('Plan');
      plan = await one(
        `UPDATE membership_plans SET name=$2, description=$3, duration_unit=$4, duration_value=$5, price=$6, tax_rate=$7, benefits=$8,
                class_access=$9, pt_access=$10, facility_access=$11, freeze_days_allowed=$12, guest_passes=$13, max_discount_pct=$14,
                all_branches=$15, status=$16, updated_at=now() WHERE id=$1 RETURNING *`,
        [id, ...values],
        c,
      );
    } else {
      plan = await one(
        `INSERT INTO membership_plans (name, description, duration_unit, duration_value, price, tax_rate, benefits, class_access, pt_access,
                facility_access, freeze_days_allowed, guest_passes, max_discount_pct, all_branches, status, organization_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
        [...values, auth(req).orgId],
        c,
      );
    }
    await c.query(`DELETE FROM plan_branches WHERE plan_id = $1`, [plan.id]);
    if (!body.allBranches) {
      for (const b of body.branchIds) await c.query(`INSERT INTO plan_branches (plan_id, branch_id) VALUES ($1,$2)`, [plan.id, b]);
    }
    await audit(c, req, {
      action: id ? 'plan.updated' : 'plan.created',
      entityType: 'membership_plan',
      entityId: plan.id,
      summary: `Plan ${plan.name} ${id ? 'updated' : 'created'} at ₹${Number(plan.price).toLocaleString('en-IN')}`,
      before: before && { name: before.name, price: before.price, status: before.status },
      after: { name: plan.name, price: plan.price, status: plan.status },
    });
    return plan;
  });
}

plansRouter.post('/', can('plans.manage'), async (req, res) => {
  res.status(201).json(await savePlan(req, null, planSchema.parse(req.body)));
});

plansRouter.put('/:id', can('plans.manage'), async (req, res) => {
  res.json(await savePlan(req, uuid.parse(req.params.id), planSchema.parse(req.body)));
});

// ---------------------------------------------------------- memberships ----

export const membershipsRouter = Router();

const listSchema = paginationSchema.extend({
  status: z.enum(['active', 'expiring_soon', 'expired', 'frozen', 'cancelled', 'pending']).optional(),
  planId: uuid.optional(),
  expiringWithin: z.coerce.number().int().min(0).max(90).optional(),
});

membershipsRouter.get('/', can('members.read'), async (req, res) => {
  const q = listSchema.parse(req.query);
  const params: unknown[] = [auth(req).orgId, branchScope(req)];
  const where = [`ms.organization_id = $1`, `ms.branch_id = ANY($2)`];
  if (q.status) {
    params.push(q.status);
    where.push(`effective_membership_status(ms.status, ms.end_date, ms.frozen_until, o.expiring_soon_days) = $${params.length}`);
  }
  if (q.planId) {
    params.push(q.planId);
    where.push(`ms.plan_id = $${params.length}`);
  }
  if (q.expiringWithin !== undefined) {
    params.push(q.expiringWithin);
    where.push(`ms.status IN ('active','frozen') AND ms.end_date BETWEEN current_date AND current_date + $${params.length}::int`);
  }
  params.push(q.pageSize, (q.page - 1) * q.pageSize);
  const rows = await query(
    `SELECT ms.id, ms.member_id, ms.kind, ms.start_date, ms.end_date, ms.price, ms.discount, ms.created_at,
            effective_membership_status(ms.status, ms.end_date, ms.frozen_until, o.expiring_soon_days) AS status,
            p.name AS plan_name, u.full_name AS member_name, m.member_code, b.name AS branch_name,
            count(*) OVER() AS total_count
       FROM memberships ms
       JOIN organizations o ON o.id = ms.organization_id
       JOIN membership_plans p ON p.id = ms.plan_id
       JOIN members m ON m.id = ms.member_id JOIN users u ON u.id = m.user_id
       JOIN branches b ON b.id = ms.branch_id
      WHERE ${where.join(' AND ')}
      ORDER BY ms.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  res.json(paged(rows, q.page, q.pageSize));
});

const saleSchema = z.object({
  memberId: uuid,
  planId: uuid,
  kind: z.enum(['new', 'renewal', 'upgrade', 'downgrade']).optional(),
  startDate: isoDate.optional(),
  discount: z.coerce.number().min(0).default(0),
  notes: z.string().trim().optional(),
  payment: z
    .object({
      amount: z.coerce.number().positive(),
      method: z.enum(PAYMENT_METHODS),
      reference: z.string().trim().optional().nullable(),
      paidAt: z.string().datetime({ offset: true }).optional().nullable(),
      notes: z.string().trim().optional().nullable(),
    })
    .optional()
    .nullable(),
});

membershipsRouter.post('/', can('memberships.manage'), async (req, res) => {
  const body = saleSchema.parse(req.body);
  if (body.payment && !auth(req).permissions.has('payments.create')) throw forbidden('You cannot record payments');
  const { memberId, ...input } = body;
  res.status(201).json(await tx((c) => sellMembership(c, req, memberId, input)));
});

const reason = z.string().trim().min(3, 'Add a short reason');

membershipsRouter.post('/:id/freeze', can('memberships.manage'), async (req, res) => {
  const body = z.object({ days: z.coerce.number().int().min(1).max(365), reason, override: z.boolean().default(false) }).parse(req.body);
  await tx((c) => freezeMembership(c, req, uuid.parse(req.params.id), body.days, body.reason, body.override));
  res.status(204).end();
});

membershipsRouter.post('/:id/unfreeze', can('memberships.manage'), async (req, res) => {
  await tx((c) => unfreezeMembership(c, req, uuid.parse(req.params.id)));
  res.status(204).end();
});

membershipsRouter.post('/:id/extend', can('memberships.manage'), async (req, res) => {
  const body = z.object({ days: z.coerce.number().int().min(1).max(365), reason }).parse(req.body);
  await tx((c) => extendMembership(c, req, uuid.parse(req.params.id), body.days, body.reason));
  res.status(204).end();
});

membershipsRouter.post('/:id/cancel', can('memberships.manage'), async (req, res) => {
  const body = z.object({ reason }).parse(req.body);
  await tx((c) => cancelMembership(c, req, uuid.parse(req.params.id), body.reason));
  res.status(204).end();
});
