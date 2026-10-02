import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { one, query, type Db } from '../../db/pool.js';
import { audit, notify } from '../../lib/audit.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { round2 } from '../../lib/http.js';

export const loyaltySettingsSchema = z.object({
  enabled: z.boolean(),
  pointsPer100: z.coerce.number().min(0).max(100),
  renewalPoints: z.coerce.number().int().min(0).max(100000),
  referralPoints: z.coerce.number().int().min(0).max(100000),
  refereePoints: z.coerce.number().int().min(0).max(100000),
  milestones: z.array(z.object({ visits: z.coerce.number().int().min(1), points: z.coerce.number().int().min(1) })).max(12),
  pointValue: z.coerce.number().min(0.01).max(100),
  minRedeem: z.coerce.number().int().min(0),
  maxRedeemPct: z.coerce.number().min(0).max(100),
  autoRewardReferrals: z.boolean(),
});
export type LoyaltySettings = z.infer<typeof loyaltySettingsSchema>;

export async function loyaltySettings(db: Db, orgId: string): Promise<LoyaltySettings> {
  const row = await one(`SELECT loyalty_settings FROM organizations WHERE id = $1`, [orgId], db);
  return row!.loyalty_settings;
}

export async function loyaltyBalance(db: Db, memberId: string): Promise<number> {
  const row = await one(`SELECT COALESCE(sum(points), 0)::int AS balance FROM loyalty_transactions WHERE member_id = $1`, [memberId], db);
  return row!.balance;
}

type Reason = 'purchase' | 'renewal' | 'referral' | 'referral_welcome' | 'attendance_milestone' | 'event' | 'challenge' | 'manual' | 'redemption' | 'reversal';

/**
 * Appends a ledger entry. `sourceKey` + reason make it idempotent, so hooks
 * can fire more than once (retries, re-runs of seeds) without double awards.
 * Returns null when the entry already existed.
 */
export async function postPoints(
  c: Db,
  e: { orgId: string; memberId: string; branchId?: string | null; reason: Reason; points: number; sourceKey?: string | null; description: string; invoiceId?: string | null; createdBy?: string | null; notifyMember?: boolean },
) {
  if (!e.points) return null;
  const row = await one(
    `INSERT INTO loyalty_transactions (organization_id, member_id, branch_id, reason, points, source_key, description, invoice_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (member_id, reason, source_key) WHERE source_key IS NOT NULL DO NOTHING RETURNING *`,
    [e.orgId, e.memberId, e.branchId ?? null, e.reason, e.points, e.sourceKey ?? null, e.description, e.invoiceId ?? null, e.createdBy ?? null],
    c,
  );
  if (row && e.notifyMember !== false && e.points > 0) {
    const user = await one(`SELECT user_id FROM members WHERE id = $1`, [e.memberId], c);
    await notify(c, {
      orgId: e.orgId, recipientId: user!.user_id, audience: 'member', type: 'loyalty.earned',
      title: `+${e.points} points`, body: e.description, entityType: 'loyalty_transaction', entityId: row.id,
    });
  }
  return row ?? null;
}

// ------------------------------------------------------------------ hooks ----

/** Purchase points, renewal bonus and referral verification once a member pays. */
export async function onPaymentRecorded(c: PoolClient, req: Request, invoice: any, payment: any) {
  const orgId = req.auth!.orgId;
  const s = await loyaltySettings(c, orgId);
  if (s.enabled) {
    const points = Math.floor((payment.amount / 100) * s.pointsPer100);
    if (points > 0) {
      await postPoints(c, {
        orgId, memberId: invoice.member_id, branchId: invoice.branch_id, reason: 'purchase', points,
        sourceKey: `payment:${payment.id}`, description: `Payment ${payment.receipt_number} (${invoice.invoice_number})`, invoiceId: invoice.id, createdBy: req.auth!.userId,
      });
    }
  }
  if (invoice.status !== 'paid') return;
  const memberships = await query(
    `SELECT ms.id, ms.kind FROM invoice_items ii JOIN memberships ms ON ms.id = ii.membership_id WHERE ii.invoice_id = $1`,
    [invoice.id],
    c,
  );
  if (!memberships.length) return;
  if (s.enabled && s.renewalPoints > 0) {
    for (const ms of memberships.filter((m) => m.kind === 'renewal')) {
      await postPoints(c, {
        orgId, memberId: invoice.member_id, branchId: invoice.branch_id, reason: 'renewal', points: s.renewalPoints,
        sourceKey: `membership:${ms.id}`, description: 'Renewal bonus — thanks for staying with us', invoiceId: invoice.id, createdBy: req.auth!.userId,
      });
    }
  }
  // A referred member's first paid membership verifies the referral.
  const referral = await one(`SELECT * FROM referrals WHERE referred_member_id = $1 AND status = 'joined' FOR UPDATE`, [invoice.member_id], c);
  if (referral) {
    await c.query(`UPDATE referrals SET status = 'verified', verified_at = now(), updated_at = now() WHERE id = $1`, [referral.id]);
    await audit(c, req, {
      action: 'referral.verified', entityType: 'referral', entityId: referral.id, branchId: referral.branch_id,
      summary: `Referral of ${referral.referred_name} verified on first paid membership`,
    });
    if (s.autoRewardReferrals) await rewardReferral(c, req, referral.id);
  }
}

/** A voided payment takes back the points it earned. */
export async function onPaymentVoided(c: PoolClient, req: Request, payment: any) {
  const earned = await one(
    `SELECT points FROM loyalty_transactions WHERE member_id = $1 AND reason = 'purchase' AND source_key = $2`,
    [payment.member_id, `payment:${payment.id}`],
    c,
  );
  if (!earned) return;
  await postPoints(c, {
    orgId: req.auth!.orgId, memberId: payment.member_id, branchId: payment.branch_id, reason: 'reversal', points: -earned.points,
    sourceKey: `payment:${payment.id}`, description: `Payment ${payment.receipt_number} voided`, createdBy: req.auth!.userId,
  });
}

/** Visit milestones: every milestone at or below the member's visit count is awarded once. */
export async function onCheckIn(c: PoolClient, orgId: string, memberId: string, branchId: string) {
  const s = await loyaltySettings(c, orgId);
  if (!s.enabled || !s.milestones.length) return;
  const { visits } = (await one(`SELECT count(*)::int AS visits FROM attendance WHERE member_id = $1 AND status <> 'denied'`, [memberId], c))!;
  for (const m of s.milestones.filter((x) => x.visits <= visits)) {
    await postPoints(c, {
      orgId, memberId, branchId, reason: 'attendance_milestone', points: m.points,
      sourceKey: `visits:${m.visits}`, description: `${m.visits} visits milestone`,
    });
  }
}

// ------------------------------------------------------------- redemption ----

/** Validates a POS redemption and returns the rupee value it takes off the bill. */
export async function quoteRedemption(c: PoolClient, orgId: string, memberId: string, points: number, billTotal: number) {
  const s = await loyaltySettings(c, orgId);
  if (!s.enabled) throw badRequest('Loyalty is switched off');
  const balance = await loyaltyBalance(c, memberId);
  if (points > balance) throw badRequest(`Only ${balance} points available`);
  if (points < s.minRedeem) throw badRequest(`Redeem at least ${s.minRedeem} points`);
  const discount = round2(points * s.pointValue);
  const cap = round2((billTotal * s.maxRedeemPct) / 100);
  if (discount > cap) throw badRequest(`Points can cover at most ${s.maxRedeemPct}% of the bill (₹${cap.toLocaleString('en-IN')})`);
  return { points, discount };
}

// --------------------------------------------------------------- referrals ----

export async function createReferral(
  c: PoolClient,
  req: Request,
  r: { referrerMemberId: string; branchId: string; name: string; phone?: string | null; leadId?: string | null; referredMemberId?: string | null; source: 'crm' | 'app' | 'lead' | 'member' },
) {
  if (r.referredMemberId && r.referredMemberId === r.referrerMemberId) throw badRequest('A member cannot refer themselves');
  if (r.referredMemberId) {
    const existing = await one(`SELECT id FROM referrals WHERE referred_member_id = $1`, [r.referredMemberId], c);
    if (existing) throw conflict('This member is already recorded as someone’s referral');
  }
  const row = await one(
    `INSERT INTO referrals (organization_id, branch_id, referrer_member_id, referred_name, referred_phone, lead_id, referred_member_id, status, source, joined_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [req.auth!.orgId, r.branchId, r.referrerMemberId, r.name, r.phone ?? null, r.leadId ?? null, r.referredMemberId ?? null,
      r.referredMemberId ? 'joined' : 'pending', r.source, r.referredMemberId ? new Date() : null, req.auth!.kind === 'staff' ? req.auth!.userId : null],
    c,
  );
  if (r.referredMemberId) await c.query(`UPDATE members SET referred_by_member_id = $2 WHERE id = $1`, [r.referredMemberId, r.referrerMemberId]);
  const referrer = await one(`SELECT u.full_name FROM members m JOIN users u ON u.id = m.user_id WHERE m.id = $1`, [r.referrerMemberId], c);
  await audit(c, req, {
    action: 'referral.created', entityType: 'referral', entityId: row.id, branchId: r.branchId,
    summary: `${referrer?.full_name} referred ${r.name}`,
  });
  return row;
}

/** Lead converted → the referral becomes "joined" and is linked to the new member. */
export async function onLeadConverted(c: PoolClient, req: Request, leadId: string, memberId: string) {
  const referral = await one(`SELECT * FROM referrals WHERE lead_id = $1 AND status IN ('pending', 'rejected')`, [leadId], c);
  if (!referral || referral.referrer_member_id === memberId) return;
  const taken = await one(`SELECT id FROM referrals WHERE referred_member_id = $1`, [memberId], c);
  if (taken) return;
  await c.query(
    `UPDATE referrals SET referred_member_id = $2, status = 'joined', joined_at = now(), rejected_reason = NULL, updated_at = now() WHERE id = $1`,
    [referral.id, memberId],
  );
  await c.query(`UPDATE members SET referred_by_member_id = $2 WHERE id = $1 AND referred_by_member_id IS NULL`, [memberId, referral.referrer_member_id]);
  await audit(c, req, { action: 'referral.joined', entityType: 'referral', entityId: referral.id, branchId: referral.branch_id, summary: `${referral.referred_name} joined (referral)` });
  // Conversion often sells and collects the first membership in the same step.
  await verifyIfPaid(c, req, referral.id, memberId);
}

async function verifyIfPaid(c: PoolClient, req: Request, referralId: string, memberId: string) {
  const paid = await one(
    `SELECT 1 FROM invoices i JOIN invoice_items ii ON ii.invoice_id = i.id
      WHERE i.member_id = $1 AND i.status = 'paid' AND ii.membership_id IS NOT NULL LIMIT 1`,
    [memberId],
    c,
  );
  if (!paid) return;
  await c.query(`UPDATE referrals SET status = 'verified', verified_at = now(), updated_at = now() WHERE id = $1 AND status = 'joined'`, [referralId]);
  await audit(c, req, { action: 'referral.verified', entityType: 'referral', entityId: referralId, summary: 'Referral verified on first paid membership' });
  if ((await loyaltySettings(c, req.auth!.orgId)).autoRewardReferrals) await rewardReferral(c, req, referralId);
}

export async function rewardReferral(c: PoolClient, req: Request, referralId: string) {
  const r = await one(`SELECT * FROM referrals WHERE id = $1 AND organization_id = $2 FOR UPDATE`, [referralId, req.auth!.orgId], c);
  if (!r) throw notFound('Referral');
  if (r.status === 'rewarded') throw conflict('This referral has already been rewarded');
  if (r.status !== 'verified') throw conflict('Verify the referral first — the referred member must have joined and paid');
  const s = await loyaltySettings(c, req.auth!.orgId);
  await postPoints(c, {
    orgId: r.organization_id, memberId: r.referrer_member_id, branchId: r.branch_id, reason: 'referral', points: s.referralPoints,
    sourceKey: `referral:${r.id}`, description: `Referral reward — ${r.referred_name} joined`, createdBy: req.auth!.userId,
  });
  if (r.referred_member_id && s.refereePoints) {
    await postPoints(c, {
      orgId: r.organization_id, memberId: r.referred_member_id, branchId: r.branch_id, reason: 'referral_welcome', points: s.refereePoints,
      sourceKey: `referral:${r.id}`, description: 'Welcome bonus for joining through a referral', createdBy: req.auth!.userId,
    });
  }
  await c.query(
    `UPDATE referrals SET status = 'rewarded', rewarded_at = now(), reward_points = $2, referee_points = $3, updated_at = now() WHERE id = $1`,
    [r.id, s.referralPoints, r.referred_member_id ? s.refereePoints : null],
  );
  await audit(c, req, {
    action: 'referral.rewarded', entityType: 'referral', entityId: r.id, branchId: r.branch_id,
    summary: `Referral reward issued: ${s.referralPoints} points for referring ${r.referred_name}`,
  });
}
