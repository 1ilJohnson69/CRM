import { Router } from 'express';
import { z } from 'zod';
import { one, query, tx } from '../../db/pool.js';
import { auth, can, hashPassword, temporaryPassword } from '../../lib/auth.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { isoDate, paginationSchema, paged, uuid } from '../../lib/http.js';
import { PERMISSIONS } from '../../lib/permissions.js';

export const adminRouter = Router();

// -------------------------------------------------------------- branches ----

const branchSchema = z.object({
  name: z.string().trim().min(2),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,8}$/, 'Use 2–8 letters or digits'),
  address: z.string().trim().optional().nullable(),
  phone: z.string().trim().optional().nullable(),
  email: z.string().trim().email().optional().nullable().or(z.literal('').transform(() => null)),
  isActive: z.boolean().default(true),
});

adminRouter.get('/branches', async (req, res) => {
  res.json(
    await query(
      `SELECT b.*,
              (SELECT count(*) FROM members m WHERE m.branch_id = b.id) AS member_count,
              (SELECT count(*) FROM members m JOIN member_current_membership cm ON cm.member_id = m.id
                WHERE m.branch_id = b.id AND cm.status IN ('active','expiring_soon')) AS active_members,
              (SELECT count(*) FROM staff_branches sb WHERE sb.branch_id = b.id) AS staff_count
         FROM branches b WHERE b.organization_id = $1 AND b.id = ANY($2) ORDER BY b.name`,
      [auth(req).orgId, auth(req).branchIds],
    ),
  );
});

adminRouter.post('/branches', can('branches.manage'), async (req, res) => {
  const b = branchSchema.parse(req.body);
  const branch = await tx(async (c) => {
    const row = await one(
      `INSERT INTO branches (organization_id, name, code, address, phone, email, is_active) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [auth(req).orgId, b.name, b.code, b.address ?? null, b.phone ?? null, b.email ?? null, b.isActive],
      c,
    );
    await audit(c, req, { action: 'branch.created', entityType: 'branch', entityId: row.id, branchId: row.id, summary: `Branch ${b.name} created`, after: b });
    return row;
  });
  res.status(201).json(branch);
});

adminRouter.put('/branches/:id', can('branches.manage'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const b = branchSchema.parse(req.body);
  const branch = await tx(async (c) => {
    const before = await one(`SELECT * FROM branches WHERE id = $1 AND organization_id = $2`, [id, auth(req).orgId], c);
    if (!before) throw notFound('Branch');
    const row = await one(
      `UPDATE branches SET name=$2, code=$3, address=$4, phone=$5, email=$6, is_active=$7 WHERE id=$1 RETURNING *`,
      [id, b.name, b.code, b.address ?? null, b.phone ?? null, b.email ?? null, b.isActive],
      c,
    );
    await audit(c, req, { action: 'branch.updated', entityType: 'branch', entityId: id, branchId: id, summary: `Branch ${b.name} updated`, before, after: b });
    return row;
  });
  res.json(branch);
});

// ------------------------------------------------------------- employees ----

adminRouter.get('/staff', can('staff.read'), async (req, res) => {
  const q = paginationSchema.extend({ search: z.string().optional() }).parse(req.query);
  const params: unknown[] = [auth(req).orgId, auth(req).branchIds, q.search ? `%${q.search}%` : null, q.pageSize, (q.page - 1) * q.pageSize];
  const rows = await query(
    `SELECT u.id, u.full_name, u.email, u.phone, u.avatar_url, u.is_active, u.last_login_at, u.created_at,
            r.id AS role_id, r.name AS role_name, r.key AS role_key, r.all_branches,
            e.designation, e.joining_date,
            COALESCE((SELECT json_agg(json_build_object('id', b.id, 'name', b.name) ORDER BY b.name)
                        FROM staff_branches sb JOIN branches b ON b.id = sb.branch_id WHERE sb.user_id = u.id), '[]') AS branches,
            count(*) OVER() AS total_count
       FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN employees e ON e.user_id = u.id
      WHERE u.organization_id = $1 AND u.kind = 'staff'
        AND (r.all_branches OR EXISTS (SELECT 1 FROM staff_branches sb WHERE sb.user_id = u.id AND sb.branch_id = ANY($2)))
        AND ($3::text IS NULL OR u.full_name ILIKE $3 OR u.email ILIKE $3 OR u.phone ILIKE $3)
      ORDER BY u.is_active DESC, u.full_name
      LIMIT $4 OFFSET $5`,
    params,
  );
  res.json(paged(rows, q.page, q.pageSize));
});

const staffSchema = z.object({
  fullName: z.string().trim().min(2),
  email: z.string().trim().email().toLowerCase(),
  phone: z.string().trim().transform((v) => v.replace(/[\s-]/g, '')).pipe(z.string().regex(/^\+?\d{10,13}$/, 'Enter a valid phone number')),
  roleId: uuid,
  branchIds: z.array(uuid).default([]),
  designation: z.string().trim().optional().nullable(),
  joiningDate: isoDate.optional().nullable(),
  isActive: z.boolean().default(true),
});

async function checkRoleAssignable(req: any, roleId: string, branchIds: string[]) {
  const role = await one(`SELECT * FROM roles WHERE id = $1 AND organization_id = $2`, [roleId, auth(req).orgId]);
  if (!role) throw badRequest('Unknown role');
  // Only someone who already has every permission of a role may hand it out.
  const perms = (await query(`SELECT permission_key FROM role_permissions WHERE role_id = $1`, [roleId])).map((r) => r.permission_key);
  if (perms.some((p) => !auth(req).permissions.has(p)) || (role.all_branches && !auth(req).allBranches)) {
    throw forbidden('You cannot assign a role with more access than your own');
  }
  if (!role.all_branches && !branchIds.length) throw badRequest('Assign at least one branch');
  if (branchIds.some((b) => !auth(req).branchIds.includes(b))) throw forbidden('You do not have access to one of those branches');
  return role;
}

adminRouter.post('/staff', can('staff.manage'), async (req, res) => {
  const body = staffSchema.parse(req.body);
  const role = await checkRoleAssignable(req, body.roleId, body.branchIds);
  const password = temporaryPassword();
  const user = await tx(async (c) => {
    const u = await one(
      `INSERT INTO users (organization_id, kind, role_id, full_name, email, phone, password_hash, must_change_password, is_active)
       VALUES ($1,'staff',$2,$3,$4,$5,$6,true,$7) RETURNING id, full_name`,
      [auth(req).orgId, body.roleId, body.fullName, body.email, body.phone, await hashPassword(password), body.isActive],
      c,
    );
    await c.query(`INSERT INTO employees (user_id, designation, joining_date) VALUES ($1,$2,$3)`, [u!.id, body.designation ?? null, body.joiningDate ?? null]);
    for (const b of role.all_branches ? [] : body.branchIds) await c.query(`INSERT INTO staff_branches (user_id, branch_id) VALUES ($1,$2)`, [u!.id, b]);
    await audit(c, req, {
      action: 'staff.created',
      entityType: 'user',
      entityId: u!.id,
      summary: `${body.fullName} added as ${role.name}`,
      after: { email: body.email, role: role.name, branches: body.branchIds },
    });
    return u;
  });
  res.status(201).json({ ...user, credentials: { login: body.email, temporaryPassword: password } });
});

adminRouter.put('/staff/:id', can('staff.manage'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const body = staffSchema.parse(req.body);
  if (id === auth(req).userId && !body.isActive) throw conflict('You cannot deactivate your own account');
  const role = await checkRoleAssignable(req, body.roleId, body.branchIds);
  await tx(async (c) => {
    const before = await one(
      `SELECT u.*, r.name AS role_name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1 AND u.organization_id = $2 AND u.kind = 'staff'`,
      [id, auth(req).orgId],
      c,
    );
    if (!before) throw notFound('Employee');
    await c.query(`UPDATE users SET full_name=$2, email=$3, phone=$4, role_id=$5, is_active=$6, updated_at=now() WHERE id=$1`, [
      id, body.fullName, body.email, body.phone, body.roleId, body.isActive,
    ]);
    await c.query(
      `INSERT INTO employees (user_id, designation, joining_date) VALUES ($1,$2,$3)
       ON CONFLICT (user_id) DO UPDATE SET designation = EXCLUDED.designation, joining_date = EXCLUDED.joining_date`,
      [id, body.designation ?? null, body.joiningDate ?? null],
    );
    await c.query(`DELETE FROM staff_branches WHERE user_id = $1`, [id]);
    for (const b of role.all_branches ? [] : body.branchIds) await c.query(`INSERT INTO staff_branches (user_id, branch_id) VALUES ($1,$2)`, [id, b]);
    if (!body.isActive) await c.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [id]);
    await audit(c, req, {
      action: 'staff.updated',
      entityType: 'user',
      entityId: id,
      summary: `${body.fullName}'s employee record updated`,
      before: { role: before.role_name, active: before.is_active, email: before.email },
      after: { role: role.name, active: body.isActive, email: body.email, branches: body.branchIds },
    });
  });
  res.status(204).end();
});

adminRouter.post('/staff/:id/reset-password', can('staff.manage'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const password = temporaryPassword();
  await tx(async (c) => {
    const u = await one(`SELECT full_name, email FROM users WHERE id = $1 AND organization_id = $2 AND kind = 'staff'`, [id, auth(req).orgId], c);
    if (!u) throw notFound('Employee');
    await c.query(`UPDATE users SET password_hash = $2, must_change_password = true WHERE id = $1`, [id, await hashPassword(password)]);
    await c.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [id]);
    await audit(c, req, { action: 'staff.password_reset', entityType: 'user', entityId: id, summary: `Password reset for ${u.full_name}` });
  });
  res.json({ temporaryPassword: password });
});

// ------------------------------------------------------ roles & permissions ----

adminRouter.get('/permissions', can('roles.manage'), (_req, res) => {
  res.json(PERMISSIONS);
});

adminRouter.get('/roles', async (req, res) => {
  if (!auth(req).permissions.has('roles.manage') && !auth(req).permissions.has('staff.manage')) throw forbidden();
  res.json(
    await query(
      `SELECT r.*, COALESCE(array_agg(rp.permission_key) FILTER (WHERE rp.permission_key IS NOT NULL), '{}') AS permissions,
              (SELECT count(*) FROM users u WHERE u.role_id = r.id AND u.is_active) AS user_count
         FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
        WHERE r.organization_id = $1 GROUP BY r.id ORDER BY r.is_system DESC, r.name`,
      [auth(req).orgId],
    ),
  );
});

const roleSchema = z.object({
  name: z.string().trim().min(2),
  description: z.string().trim().optional().nullable(),
  allBranches: z.boolean().default(false),
  permissions: z.array(z.enum(PERMISSIONS.map((p) => p.key) as [string, ...string[]])),
});

adminRouter.post('/roles', can('roles.manage'), async (req, res) => {
  const body = roleSchema.parse(req.body);
  const key = body.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const role = await tx(async (c) => {
    const r = await one(
      `INSERT INTO roles (organization_id, key, name, description, all_branches) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [auth(req).orgId, key, body.name, body.description ?? null, body.allBranches],
      c,
    );
    for (const p of body.permissions) await c.query(`INSERT INTO role_permissions (role_id, permission_key) VALUES ($1,$2)`, [r.id, p]);
    await audit(c, req, { action: 'role.created', entityType: 'role', entityId: r.id, summary: `Role ${body.name} created`, after: body });
    return r;
  });
  res.status(201).json(role);
});

adminRouter.put('/roles/:id', can('roles.manage'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const body = roleSchema.parse(req.body);
  await tx(async (c) => {
    const before = await one(
      `SELECT r.*, COALESCE(array_agg(rp.permission_key) FILTER (WHERE rp.permission_key IS NOT NULL), '{}') AS permissions
         FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id WHERE r.id = $1 AND r.organization_id = $2 GROUP BY r.id`,
      [id, auth(req).orgId],
      c,
    );
    if (!before) throw notFound('Role');
    if (before.key === 'super_admin') throw conflict('The Super Admin role always has full access and cannot be edited');
    await c.query(`UPDATE roles SET name=$2, description=$3, all_branches=$4 WHERE id=$1`, [id, body.name, body.description ?? null, body.allBranches]);
    await c.query(`DELETE FROM role_permissions WHERE role_id = $1`, [id]);
    for (const p of body.permissions) await c.query(`INSERT INTO role_permissions (role_id, permission_key) VALUES ($1,$2)`, [id, p]);
    await audit(c, req, {
      action: 'role.updated',
      entityType: 'role',
      entityId: id,
      summary: `Permissions for ${body.name} updated`,
      before: { permissions: before.permissions, all_branches: before.all_branches },
      after: { permissions: body.permissions, all_branches: body.allBranches },
    });
  });
  res.status(204).end();
});

// -------------------------------------------------------------- settings ----

adminRouter.get('/organization', async (req, res) => {
  res.json(await one(`SELECT * FROM organizations WHERE id = $1`, [auth(req).orgId]));
});

adminRouter.put('/organization', can('settings.manage'), async (req, res) => {
  const body = z
    .object({
      name: z.string().trim().min(2),
      legalName: z.string().trim().optional().nullable(),
      gstin: z.string().trim().optional().nullable(),
      invoicePrefix: z.string().trim().toUpperCase().regex(/^[A-Z]{2,6}$/),
      expiringSoonDays: z.coerce.number().int().min(1).max(60),
      renewalReminderDays: z.array(z.coerce.number().int().min(0).max(90)),
    })
    .parse(req.body);
  await tx(async (c) => {
    const before = await one(`SELECT * FROM organizations WHERE id = $1`, [auth(req).orgId], c);
    await c.query(
      `UPDATE organizations SET name=$2, legal_name=$3, gstin=$4, invoice_prefix=$5, expiring_soon_days=$6, renewal_reminder_days=$7 WHERE id=$1`,
      [auth(req).orgId, body.name, body.legalName ?? null, body.gstin ?? null, body.invoicePrefix, body.expiringSoonDays, body.renewalReminderDays],
    );
    await audit(c, req, { action: 'settings.updated', entityType: 'organization', entityId: auth(req).orgId, summary: 'Organization settings updated', before, after: body });
  });
  res.status(204).end();
});

// ------------------------------------------------------------ audit logs ----

adminRouter.get('/audit-logs', can('audit.read'), async (req, res) => {
  const q = paginationSchema
    .extend({ search: z.string().trim().optional(), entityType: z.string().optional(), actorId: uuid.optional() })
    .parse(req.query);
  const params: unknown[] = [auth(req).orgId, auth(req).branchIds];
  const where = [`a.organization_id = $1`, `(a.branch_id IS NULL OR a.branch_id = ANY($2))`];
  if (q.search) {
    params.push(`%${q.search}%`);
    where.push(`a.summary ILIKE $${params.length}`);
  }
  if (q.entityType) {
    params.push(q.entityType);
    where.push(`a.entity_type = $${params.length}`);
  }
  if (q.actorId) {
    params.push(q.actorId);
    where.push(`a.actor_id = $${params.length}`);
  }
  params.push(q.pageSize, (q.page - 1) * q.pageSize);
  const rows = await query(
    `SELECT a.id, a.action, a.entity_type, a.entity_id, a.summary, a.before, a.after, a.ip, a.created_at,
            u.full_name AS actor, b.name AS branch_name, count(*) OVER() AS total_count
       FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id LEFT JOIN branches b ON b.id = a.branch_id
      WHERE ${where.join(' AND ')}
      ORDER BY a.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  res.json(paged(rows, q.page, q.pageSize));
});
