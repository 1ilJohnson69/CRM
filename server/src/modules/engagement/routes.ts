import { Router } from 'express';
import { z } from 'zod';
import { one, pool, query, tx } from '../../db/pool.js';
import { assertBranch, auth, branchScope, can } from '../../lib/auth.js';
import { audit, notify } from '../../lib/audit.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { paginationSchema, paged, uuid } from '../../lib/http.js';
import { createReferral, loyaltyBalance, loyaltySettings, loyaltySettingsSchema, postPoints, rewardReferral } from './loyalty.js';

// ---------------------------------------------------------------- loyalty ----

export const loyaltyRouter = Router();

loyaltyRouter.get('/settings', can('members.read'), async (req, res) => {
  res.json(await loyaltySettings(pool, auth(req).orgId));
});

loyaltyRouter.put('/settings', can('loyalty.manage'), async (req, res) => {
  const next = loyaltySettingsSchema.parse(req.body);
  next.milestones.sort((a, b) => a.visits - b.visits);
  if (new Set(next.milestones.map((m) => m.visits)).size !== next.milestones.length) throw badRequest('Each visit milestone can only appear once');
  await tx(async (c) => {
    const before = await loyaltySettings(c, auth(req).orgId);
    await c.query(`UPDATE organizations SET loyalty_settings = $2 WHERE id = $1`, [auth(req).orgId, JSON.stringify(next)]);
    await audit(c, req, { action: 'loyalty.settings', entityType: 'organization', entityId: auth(req).orgId, summary: 'Loyalty rules updated', before, after: next });
  });
  res.json(next);
});

loyaltyRouter.get('/summary', can('members.read'), async (req, res) => {
  const scope = [auth(req).orgId, branchScope(req)];
  const s = await loyaltySettings(pool, auth(req).orgId);
  const [totals, byReason, top, trend] = await Promise.all([
    one(
      `SELECT count(*) FILTER (WHERE l.balance > 0)::int AS members_with_points, COALESCE(sum(l.balance) FILTER (WHERE l.balance > 0), 0)::int AS outstanding,
              (SELECT COALESCE(sum(points), 0) FROM loyalty_transactions t JOIN members mm ON mm.id = t.member_id
                WHERE mm.organization_id = $1 AND mm.branch_id = ANY($2) AND t.points > 0 AND t.reason <> 'reversal' AND t.created_at >= current_date - 29)::int AS earned_30d,
              (SELECT COALESCE(-sum(points), 0) FROM loyalty_transactions t JOIN members mm ON mm.id = t.member_id
                WHERE mm.organization_id = $1 AND mm.branch_id = ANY($2) AND t.reason = 'redemption' AND t.created_at >= current_date - 29)::int AS redeemed_30d
         FROM members m JOIN member_loyalty l ON l.member_id = m.id WHERE m.organization_id = $1 AND m.branch_id = ANY($2)`,
      scope,
    ),
    query(
      `SELECT t.reason, sum(t.points)::int AS points, count(*)::int AS n FROM loyalty_transactions t JOIN members m ON m.id = t.member_id
        WHERE m.organization_id = $1 AND m.branch_id = ANY($2) AND t.created_at >= current_date - 89 AND t.points > 0 AND t.reason <> 'reversal'
        GROUP BY t.reason ORDER BY points DESC`,
      scope,
    ),
    query(
      `SELECT m.id, m.member_code, u.full_name, l.balance, l.earned, l.redeemed
         FROM members m JOIN users u ON u.id = m.user_id JOIN member_loyalty l ON l.member_id = m.id
        WHERE m.organization_id = $1 AND m.branch_id = ANY($2) AND l.balance > 0 ORDER BY l.balance DESC LIMIT 10`,
      scope,
    ),
    query(
      `SELECT d::date AS date,
              COALESCE((SELECT sum(points) FROM loyalty_transactions t JOIN members m ON m.id = t.member_id
                         WHERE m.organization_id = $1 AND m.branch_id = ANY($2) AND t.points > 0 AND t.reason <> 'reversal'
                           AND t.created_at >= d AND t.created_at < d + interval '7 days'), 0)::int AS value
         FROM generate_series(current_date - 83, current_date, interval '7 days') d ORDER BY d`,
      scope,
    ),
  ]);
  res.json({ ...totals, liability: Math.round(totals!.outstanding * s.pointValue * 100) / 100, byReason, top, trend, settings: s });
});

loyaltyRouter.get('/transactions', can('members.read'), async (req, res) => {
  const q = paginationSchema.extend({ memberId: uuid.optional(), reason: z.string().optional() }).parse(req.query);
  const params: unknown[] = [auth(req).orgId, branchScope(req)];
  const where = [`m.organization_id = $1`, `m.branch_id = ANY($2)`];
  if (q.memberId) { params.push(q.memberId); where.push(`t.member_id = $${params.length}`); }
  if (q.reason) { params.push(q.reason); where.push(`t.reason = $${params.length}`); }
  params.push(q.pageSize, (q.page - 1) * q.pageSize);
  const rows = await query(
    `SELECT t.*, u.full_name AS member_name, m.member_code, cu.full_name AS created_by_name, i.invoice_number,
            sum(t.points) OVER (PARTITION BY t.member_id ORDER BY t.created_at, t.id) AS running_balance, count(*) OVER() AS total_count
       FROM loyalty_transactions t JOIN members m ON m.id = t.member_id JOIN users u ON u.id = m.user_id
       LEFT JOIN users cu ON cu.id = t.created_by LEFT JOIN invoices i ON i.id = t.invoice_id
      WHERE ${where.join(' AND ')} ORDER BY t.created_at DESC, t.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  res.json(paged(rows, q.page, q.pageSize));
});

loyaltyRouter.get('/members/:id', can('members.read'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const m = await one(`SELECT id, branch_id, referral_code, referred_by_member_id FROM members WHERE id = $1 AND organization_id = $2`, [id, auth(req).orgId]);
  if (!m || !auth(req).branchIds.includes(m.branch_id)) throw notFound('Member');
  const [account, transactions, referrals, referredBy, settings] = await Promise.all([
    one(`SELECT * FROM member_loyalty WHERE member_id = $1`, [id]),
    query(
      `SELECT t.*, cu.full_name AS created_by_name, i.invoice_number FROM loyalty_transactions t
         LEFT JOIN users cu ON cu.id = t.created_by LEFT JOIN invoices i ON i.id = t.invoice_id
        WHERE t.member_id = $1 ORDER BY t.created_at DESC LIMIT 50`,
      [id],
    ),
    query(`SELECT r.*, u.full_name AS referred_member_name FROM referrals r LEFT JOIN members rm ON rm.id = r.referred_member_id LEFT JOIN users u ON u.id = rm.user_id
            WHERE r.referrer_member_id = $1 ORDER BY r.created_at DESC`, [id]),
    m.referred_by_member_id
      ? one(`SELECT m.id, m.member_code, u.full_name FROM members m JOIN users u ON u.id = m.user_id WHERE m.id = $1`, [m.referred_by_member_id])
      : null,
    loyaltySettings(pool, auth(req).orgId),
  ]);
  res.json({ ...account, value: Math.round(account!.balance * settings.pointValue * 100) / 100, referralCode: m.referral_code, transactions, referrals, referredBy, settings });
});

/** Manual awards (events, challenges, goodwill) and corrections. */
loyaltyRouter.post('/award', can('loyalty.manage'), async (req, res) => {
  const b = z.object({
    memberId: uuid,
    points: z.coerce.number().int().refine((n) => n !== 0, 'Enter points').refine((n) => Math.abs(n) <= 100000, 'Too many points'),
    reason: z.enum(['event', 'challenge', 'manual']),
    description: z.string().trim().min(3).max(200),
  }).parse(req.body);
  const row = await tx(async (c) => {
    const m = await one(`SELECT m.id, m.branch_id, u.full_name FROM members m JOIN users u ON u.id = m.user_id WHERE m.id = $1 AND m.organization_id = $2 FOR UPDATE OF m`, [b.memberId, auth(req).orgId], c);
    if (!m) throw notFound('Member');
    assertBranch(req, m.branch_id);
    if (b.points < 0 && (await loyaltyBalance(c, m.id)) + b.points < 0) throw badRequest('That would take the balance below zero');
    const t = await postPoints(c, {
      orgId: auth(req).orgId, memberId: m.id, branchId: m.branch_id, reason: b.reason, points: b.points,
      description: b.description, createdBy: auth(req).userId,
    });
    await audit(c, req, {
      action: 'loyalty.adjusted', entityType: 'member', entityId: m.id, branchId: m.branch_id,
      summary: `${b.points > 0 ? '+' : ''}${b.points} points for ${m.full_name}: ${b.description}`,
    });
    return t;
  });
  res.status(201).json(row);
});

// -------------------------------------------------------------- referrals ----

export const referralsRouter = Router();

referralsRouter.get('/', can('members.read'), async (req, res) => {
  const q = paginationSchema.extend({ status: z.enum(['pending', 'joined', 'verified', 'rewarded', 'rejected']).optional(), referrerId: uuid.optional(), search: z.string().trim().optional() }).parse(req.query);
  const params: unknown[] = [auth(req).orgId, branchScope(req)];
  const where = [`r.organization_id = $1`, `r.branch_id = ANY($2)`];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replaceAll('$?', `$${params.length}`)); };
  if (q.status) add(`r.status = $?`, q.status);
  if (q.referrerId) add(`r.referrer_member_id = $?`, q.referrerId);
  if (q.search) add(`(r.referred_name ILIKE $? OR ru.full_name ILIKE $? OR r.referred_phone ILIKE $?)`, `%${q.search}%`);
  params.push(q.pageSize, (q.page - 1) * q.pageSize);
  const rows = await query(
    `SELECT r.*, ru.full_name AS referrer_name, rm.member_code AS referrer_code, nu.full_name AS referred_member_name, nm.member_code AS referred_member_code,
            l.stage AS lead_stage, cm.status AS membership_status, count(*) OVER() AS total_count
       FROM referrals r JOIN members rm ON rm.id = r.referrer_member_id JOIN users ru ON ru.id = rm.user_id
       LEFT JOIN members nm ON nm.id = r.referred_member_id LEFT JOIN users nu ON nu.id = nm.user_id
       LEFT JOIN leads l ON l.id = r.lead_id LEFT JOIN member_current_membership cm ON cm.member_id = r.referred_member_id
      WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  res.json(paged(rows, q.page, q.pageSize));
});

referralsRouter.get('/summary', can('members.read'), async (req, res) => {
  const scope = [auth(req).orgId, branchScope(req)];
  const [counts, top, monthly] = await Promise.all([
    one(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'pending')::int AS pending, count(*) FILTER (WHERE status = 'joined')::int AS joined,
              count(*) FILTER (WHERE status = 'verified')::int AS verified, count(*) FILTER (WHERE status = 'rewarded')::int AS rewarded,
              count(*) FILTER (WHERE status = 'rejected')::int AS rejected,
              COALESCE(sum(COALESCE(reward_points, 0) + COALESCE(referee_points, 0)), 0)::int AS points_issued,
              count(*) FILTER (WHERE created_at >= current_date - 89)::int AS last_90,
              count(*) FILTER (WHERE created_at >= current_date - 89 AND status IN ('joined','verified','rewarded'))::int AS converted_90
         FROM referrals WHERE organization_id = $1 AND branch_id = ANY($2)`,
      scope,
    ),
    query(
      `SELECT m.id, m.member_code, u.full_name, count(*)::int AS referrals,
              count(*) FILTER (WHERE r.status IN ('joined','verified','rewarded'))::int AS joined,
              COALESCE(sum(r.reward_points), 0)::int AS points
         FROM referrals r JOIN members m ON m.id = r.referrer_member_id JOIN users u ON u.id = m.user_id
        WHERE r.organization_id = $1 AND r.branch_id = ANY($2) GROUP BY m.id, u.full_name ORDER BY joined DESC, referrals DESC LIMIT 8`,
      scope,
    ),
    query(
      `SELECT to_char(mo, 'YYYY-MM-01') AS date,
              (SELECT count(*) FROM referrals r WHERE r.organization_id = $1 AND r.branch_id = ANY($2) AND r.created_at >= mo AND r.created_at < mo + interval '1 month')::int AS value
         FROM generate_series(date_trunc('month', current_date) - interval '5 months', date_trunc('month', current_date), interval '1 month') mo`,
      scope,
    ),
  ]);
  res.json({ ...counts, top, monthly });
});

/** Staff record a referral: creates the lead in the pipeline so sales can follow it up. */
referralsRouter.post('/', can('referrals.manage', 'leads.write'), async (req, res) => {
  const b = z.object({
    referrerMemberId: uuid,
    name: z.string().trim().min(2).max(80),
    phone: z.string().trim().transform((v) => v.replace(/[\s-]/g, '')).pipe(z.string().regex(/^\+?\d{10,13}$/, 'Enter a valid phone number')),
    notes: z.string().trim().max(500).optional().nullable(),
  }).parse(req.body);
  const result = await tx(async (c) => {
    const referrer = await one(`SELECT m.id, m.branch_id, u.full_name FROM members m JOIN users u ON u.id = m.user_id WHERE m.id = $1 AND m.organization_id = $2`, [b.referrerMemberId, auth(req).orgId], c);
    if (!referrer) throw notFound('Member');
    assertBranch(req, referrer.branch_id);
    return createReferralLead(c, req, referrer, b, 'crm');
  });
  res.status(201).json(result);
});

export async function createReferralLead(c: any, req: any, referrer: { id: string; branch_id: string; full_name: string }, b: { name: string; phone: string; notes?: string | null }, source: 'crm' | 'app') {
  const orgId = req.auth.orgId;
  const existingMember = await one(`SELECT m.id FROM members m JOIN users u ON u.id = m.user_id WHERE m.organization_id = $1 AND u.phone = $2`, [orgId, b.phone], c);
  if (existingMember) throw conflict('This person is already a member');
  const openLead = await one(`SELECT id FROM leads WHERE organization_id = $1 AND phone = $2 AND stage NOT IN ('won','lost')`, [orgId, b.phone], c);
  if (openLead) throw conflict('This person is already in the sales pipeline');
  await c.query(`INSERT INTO lead_sources (organization_id, name, sort) VALUES ($1, 'Referral', 7) ON CONFLICT (organization_id, name) DO NOTHING`, [orgId]);
  const src = await one(`SELECT id FROM lead_sources WHERE organization_id = $1 AND name = 'Referral'`, [orgId], c);
  const lead = await one(
    `INSERT INTO leads (organization_id, branch_id, full_name, phone, source_id, referred_by_member_id, notes, position, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,(SELECT COALESCE(min(position), 0) - 1 FROM leads WHERE branch_id = $2 AND stage = 'new'),$8) RETURNING *`,
    [orgId, referrer.branch_id, b.name, b.phone, src!.id, referrer.id, b.notes ?? `Referred by ${referrer.full_name}`, source === 'crm' ? req.auth.userId : null],
    c,
  );
  await c.query(`INSERT INTO lead_stage_history (lead_id, from_stage, to_stage, changed_by) VALUES ($1, NULL, 'new', $2)`, [lead.id, source === 'crm' ? req.auth.userId : null]);
  await c.query(
    `INSERT INTO follow_ups (organization_id, branch_id, lead_id, type, purpose, due_at, notes, auto_generated, created_by)
     VALUES ($1,$2,$3,'call','sales', now() + interval '1 hour', $4, true, $5)`,
    [orgId, referrer.branch_id, lead.id, `Referral from ${referrer.full_name} — mention them on the call`, source === 'crm' ? req.auth.userId : null],
  );
  const referral = await createReferral(c, req, { referrerMemberId: referrer.id, branchId: referrer.branch_id, name: b.name, phone: b.phone, leadId: lead.id, source });
  await notify(c, {
    orgId, branchId: referrer.branch_id, type: 'lead.created', title: `Referral: ${b.name}`,
    body: `Referred by ${referrer.full_name} · first call due within the hour`, entityType: 'lead', entityId: lead.id,
  });
  return { lead, referral };
}

referralsRouter.post('/:id/verify', can('referrals.manage'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  await tx(async (c) => {
    const r = await one(`SELECT * FROM referrals WHERE id = $1 AND organization_id = $2 FOR UPDATE`, [id, auth(req).orgId], c);
    if (!r || !auth(req).branchIds.includes(r.branch_id)) throw notFound('Referral');
    if (r.status !== 'joined') throw conflict(r.status === 'pending' ? 'The referred person hasn’t joined yet' : `This referral is already ${r.status}`);
    await c.query(`UPDATE referrals SET status = 'verified', verified_at = now(), updated_at = now() WHERE id = $1`, [id]);
    await audit(c, req, { action: 'referral.verified', entityType: 'referral', entityId: id, branchId: r.branch_id, summary: `Referral of ${r.referred_name} verified manually` });
  });
  res.status(204).end();
});

referralsRouter.post('/:id/reward', can('referrals.manage', 'loyalty.manage'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  await tx(async (c) => {
    const r = await one(`SELECT branch_id FROM referrals WHERE id = $1 AND organization_id = $2`, [id, auth(req).orgId], c);
    if (!r || !auth(req).branchIds.includes(r.branch_id)) throw notFound('Referral');
    await rewardReferral(c, req, id);
  });
  res.status(204).end();
});

referralsRouter.post('/:id/reject', can('referrals.manage'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const { reason } = z.object({ reason: z.string().trim().min(3).max(300) }).parse(req.body);
  await tx(async (c) => {
    const r = await one(`SELECT * FROM referrals WHERE id = $1 AND organization_id = $2 FOR UPDATE`, [id, auth(req).orgId], c);
    if (!r || !auth(req).branchIds.includes(r.branch_id)) throw notFound('Referral');
    if (r.status === 'rewarded') throw conflict('Rewarded referrals can’t be rejected — adjust points instead');
    await c.query(`UPDATE referrals SET status = 'rejected', rejected_reason = $2, updated_at = now() WHERE id = $1`, [id, reason]);
    await audit(c, req, { action: 'referral.rejected', entityType: 'referral', entityId: id, branchId: r.branch_id, summary: `Referral of ${r.referred_name} rejected: ${reason}` });
  });
  res.status(204).end();
});
