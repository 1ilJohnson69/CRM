import { Router } from 'express';
import { pool, one, query } from '../../db/pool.js';
import { auth, requireMember } from '../../lib/auth.js';
import { uuid } from '../../lib/http.js';
import { loadInvoice } from '../billing/routes.js';
import { streamInvoicePdf } from '../billing/pdf.js';
import { accessDecision } from '../common/routes.js';

// Member App API. Reads the same tables the CRM writes, so a renewal or
// payment recorded at the desk is visible here immediately.
export const appRouter = Router();
appRouter.use(requireMember);

appRouter.get('/', async (req, res) => {
  const memberId = auth(req).memberId!;
  const profile = await one(
    `SELECT m.id, m.member_code, m.join_date, m.date_of_birth, m.gender, m.address, m.emergency_contact_name, m.emergency_contact_phone,
            u.full_name, u.email, u.phone, u.avatar_url, u.must_change_password, b.name AS branch_name, b.phone AS branch_phone
       FROM members m JOIN users u ON u.id = m.user_id JOIN branches b ON b.id = m.branch_id WHERE m.id = $1`,
    [memberId],
  );
  const membership = await one(
    `SELECT cm.*, p.benefits, p.class_access, p.pt_access, p.facility_access, p.freeze_days_allowed, p.guest_passes
       FROM member_current_membership cm LEFT JOIN membership_plans p ON p.id = cm.plan_id WHERE cm.member_id = $1`,
    [memberId],
  );
  const balance = await one(`SELECT outstanding FROM member_balances WHERE member_id = $1`, [memberId]);
  const access = accessDecision(membership!.status);
  // Feature flags are decided here, not in the app, so a client cannot unlock
  // sections the member is not entitled to.
  const active = access.allowed;
  res.json({
    profile,
    membership,
    outstanding: balance!.outstanding,
    access,
    features: {
      profile: true,
      payments: true,
      renewal: true,
      checkIn: active,
      classes: active && !!membership?.class_access,
      personalTraining: active && !!membership?.pt_access,
      workouts: active,
      nutrition: false,
    },
  });
});

appRouter.get('/memberships', async (req, res) => {
  res.json(
    await query(
      `SELECT ms.id, ms.kind, ms.start_date, ms.end_date, ms.frozen_until, ms.price, ms.discount, p.name AS plan_name,
              effective_membership_status(ms.status, ms.end_date, ms.frozen_until, o.expiring_soon_days) AS status
         FROM memberships ms JOIN membership_plans p ON p.id = ms.plan_id JOIN organizations o ON o.id = ms.organization_id
        WHERE ms.member_id = $1 ORDER BY ms.start_date DESC`,
      [auth(req).memberId],
    ),
  );
});

appRouter.get('/payments', async (req, res) => {
  res.json(
    await query(
      `SELECT p.id, p.receipt_number, p.amount, p.method, p.reference, p.paid_at, i.id AS invoice_id, i.invoice_number
         FROM payments p JOIN invoices i ON i.id = p.invoice_id
        WHERE p.member_id = $1 AND p.status = 'recorded' ORDER BY p.paid_at DESC`,
      [auth(req).memberId],
    ),
  );
});

appRouter.get('/invoices', async (req, res) => {
  res.json(
    await query(
      `SELECT id, invoice_number, issue_date, total, amount_paid, (total - amount_paid) AS balance, status
         FROM invoices WHERE member_id = $1 AND status <> 'void' ORDER BY issue_date DESC`,
      [auth(req).memberId],
    ),
  );
});

appRouter.get('/invoices/:id/pdf', async (req, res) => {
  const data = await loadInvoice(req, uuid.parse(req.params.id), auth(req).memberId!);
  streamInvoicePdf(res, { ...data, payments: data.payments.filter((p) => p.status === 'recorded') });
});

appRouter.get('/notifications', async (req, res) => {
  res.json(
    await query(
      `SELECT id, type, title, body, created_at, read_at FROM notifications
        WHERE recipient_id = $1 AND audience = 'member' ORDER BY created_at DESC LIMIT 50`,
      [auth(req).userId],
    ),
  );
});

appRouter.post('/notifications/read', async (req, res) => {
  await pool.query(`UPDATE notifications SET read_at = now() WHERE recipient_id = $1 AND read_at IS NULL`, [auth(req).userId]);
  res.status(204).end();
});
