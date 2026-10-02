import { Router, type Request } from 'express';
import { z } from 'zod';
import { one, query, tx } from '../../db/pool.js';
import { auth, branchScope, can } from '../../lib/auth.js';
import { audit } from '../../lib/audit.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { isoDate, uuid } from '../../lib/http.js';
import { PAYMENT_METHODS } from '../billing/service.js';
import { createExpense, ensureExpenseCategories } from './expenses.js';

export const employeesRouter = Router();

const monthSchema = z.string().regex(/^\d{4}-\d{2}$/, 'Expected YYYY-MM');
const monthStart = (m?: string) => (m ? `${m}-01` : new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 8) + '01');

/**
 * Work output per employee for a month, computed from the records each role
 * already produces (collections, sales, sessions, classes, assessments…), so
 * there is nothing extra for staff to log.
 */
function performanceSql(filterUser: boolean) {
  return `
    WITH period AS (SELECT $3::date AS f, ($3::date + interval '1 month') AS t),
    staff AS (
      SELECT u.id, u.full_name, u.avatar_url, r.name AS role_name, r.key AS role_key
        FROM users u JOIN roles r ON r.id = u.role_id
       WHERE u.organization_id = $1 AND u.kind = 'staff' AND u.is_active ${filterUser ? 'AND u.id = $4' : ''}
         AND (r.all_branches OR EXISTS (SELECT 1 FROM staff_branches sb WHERE sb.user_id = u.id AND sb.branch_id = ANY($2))))
    SELECT s.*,
      (SELECT COALESCE(sum(p.amount), 0) FROM payments p, period WHERE p.collected_by = s.id AND p.status = 'recorded' AND p.branch_id = ANY($2) AND p.paid_at >= period.f AND p.paid_at < period.t) AS collected,
      (SELECT count(*) FROM memberships ms, period WHERE ms.created_by = s.id AND ms.kind = 'new' AND ms.status <> 'cancelled' AND ms.branch_id = ANY($2) AND ms.created_at >= period.f AND ms.created_at < period.t)::int AS new_sales,
      (SELECT count(*) FROM memberships ms, period WHERE ms.created_by = s.id AND ms.kind = 'renewal' AND ms.status <> 'cancelled' AND ms.branch_id = ANY($2) AND ms.created_at >= period.f AND ms.created_at < period.t)::int AS renewals,
      (SELECT COALESCE(sum(i.total - i.amount_refunded), 0) FROM invoices i, period WHERE i.created_by = s.id AND i.source = 'pos' AND i.status <> 'void' AND i.branch_id = ANY($2) AND i.created_at >= period.f AND i.created_at < period.t) AS pos_sales,
      (SELECT count(*) FROM leads l, period WHERE l.assigned_to = s.id AND l.stage = 'won' AND l.branch_id = ANY($2) AND l.converted_at >= period.f AND l.converted_at < period.t)::int AS leads_won,
      (SELECT count(*) FROM follow_ups f, period WHERE f.completed_by = s.id AND f.status = 'done' AND f.branch_id = ANY($2) AND f.completed_at >= period.f AND f.completed_at < period.t)::int AS followups_done,
      (SELECT count(*) FROM appointments a, period WHERE a.staff_id = s.id AND a.type = 'pt' AND a.status = 'completed' AND a.branch_id = ANY($2) AND a.starts_at >= period.f AND a.starts_at < period.t)::int AS pt_sessions,
      (SELECT count(*) FROM appointments a, period WHERE a.staff_id = s.id AND a.type = 'pt' AND a.status = 'no_show' AND a.branch_id = ANY($2) AND a.starts_at >= period.f AND a.starts_at < period.t)::int AS pt_no_shows,
      (SELECT count(*) FROM class_sessions cs, period WHERE cs.trainer_id = s.id AND cs.status <> 'cancelled' AND cs.starts_at < now() AND cs.branch_id = ANY($2) AND cs.starts_at >= period.f AND cs.starts_at < period.t)::int AS classes_taught,
      (SELECT count(*) FROM class_bookings cb JOIN class_sessions cs ON cs.id = cb.session_id, period WHERE cs.trainer_id = s.id AND cb.status = 'attended' AND cs.branch_id = ANY($2) AND cs.starts_at >= period.f AND cs.starts_at < period.t)::int AS class_attendees,
      (SELECT count(*) FROM fitness_assessments fa, period WHERE fa.assessed_by = s.id AND fa.branch_id = ANY($2) AND fa.assessed_on >= period.f AND fa.assessed_on < period.t)::int AS assessments,
      (SELECT count(DISTINCT sa.clock_in::date) FROM staff_attendance sa, period WHERE sa.user_id = s.id AND sa.branch_id = ANY($2) AND sa.clock_in >= period.f AND sa.clock_in < period.t)::int AS days_present,
      (SELECT COALESCE(round(sum(extract(epoch FROM (COALESCE(sa.clock_out, LEAST(now(), sa.clock_in + interval '12 hours')) - sa.clock_in)) / 3600)::numeric, 1), 0)
         FROM staff_attendance sa, period WHERE sa.user_id = s.id AND sa.branch_id = ANY($2) AND sa.clock_in >= period.f AND sa.clock_in < period.t) AS hours
    FROM staff s ORDER BY s.full_name`;
}

employeesRouter.get('/performance', can('staff.read'), async (req, res) => {
  const { month } = z.object({ month: monthSchema.optional() }).parse(req.query);
  res.json(await query(performanceSql(false), [auth(req).orgId, branchScope(req), monthStart(month)]));
});

async function loadEmployee(req: Request, id: string) {
  const e = await one(
    `SELECT u.id, u.full_name, u.email, u.phone, u.avatar_url, u.is_active, u.last_login_at, u.created_at,
            r.name AS role_name, r.key AS role_key, r.all_branches, e.designation, e.joining_date, e.salary, e.salary_type, e.commission_pct,
            e.emergency_contact, e.address, e.notes,
            COALESCE((SELECT json_agg(json_build_object('id', b.id, 'name', b.name) ORDER BY b.name)
                        FROM staff_branches sb JOIN branches b ON b.id = sb.branch_id WHERE sb.user_id = u.id), '[]') AS branches,
            (SELECT array_agg(sb.branch_id) FROM staff_branches sb WHERE sb.user_id = u.id) AS branch_ids
       FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN employees e ON e.user_id = u.id
      WHERE u.id = $1 AND u.organization_id = $2 AND u.kind = 'staff'`,
    [id, auth(req).orgId],
  );
  // Same visibility as the employee list: someone in one of your branches.
  if (!e || (!e.all_branches && !auth(req).allBranches && !(e.branch_ids ?? []).some((b: string) => auth(req).branchIds.includes(b)))) throw notFound('Employee');
  return e;
}

employeesRouter.get('/:id', can('staff.read'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const e = await loadEmployee(req, id);
  const salaryAccess = auth(req).permissions.has('staff.salary');
  const scope = [auth(req).orgId, branchScope(req)];
  const [perf, trend, attendance, payouts] = await Promise.all([
    one(performanceSql(true), [...scope, monthStart(), id]),
    // Six months of the headline numbers, one series each.
    query(
      `SELECT to_char(m, 'YYYY-MM-01') AS date,
              (SELECT COALESCE(sum(p.amount), 0) FROM payments p WHERE p.collected_by = $3 AND p.status = 'recorded' AND p.branch_id = ANY($2) AND p.paid_at >= m AND p.paid_at < m + interval '1 month') AS collected,
              (SELECT count(*) FROM appointments a WHERE a.staff_id = $3 AND a.type = 'pt' AND a.status = 'completed' AND a.branch_id = ANY($2) AND a.starts_at >= m AND a.starts_at < m + interval '1 month')::int AS pt_sessions,
              (SELECT count(*) FROM class_sessions cs WHERE cs.trainer_id = $3 AND cs.status <> 'cancelled' AND cs.starts_at < now() AND cs.branch_id = ANY($2) AND cs.starts_at >= m AND cs.starts_at < m + interval '1 month')::int AS classes,
              (SELECT COALESCE(round(sum(extract(epoch FROM (COALESCE(sa.clock_out, LEAST(now(), sa.clock_in + interval '12 hours')) - sa.clock_in)) / 3600)::numeric, 1), 0)
                 FROM staff_attendance sa WHERE sa.user_id = $3 AND sa.branch_id = ANY($2) AND sa.clock_in >= m AND sa.clock_in < m + interval '1 month') AS hours
         FROM generate_series(date_trunc('month', current_date) - interval '5 months', date_trunc('month', current_date), interval '1 month') m
        WHERE $1::uuid IS NOT NULL ORDER BY m`,
      [...scope, id],
    ),
    query(
      `SELECT sa.id, sa.clock_in, sa.clock_out, sa.method, b.name AS branch_name,
              round((extract(epoch FROM (COALESCE(sa.clock_out, now()) - sa.clock_in)) / 3600)::numeric, 1) AS hours
         FROM staff_attendance sa JOIN branches b ON b.id = sa.branch_id
        WHERE sa.user_id = $1 AND sa.branch_id = ANY($2) ORDER BY sa.clock_in DESC LIMIT 30`,
      [id, branchScope(req)],
    ),
    salaryAccess
      ? query(
        `SELECT e.id, e.expense_number, e.amount, e.salary_month, e.expense_date, e.method, e.reference, e.status, e.description, b.name AS branch_name
           FROM expenses e JOIN branches b ON b.id = e.branch_id WHERE e.employee_id = $1 AND e.salary_month IS NOT NULL ORDER BY e.salary_month DESC LIMIT 24`,
        [id],
      )
      : Promise.resolve(null),
  ]);
  const { branch_ids, ...rest } = e;
  res.json({
    ...rest,
    ...(salaryAccess ? {} : { salary: undefined, salary_type: undefined, commission_pct: undefined }),
    salaryAccess,
    performance: perf,
    trend,
    attendance,
    payouts,
  });
});

const hrSchema = z.object({
  emergencyContact: z.string().trim().max(120).optional().nullable(),
  address: z.string().trim().max(300).optional().nullable(),
  notes: z.string().trim().max(1000).optional().nullable(),
  salary: z.coerce.number().min(0).max(10_000_000).optional().nullable(),
  salaryType: z.enum(['monthly', 'hourly', 'per_session']).optional(),
  commissionPct: z.coerce.number().min(0).max(100).optional().nullable(),
});

employeesRouter.put('/:id/hr', can('staff.manage'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const b = hrSchema.parse(req.body);
  const pay = b.salary !== undefined || b.salaryType !== undefined || b.commissionPct !== undefined;
  if (pay && !auth(req).permissions.has('staff.salary')) throw forbidden('You cannot change salary details');
  const before = await loadEmployee(req, id);
  await tx(async (c) => {
    await c.query(`INSERT INTO employees (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [id]);
    await c.query(
      `UPDATE employees SET emergency_contact = $2, address = $3, notes = $4,
              salary = CASE WHEN $5 THEN $6 ELSE salary END, salary_type = CASE WHEN $5 THEN COALESCE($7, salary_type) ELSE salary_type END,
              commission_pct = CASE WHEN $5 THEN $8 ELSE commission_pct END
        WHERE user_id = $1`,
      [id, b.emergencyContact ?? null, b.address ?? null, b.notes ?? null, pay, b.salary ?? null, b.salaryType ?? null, b.commissionPct ?? null],
    );
    await audit(c, req, {
      action: pay ? 'staff.salary_updated' : 'staff.hr_updated', entityType: 'user', entityId: id,
      summary: `${before.full_name}'s ${pay ? 'pay and ' : ''}HR details updated`,
      // Salary values stay out of the audit trail's plain view; the change itself is recorded.
      before: pay ? { salary_type: before.salary_type, salary_changed: before.salary !== (b.salary ?? null) } : undefined,
    });
  });
  res.status(204).end();
});

/** Records a salary payout as a Salaries expense tied to the employee and month. */
employeesRouter.post('/:id/salary', can('staff.salary', 'expenses.manage'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const b = z.object({
    month: monthSchema,
    amount: z.coerce.number().positive().max(10_000_000),
    branchId: uuid,
    method: z.enum(PAYMENT_METHODS),
    reference: z.string().trim().max(80).optional().nullable(),
    paidOn: isoDate.optional().nullable(),
    notes: z.string().trim().max(300).optional().nullable(),
  }).parse(req.body);
  const e = await loadEmployee(req, id);
  if (`${b.month}-01` > monthStart()) throw badRequest('You can’t pay salary for a future month');
  const row = await tx(async (c) => {
    const cats = await ensureExpenseCategories(c, auth(req).orgId);
    return createExpense(c, req, {
      branchId: b.branchId, categoryId: cats.salaries, amount: b.amount, expenseDate: b.paidOn ?? null, method: b.method, reference: b.reference ?? null,
      vendor: e.full_name, employeeId: id, salaryMonth: `${b.month}-01`,
      description: `Salary for ${new Date(`${b.month}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })}${b.notes ? ` — ${b.notes}` : ''}`,
    });
  });
  res.status(201).json(row);
});
