import { Router } from 'express';
import { z } from 'zod';
import { one, query, tx } from '../../db/pool.js';
import { assertBranch, auth, branchScope, can, hashPassword, temporaryPassword } from '../../lib/auth.js';
import { createMember, memberCreateSchema, profileFields } from './service.js';
import { compileRules, segmentRules } from '../crm/segments.js';
import { audit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { paginationSchema, paged, uuid } from '../../lib/http.js';

export const membersRouter = Router();

const STATUSES = ['active', 'expiring_soon', 'expired', 'frozen', 'cancelled', 'pending', 'none'] as const;

const listSchema = paginationSchema.extend({
  search: z.string().trim().optional(),
  status: z.enum(STATUSES).optional(),
  sort: z.enum(['name', 'joined', 'expiry']).default('joined'),
  outstanding: z.coerce.boolean().optional(),
  segmentId: uuid.optional(),
});

membersRouter.get('/', can('members.read'), async (req, res) => {
  const q = listSchema.parse(req.query);
  const params: unknown[] = [auth(req).orgId, branchScope(req)];
  const where = [`m.organization_id = $1`, `m.branch_id = ANY($2)`];
  if (q.search) {
    params.push(`%${q.search}%`);
    where.push(`(u.full_name ILIKE $${params.length} OR u.phone ILIKE $${params.length} OR u.email ILIKE $${params.length} OR m.member_code ILIKE $${params.length})`);
  }
  if (q.status) {
    params.push(q.status);
    where.push(`cm.status = $${params.length}`);
  }
  if (q.outstanding) where.push(`bal.outstanding > 0`);
  if (q.segmentId) {
    const seg = await one(`SELECT rules FROM segments WHERE id = $1 AND organization_id = $2`, [q.segmentId, auth(req).orgId]);
    if (!seg) throw notFound('Segment');
    where.push(...compileRules(segmentRules.parse(seg.rules), params));
  }
  const order = { name: 'u.full_name ASC', joined: 'm.join_date DESC, m.created_at DESC', expiry: 'cm.end_date ASC NULLS LAST' }[q.sort];
  params.push(q.pageSize, (q.page - 1) * q.pageSize);

  const rows = await query(
    `SELECT m.id, m.member_code, u.full_name, u.phone, u.email, u.avatar_url, m.gender, m.join_date,
            b.name AS branch_name, cm.plan_name, cm.status, cm.end_date, cm.days_remaining,
            bal.outstanding, bal.lifetime_value, su.full_name AS assigned_staff, vs.last_visit_at, vs.visits_30d,
            count(*) OVER() AS total_count
       FROM members m
       JOIN users u ON u.id = m.user_id
       JOIN branches b ON b.id = m.branch_id
       JOIN member_current_membership cm ON cm.member_id = m.id
       JOIN member_balances bal ON bal.member_id = m.id
       JOIN member_visit_stats vs ON vs.member_id = m.id
       LEFT JOIN users su ON su.id = m.assigned_staff_id
      WHERE ${where.join(' AND ')}
      ORDER BY ${order}
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  res.json(paged(rows, q.page, q.pageSize));
});

membersRouter.post('/', can('members.write'), async (req, res) => {
  const body = memberCreateSchema.parse(req.body);
  res.status(201).json(await tx((c) => createMember(c, req, body)));
});

async function loadMember(req: Parameters<typeof auth>[0], id: string) {
  const member = await one(
    `SELECT m.*, u.full_name, u.email, u.phone, u.avatar_url, u.is_active AS app_active, u.last_login_at,
            (u.password_hash IS NOT NULL) AS has_app_access, u.must_change_password,
            b.name AS branch_name, su.full_name AS assigned_staff
       FROM members m JOIN users u ON u.id = m.user_id JOIN branches b ON b.id = m.branch_id
       LEFT JOIN users su ON su.id = m.assigned_staff_id
      WHERE m.id = $1 AND m.organization_id = $2`,
    [id, auth(req).orgId],
  );
  if (!member || !auth(req).branchIds.includes(member.branch_id)) throw notFound('Member');
  return member;
}

membersRouter.get('/:id', can('members.read'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const member = await loadMember(req, id);
  const [current, balance, stats, sessions, origin] = await Promise.all([
    one(`SELECT * FROM member_current_membership WHERE member_id = $1`, [id]),
    one(`SELECT b.*, v.last_visit_at, v.visits_30d, v.visits_total FROM member_balances b JOIN member_visit_stats v ON v.member_id = b.member_id WHERE b.member_id = $1`, [id]),
    one(
      `SELECT count(*) FILTER (WHERE status = 'recorded') AS payment_count,
              max(paid_at) FILTER (WHERE status = 'recorded') AS last_payment_at
         FROM payments WHERE member_id = $1`,
      [id],
    ),
    query(
      `SELECT id, client, user_agent, created_at, last_used_at FROM sessions
        WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_used_at DESC LIMIT 5`,
      [member.user_id],
    ),
    one(
      `SELECT l.id, l.created_at, l.converted_at, s.name AS source_name, u.full_name AS assigned_name,
              ru.full_name AS referred_by_name, l.referred_by_member_id
         FROM leads l LEFT JOIN lead_sources s ON s.id = l.source_id LEFT JOIN users u ON u.id = l.assigned_to
         LEFT JOIN members rm ON rm.id = l.referred_by_member_id LEFT JOIN users ru ON ru.id = rm.user_id
        WHERE l.converted_member_id = $1 ORDER BY l.converted_at DESC LIMIT 1`,
      [id],
    ),
  ]);
  res.json({ ...member, current_membership: current, balance, stats, app_sessions: sessions, lead_origin: origin ?? null });
});

membersRouter.patch('/:id', can('members.write'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const body = z.object(profileFields).partial().extend({ branchId: uuid.optional() }).parse(req.body);
  const before = await loadMember(req, id);
  if (body.branchId) assertBranch(req, body.branchId);

  await tx(async (c) => {
    await c.query(
      `UPDATE users SET full_name = COALESCE($2, full_name), email = CASE WHEN $3::boolean THEN $4 ELSE email END,
              phone = COALESCE($5, phone), updated_at = now() WHERE id = $1`,
      [before.user_id, body.fullName ?? null, body.email !== undefined, body.email ?? null, body.phone ?? null],
    );
    const map: Record<string, string> = {
      dateOfBirth: 'date_of_birth', gender: 'gender', address: 'address', emergencyContactName: 'emergency_contact_name',
      emergencyContactPhone: 'emergency_contact_phone', source: 'source', notes: 'notes', assignedStaffId: 'assigned_staff_id', branchId: 'branch_id',
    };
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [key, col] of Object.entries(map)) {
      if ((body as any)[key] !== undefined) {
        params.push((body as any)[key]);
        sets.push(`${col} = $${params.length}`);
      }
    }
    if (sets.length) await c.query(`UPDATE members SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
    await audit(c, req, {
      action: 'member.updated',
      entityType: 'member',
      entityId: id,
      branchId: before.branch_id,
      summary: `${before.full_name}'s profile updated`,
      before: Object.fromEntries(
        Object.keys(body).map((k) => [k, before[map[k] ?? k.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase())]]),
      ),
      after: body,
    });
  });
  res.json(await loadMember(req, id));
});

membersRouter.get('/:id/memberships', can('members.read'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  await loadMember(req, id);
  res.json(
    await query(
      `SELECT ms.*, p.name AS plan_name, p.freeze_days_allowed, cu.full_name AS created_by_name,
              effective_membership_status(ms.status, ms.end_date, ms.frozen_until, o.expiring_soon_days) AS effective_status,
              (SELECT i.invoice_number FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE ii.membership_id = ms.id LIMIT 1) AS invoice_number,
              (SELECT i.id FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE ii.membership_id = ms.id LIMIT 1) AS invoice_id
         FROM memberships ms JOIN membership_plans p ON p.id = ms.plan_id
         JOIN organizations o ON o.id = ms.organization_id
         LEFT JOIN users cu ON cu.id = ms.created_by
        WHERE ms.member_id = $1 ORDER BY ms.start_date DESC, ms.created_at DESC`,
      [id],
    ),
  );
});

membersRouter.get('/:id/classes', can('members.read'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  await loadMember(req, id);
  res.json(await query(
    `SELECT cb.id, cb.session_id, cb.status, cb.source, cb.created_at, cs.starts_at, ct.name AS class_name, tu.full_name AS trainer_name
       FROM class_bookings cb JOIN class_sessions cs ON cs.id = cb.session_id JOIN class_types ct ON ct.id = cs.class_type_id
       LEFT JOIN users tu ON tu.id = cs.trainer_id
      WHERE cb.member_id = $1 ORDER BY cs.starts_at DESC LIMIT 100`,
    [id],
  ));
});

membersRouter.get('/:id/activity', can('members.read'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  await loadMember(req, id);
  res.json(
    await query(
      `SELECT a.id, a.action, a.summary, a.created_at, u.full_name AS actor
         FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
        WHERE (a.entity_type = 'member' AND a.entity_id = $1)
           OR (a.entity_type = 'membership' AND a.entity_id IN (SELECT id FROM memberships WHERE member_id = $1))
           OR (a.entity_type = 'payment' AND a.entity_id IN (SELECT id FROM payments WHERE member_id = $1))
           OR (a.entity_type = 'invoice' AND a.entity_id IN (SELECT id FROM invoices WHERE member_id = $1))
        ORDER BY a.created_at DESC LIMIT 50`,
      [id],
    ),
  );
});

// Issue or reset Member App credentials. The temporary password is returned
// exactly once so staff can hand it over; only its hash is stored.
membersRouter.post('/:id/credentials', can('members.credentials'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const member = await loadMember(req, id);
  if (!member.email && !member.phone) throw badRequest('Add an email or phone number first');
  const password = temporaryPassword();
  await tx(async (c) => {
    await c.query(`UPDATE users SET password_hash = $2, must_change_password = true, is_active = true, updated_at = now() WHERE id = $1`, [
      member.user_id,
      await hashPassword(password),
    ]);
    await c.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [member.user_id]);
    await audit(c, req, {
      action: member.has_app_access ? 'member.credentials_reset' : 'member.credentials_issued',
      entityType: 'member',
      entityId: id,
      branchId: member.branch_id,
      summary: `App credentials ${member.has_app_access ? 'reset' : 'issued'} for ${member.full_name}`,
    });
  });
  res.json({ login: member.email ?? member.phone, temporaryPassword: password });
});

membersRouter.patch('/:id/app-access', can('members.credentials'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const { active } = z.object({ active: z.boolean() }).parse(req.body);
  const member = await loadMember(req, id);
  await tx(async (c) => {
    await c.query(`UPDATE users SET is_active = $2, updated_at = now() WHERE id = $1`, [member.user_id, active]);
    if (!active) await c.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [member.user_id]);
    await audit(c, req, {
      action: active ? 'member.app_enabled' : 'member.app_disabled',
      entityType: 'member',
      entityId: id,
      branchId: member.branch_id,
      summary: `App access ${active ? 'enabled' : 'disabled'} for ${member.full_name}`,
      before: { active: member.app_active },
      after: { active },
    });
  });
  res.json({ active });
});
