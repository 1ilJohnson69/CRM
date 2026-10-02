import { Router } from 'express';
import { pool, one, query, tx } from '../../db/pool.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { issueCheckinToken } from '../ops/attendance.js';
import { bookMember, cancelBooking } from '../ops/classes.js';
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
  const pt = await one(`SELECT count(*)::int AS n FROM member_pt_package_status WHERE member_id = $1 AND effective_status = 'active'`, [memberId]);
  const visits = await one(`SELECT last_visit_at, visits_30d FROM member_visit_stats WHERE member_id = $1`, [memberId]);
  const access = accessDecision(membership!.status);
  // Feature flags are decided here, not in the app, so a client cannot unlock
  // sections the member is not entitled to.
  const active = access.allowed;
  res.json({
    profile,
    membership,
    outstanding: balance!.outstanding,
    visits,
    access,
    features: {
      profile: true,
      payments: true,
      renewal: true,
      checkIn: active,
      classes: active && !!membership?.class_access,
      personalTraining: pt!.n > 0 || (active && !!membership?.pt_access),
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

// ---------------------------------------------------------- Phase 3: ops --

appRouter.get('/checkin-code', async (req, res) => {
  const memberId = auth(req).memberId!;
  const cm = await one(`SELECT status FROM member_current_membership WHERE member_id = $1`, [memberId]);
  const access = accessDecision(cm!.status);
  if (!access.allowed) throw forbidden(access.reason);
  res.json(issueCheckinToken(memberId));
});

appRouter.get('/attendance', async (req, res) => {
  res.json(await query(
    `SELECT a.id, a.checked_in_at, a.checked_out_at, a.method, b.name AS branch_name FROM attendance a JOIN branches b ON b.id = a.branch_id
      WHERE a.member_id = $1 AND a.status <> 'denied' ORDER BY a.checked_in_at DESC LIMIT 100`,
    [auth(req).memberId],
  ));
});

appRouter.get('/classes', async (req, res) => {
  const memberId = auth(req).memberId!;
  res.json(await query(
    `SELECT cs.id, cs.starts_at, cs.ends_at, cs.capacity, cs.location, cs.status, ct.name AS class_name, ct.description, tu.full_name AS trainer_name,
            (SELECT count(*) FROM class_bookings cb WHERE cb.session_id = cs.id AND cb.status IN ('booked','attended','no_show'))::int AS booked,
            (SELECT cb.status FROM class_bookings cb WHERE cb.session_id = cs.id AND cb.member_id = $1 AND cb.status <> 'cancelled') AS my_status,
            (SELECT cb.id FROM class_bookings cb WHERE cb.session_id = cs.id AND cb.member_id = $1 AND cb.status <> 'cancelled') AS my_booking_id
       FROM class_sessions cs JOIN class_types ct ON ct.id = cs.class_type_id LEFT JOIN users tu ON tu.id = cs.trainer_id
      WHERE cs.branch_id = (SELECT branch_id FROM members WHERE id = $1) AND cs.status = 'scheduled'
        AND cs.starts_at > now() AND cs.starts_at < now() + interval '8 days'
      ORDER BY cs.starts_at`,
    [memberId],
  ));
});

// Booking rules are enforced here, not in the app UI.
appRouter.post('/classes/:sessionId/book', async (req, res) => {
  const sessionId = uuid.parse(req.params.sessionId);
  const result = await tx(async (c) => {
    const s = await one(`SELECT * FROM class_sessions WHERE id = $1 FOR UPDATE`, [sessionId], c);
    if (!s || s.organization_id !== auth(req).orgId) throw notFound('Class');
    return bookMember(c, s, auth(req).memberId!, { source: 'app' });
  });
  res.status(201).json({ status: result.booking.status, bookingId: result.booking.id });
});

appRouter.post('/bookings/:id/cancel', async (req, res) => {
  const id = uuid.parse(req.params.id);
  await tx(async (c) => {
    const b = await one(
      `SELECT cb.member_id, cs.starts_at, o.class_cancel_cutoff_hours FROM class_bookings cb JOIN class_sessions cs ON cs.id = cb.session_id
         JOIN organizations o ON o.id = cs.organization_id WHERE cb.id = $1`,
      [id],
      c,
    );
    if (!b || b.member_id !== auth(req).memberId) throw notFound('Booking');
    if (new Date(b.starts_at).getTime() - Date.now() < b.class_cancel_cutoff_hours * 3600_000) {
      throw conflict(`Cancellations close ${b.class_cancel_cutoff_hours} hours before class. Please call the front desk.`);
    }
    await cancelBooking(c, id, auth(req).orgId);
  });
  res.status(204).end();
});

appRouter.get('/pt', async (req, res) => {
  const memberId = auth(req).memberId!;
  const [packages, sessions] = await Promise.all([
    query(
      `SELECT s.id, s.package_name, s.sessions_total, s.sessions_used, s.sessions_remaining, s.sessions_booked, s.expires_on, s.effective_status, tu.full_name AS trainer_name
         FROM member_pt_package_status s LEFT JOIN users tu ON tu.id = s.trainer_id WHERE s.member_id = $1 AND s.status <> 'cancelled' ORDER BY s.expires_on DESC`,
      [memberId],
    ),
    query(
      `SELECT a.id, a.starts_at, a.ends_at, a.status, a.location, a.outcome_notes, su.full_name AS trainer_name FROM appointments a
         LEFT JOIN users su ON su.id = a.staff_id WHERE a.member_id = $1 AND a.type = 'pt' ORDER BY a.starts_at DESC LIMIT 50`,
      [memberId],
    ),
  ]);
  res.json({ packages, sessions });
});

appRouter.get('/appointments', async (req, res) => {
  res.json(await query(
    `SELECT a.id, a.type, a.starts_at, a.ends_at, a.status, a.location, su.full_name AS staff_name FROM appointments a
       LEFT JOIN users su ON su.id = a.staff_id WHERE a.member_id = $1 AND a.starts_at > now() - interval '30 days' ORDER BY a.starts_at`,
    [auth(req).memberId],
  ));
});
