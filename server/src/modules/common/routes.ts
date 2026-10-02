import { Router } from 'express';
import { z } from 'zod';
import { pool, query } from '../../db/pool.js';
import { auth, can, requireStaff } from '../../lib/auth.js';
import { uuid } from '../../lib/http.js';

export const commonRouter = Router();

// Global search across members, invoices and payments (by name, phone,
// email, member ID, invoice number or UPI/bank reference).
commonRouter.get('/search', requireStaff, async (req, res) => {
  const { q } = z.object({ q: z.string().trim().min(2) }).parse(req.query);
  const like = `%${q}%`;
  const ctx = auth(req);
  const has = (p: string) => ctx.permissions.has(p);
  const [members, invoices, payments, staff, leads] = await Promise.all([
    has('members.read')
      ? query(
          `SELECT m.id, u.full_name AS title, concat_ws(' · ', m.member_code, u.phone) AS subtitle, cm.status
             FROM members m JOIN users u ON u.id = m.user_id JOIN member_current_membership cm ON cm.member_id = m.id
            WHERE m.organization_id = $1 AND m.branch_id = ANY($2)
              AND (u.full_name ILIKE $3 OR u.phone ILIKE $3 OR u.email ILIKE $3 OR m.member_code ILIKE $3)
            ORDER BY similarity(u.full_name, $4) DESC LIMIT 6`,
          [ctx.orgId, ctx.branchIds, like, q],
        )
      : [],
    has('invoices.read')
      ? query(
          `SELECT i.id, i.invoice_number AS title, concat_ws(' · ', COALESCE(u.full_name, i.customer_name), '₹' || i.total) AS subtitle, i.status
             FROM invoices i LEFT JOIN members m ON m.id = i.member_id LEFT JOIN users u ON u.id = m.user_id
            WHERE i.organization_id = $1 AND i.branch_id = ANY($2) AND i.invoice_number ILIKE $3
            ORDER BY i.created_at DESC LIMIT 4`,
          [ctx.orgId, ctx.branchIds, like],
        )
      : [],
    has('payments.read')
      ? query(
          `SELECT p.id, p.invoice_id, p.receipt_number AS title, concat_ws(' · ', COALESCE(u.full_name, i.customer_name), upper(p.method), p.reference) AS subtitle, p.status
             FROM payments p JOIN invoices i ON i.id = p.invoice_id LEFT JOIN members m ON m.id = p.member_id LEFT JOIN users u ON u.id = m.user_id
            WHERE p.organization_id = $1 AND p.branch_id = ANY($2) AND (p.reference ILIKE $3 OR p.receipt_number ILIKE $3)
            ORDER BY p.paid_at DESC LIMIT 4`,
          [ctx.orgId, ctx.branchIds, like],
        )
      : [],
    has('staff.read')
      ? query(
          `SELECT u.id, u.full_name AS title, concat_ws(' · ', r.name, u.email) AS subtitle
             FROM users u JOIN roles r ON r.id = u.role_id
            WHERE u.organization_id = $1 AND u.kind = 'staff' AND (u.full_name ILIKE $2 OR u.email ILIKE $2 OR u.phone ILIKE $2)
            LIMIT 4`,
          [ctx.orgId, like],
        )
      : [],
    has('leads.read')
      ? query(
          `SELECT l.id, l.full_name AS title, concat_ws(' · ', l.phone, initcap(replace(l.stage, '_', ' '))) AS subtitle, l.stage
             FROM leads l
            WHERE l.organization_id = $1 AND l.branch_id = ANY($2) AND l.stage <> 'won'
              AND (l.full_name ILIKE $3 OR l.phone ILIKE $3 OR l.email ILIKE $3)
            ORDER BY l.created_at DESC LIMIT 4`,
          [ctx.orgId, ctx.branchIds, like],
        )
      : [],
  ]);
  res.json({ members, leads, invoices, payments, staff });
});

// --------------------------------------------------------- notifications ----

const visibleToStaff = `n.organization_id = $1 AND n.audience = 'staff'
  AND (n.recipient_id = $2 OR (n.recipient_id IS NULL AND (n.branch_id IS NULL OR n.branch_id = ANY($3))))`;

commonRouter.get('/notifications', requireStaff, async (req, res) => {
  const ctx = auth(req);
  const rows = await query(
    `SELECT n.id, n.type, n.priority, n.title, n.body, n.entity_type, n.entity_id, n.created_at,
            COALESCE(n.read_at, nr.read_at) AS read_at
       FROM notifications n LEFT JOIN notification_reads nr ON nr.notification_id = n.id AND nr.user_id = $2
      WHERE ${visibleToStaff}
      ORDER BY n.created_at DESC LIMIT 40`,
    [ctx.orgId, ctx.userId, ctx.branchIds],
  );
  res.json({ data: rows, unread: rows.filter((r) => !r.read_at).length });
});

commonRouter.post('/notifications/read', requireStaff, async (req, res) => {
  const ctx = auth(req);
  const { ids } = z.object({ ids: z.array(uuid).optional() }).parse(req.body ?? {});
  await pool.query(
    `INSERT INTO notification_reads (notification_id, user_id)
     SELECT n.id, $2 FROM notifications n WHERE ${visibleToStaff} AND ($4::uuid[] IS NULL OR n.id = ANY($4))
     ON CONFLICT DO NOTHING`,
    [ctx.orgId, ctx.userId, ctx.branchIds, ids ?? null],
  );
  res.status(204).end();
});

// -------------------------------------------------------- access control ----

export function accessDecision(status: string) {
  switch (status) {
    case 'active':
    case 'expiring_soon':
      return { allowed: true, reason: 'Membership active' };
    case 'frozen':
      return { allowed: false, reason: 'Membership is frozen' };
    case 'expired':
      return { allowed: false, reason: 'Membership has expired' };
    case 'cancelled':
      return { allowed: false, reason: 'Membership was cancelled' };
    case 'pending':
      return { allowed: false, reason: 'Membership payment pending' };
    default:
      return { allowed: false, reason: 'No membership on file' };
  }
}

// Used by the front desk and, later, turnstile / access-control integrations.
commonRouter.get('/access/check', can('members.read'), async (req, res) => {
  const { code, branchId } = z.object({ code: z.string().trim().min(2), branchId: uuid.optional() }).parse(req.query);
  const ctx = auth(req);
  const [row] = await query(
    `SELECT m.id, m.member_code, m.branch_id, u.full_name, u.avatar_url, cm.status, cm.plan_name, cm.end_date, cm.days_remaining
       FROM members m JOIN users u ON u.id = m.user_id JOIN member_current_membership cm ON cm.member_id = m.id
      WHERE m.organization_id = $1 AND (upper(m.member_code) = upper($2) OR u.phone = $2)`,
    [ctx.orgId, code],
  );
  if (!row) {
    res.json({ allowed: false, reason: 'Member not found' });
    return;
  }
  let decision = accessDecision(row.status);
  if (decision.allowed && branchId && branchId !== row.branch_id) {
    decision = { allowed: false, reason: 'Membership is for a different branch' };
  }
  res.json({ ...decision, member: row });
});
