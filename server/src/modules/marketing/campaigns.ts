import { Router, type Request } from 'express';
import { z } from 'zod';
import { one, pool, query, tx } from '../../db/pool.js';
import { auth, branchScope, can } from '../../lib/auth.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { isoDate, paginationSchema, paged, uuid } from '../../lib/http.js';
import { compileRules, SEGMENT_FROM, segmentRules, type SegmentRules } from '../crm/segments.js';
import { channelStatus, enqueueMessage } from '../messaging/service.js';

export const CAMPAIGN_TYPES = ['membership_promotion', 'renewal', 'referral', 'festival_offer', 'birthday', 'reactivation', 'lead'] as const;
const LEAD_STAGES = ['new', 'contacted', 'interested', 'trial_booked', 'trial_completed', 'negotiation', 'lost'] as const;

/** Ready-made audiences from the spec, expressed in the same rule vocabulary as saved segments. */
export const PRESETS: Record<string, { label: string; rules: SegmentRules }> = {
  active: { label: 'All active members', rules: { statuses: ['active', 'expiring_soon'] } },
  expiring: { label: 'Expiring in 14 days', rules: { expiresWithinDays: 14 } },
  expired: { label: 'Expired in the last 90 days', rules: { expiredWithinDays: 90 } },
  inactive: { label: 'Active but no visit in 14 days', rules: { statuses: ['active', 'expiring_soon'], inactiveDays: 14 } },
  high_value: { label: 'High value · ₹50K+ lifetime', rules: { lifetimeValueMin: 50000 } },
  new: { label: 'Joined in the last 30 days', rules: { joinedWithinDays: 30 } },
  pt: { label: 'Personal training members', rules: { hasPersonalTraining: true } },
  class: { label: 'Class members', rules: { hasClassAccess: true } },
  birthday_month: { label: 'Birthdays this month', rules: { birthdayThisMonth: true } },
  referrers: { label: 'Members who referred someone', rules: { referredSomeone: true } },
};

const audienceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('preset'), key: z.enum(Object.keys(PRESETS) as [string, ...string[]]) }),
  z.object({ kind: z.literal('segment'), segmentId: uuid }),
  z.object({ kind: z.literal('leads'), stages: z.array(z.enum(LEAD_STAGES)).min(1), createdWithinDays: z.coerce.number().int().min(1).max(730).optional() }),
]);
type Audience = z.infer<typeof audienceSchema>;

const campaignSchema = z.object({
  name: z.string().trim().min(3).max(100),
  type: z.enum(CAMPAIGN_TYPES),
  audience: audienceSchema,
  branchIds: z.array(uuid).optional(),
  channels: z.array(z.enum(['whatsapp', 'sms', 'email', 'push'])).min(1),
  subject: z.string().trim().max(150).optional().nullable(),
  body: z.string().trim().min(5).max(1500),
  offerCode: z.string().trim().max(30).optional().nullable(),
  offerValidUntil: isoDate.optional().nullable(),
  attributionDays: z.coerce.number().int().min(1).max(90).default(14),
});

/** Members or leads in the audience, within the campaign's branches. */
export async function resolveAudience(orgId: string, audience: Audience, branchIds: string[]) {
  if (audience.kind === 'leads') {
    const params: unknown[] = [orgId, branchIds, audience.stages];
    let extra = '';
    if (audience.createdWithinDays) { params.push(audience.createdWithinDays); extra = `AND l.created_at >= now() - make_interval(days => $4::int)`; }
    return query<{ member_id: null; lead_id: string; phone: string | null; email: string | null; opt_out: boolean }>(
      `SELECT NULL AS member_id, l.id AS lead_id, l.phone, l.email, l.marketing_opt_out AS opt_out FROM leads l
        WHERE l.organization_id = $1 AND l.branch_id = ANY($2) AND l.stage = ANY($3) ${extra}`, params);
  }
  let rules: SegmentRules;
  if (audience.kind === 'preset') rules = PRESETS[audience.key].rules;
  else {
    const seg = await one(`SELECT rules FROM segments WHERE id = $1 AND organization_id = $2`, [audience.segmentId, orgId]);
    if (!seg) throw badRequest('That segment no longer exists');
    rules = segmentRules.parse(seg.rules);
  }
  const params: unknown[] = [orgId, branchIds];
  const where = [`m.organization_id = $1`, `m.branch_id = ANY($2)`, ...compileRules(rules, params)];
  return query<{ member_id: string; lead_id: null; phone: string | null; email: string | null; opt_out: boolean }>(
    `SELECT m.id AS member_id, NULL AS lead_id, u.phone, u.email, m.marketing_opt_out AS opt_out ${SEGMENT_FROM} WHERE ${where.join(' AND ')}`, params);
}

/** How many would actually receive it on each channel, and why the rest won't. */
function reach(rows: { member_id: string | null; phone: string | null; email: string | null; opt_out: boolean }[], channels: string[]) {
  const optedOut = rows.filter((r) => r.opt_out).length;
  const eligible = rows.filter((r) => !r.opt_out);
  return {
    audience: rows.length,
    optedOut,
    byChannel: channels.map((ch) => ({
      ...channelStatus(ch as any),
      reachable: eligible.filter((r) => (ch === 'email' ? r.email : ch === 'push' ? r.member_id : r.phone)).length,
    })),
  };
}

function scopeBranches(req: Request, requested?: string[]) {
  const scope = branchScope(req);
  const ids = requested?.length ? requested.filter((b) => scope.includes(b)) : scope;
  if (!ids.length) throw badRequest('Pick at least one of your branches');
  return ids;
}

export const campaignsRouter = Router();

campaignsRouter.get('/meta', can('marketing.read'), async (req, res) => {
  const segments = await query(`SELECT id, name, description FROM segments WHERE organization_id = $1 ORDER BY is_system DESC, name`, [auth(req).orgId]);
  res.json({ presets: Object.entries(PRESETS).map(([key, p]) => ({ key, label: p.label })), segments, stages: LEAD_STAGES });
});

campaignsRouter.post('/preview', can('marketing.read'), async (req, res) => {
  const b = z.object({ audience: audienceSchema, channels: z.array(z.enum(['whatsapp', 'sms', 'email', 'push'])).min(1), branchIds: z.array(uuid).optional() }).parse(req.body);
  const rows = await resolveAudience(auth(req).orgId, b.audience, scopeBranches(req, b.branchIds));
  res.json(reach(rows, b.channels));
});

// Results are measured, not claimed: a member "converts" if they pay within
// the attribution window after the send; a lead if they become a member.
const STATS = `
  (SELECT count(DISTINCT COALESCE(cr.member_id, cr.lead_id)) FROM campaign_recipients cr WHERE cr.campaign_id = c.id AND cr.status <> 'skipped')::int AS reached,
  (SELECT count(*) FROM campaign_recipients cr WHERE cr.campaign_id = c.id AND cr.status IN ('sent','delivered'))::int AS sent,
  (SELECT count(*) FROM campaign_recipients cr WHERE cr.campaign_id = c.id AND cr.status = 'queued')::int AS queued,
  (SELECT count(*) FROM campaign_recipients cr WHERE cr.campaign_id = c.id AND cr.status = 'failed')::int AS failed,
  (SELECT count(*) FROM campaign_recipients cr WHERE cr.campaign_id = c.id AND cr.status = 'skipped')::int AS skipped,
  (SELECT count(DISTINCT x.id) FROM (
     SELECT cr.member_id AS id FROM campaign_recipients cr JOIN payments p ON p.member_id = cr.member_id AND p.status = 'recorded'
      WHERE cr.campaign_id = c.id AND cr.status <> 'skipped' AND p.paid_at >= c.sent_at AND p.paid_at < c.sent_at + make_interval(days => c.attribution_days)
     UNION
     SELECT cr.lead_id FROM campaign_recipients cr JOIN leads l ON l.id = cr.lead_id
      WHERE cr.campaign_id = c.id AND cr.status <> 'skipped' AND l.converted_at >= c.sent_at AND l.converted_at < c.sent_at + make_interval(days => c.attribution_days)) x)::int AS conversions,
  (SELECT COALESCE(sum(p.amount), 0) FROM payments p WHERE p.status = 'recorded' AND p.paid_at >= c.sent_at AND p.paid_at < c.sent_at + make_interval(days => c.attribution_days)
      AND p.member_id IN (SELECT cr.member_id FROM campaign_recipients cr WHERE cr.campaign_id = c.id AND cr.status <> 'skipped')) AS revenue`;

campaignsRouter.get('/', can('marketing.read'), async (req, res) => {
  const q = paginationSchema.extend({ status: z.enum(['draft', 'scheduled', 'sending', 'sent', 'cancelled']).optional() }).parse(req.query);
  const params: unknown[] = [auth(req).orgId, branchScope(req)];
  let extra = '';
  if (q.status) { params.push(q.status); extra = `AND c.status = $${params.length}`; }
  params.push(q.pageSize, (q.page - 1) * q.pageSize);
  const rows = await query(
    `SELECT c.*, u.full_name AS created_by_name, ${STATS}, count(*) OVER() AS total_count
       FROM campaigns c LEFT JOIN users u ON u.id = c.created_by
      WHERE c.organization_id = $1 AND c.branch_ids && $2 ${extra}
      ORDER BY COALESCE(c.sent_at, c.scheduled_at, c.created_at) DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  res.json(paged(rows, q.page, q.pageSize));
});

campaignsRouter.get('/summary', can('marketing.read'), async (req, res) => {
  const row = await one(
    `SELECT count(*) FILTER (WHERE c.status = 'sent' AND c.sent_at >= now() - interval '90 days')::int AS sent_90d,
            count(*) FILTER (WHERE c.status = 'scheduled')::int AS scheduled, count(*) FILTER (WHERE c.status = 'draft')::int AS drafts,
            COALESCE(sum(s.conversions), 0)::int AS conversions, COALESCE(sum(s.reached), 0)::int AS reached, COALESCE(sum(s.revenue), 0) AS revenue
       FROM campaigns c LEFT JOIN LATERAL (SELECT ${STATS}) s ON c.status = 'sent' AND c.sent_at >= now() - interval '90 days'
      WHERE c.organization_id = $1 AND c.branch_ids && $2`,
    [auth(req).orgId, branchScope(req)],
  );
  res.json(row);
});

async function loadCampaign(req: Request, id: string) {
  const c = await one(`SELECT c.*, ${STATS} FROM campaigns c WHERE c.id = $1 AND c.organization_id = $2 AND c.branch_ids && $3`, [id, auth(req).orgId, branchScope(req)]);
  if (!c) throw notFound('Campaign');
  return c;
}

campaignsRouter.get('/:id', can('marketing.read'), async (req, res) => {
  const c = await loadCampaign(req, uuid.parse(req.params.id));
  const q = paginationSchema.extend({ filter: z.enum(['all', 'converted', 'skipped', 'failed']).default('all') }).parse(req.query);
  const [byChannel, recipients, daily] = await Promise.all([
    query(`SELECT channel, status, count(*)::int AS n FROM campaign_recipients WHERE campaign_id = $1 GROUP BY channel, status`, [c.id]),
    query(
      `WITH r AS (
         SELECT cr.*, COALESCE(mu.full_name, l.full_name) AS name, m.member_code, l.stage AS lead_stage,
                (SELECT sum(p.amount) FROM payments p WHERE p.member_id = cr.member_id AND p.status = 'recorded' AND p.paid_at >= $2 AND p.paid_at < $2::timestamptz + make_interval(days => $3)) AS paid,
                (l.converted_at >= $2 AND l.converted_at < $2::timestamptz + make_interval(days => $3)) AS lead_converted
           FROM campaign_recipients cr LEFT JOIN members m ON m.id = cr.member_id LEFT JOIN users mu ON mu.id = m.user_id LEFT JOIN leads l ON l.id = cr.lead_id
          WHERE cr.campaign_id = $1)
       SELECT r.*, count(*) OVER() AS total_count FROM r
        WHERE ($4 = 'all' OR ($4 = 'converted' AND (r.paid > 0 OR r.lead_converted)) OR ($4 = 'skipped' AND r.status = 'skipped') OR ($4 = 'failed' AND r.status = 'failed'))
        ORDER BY r.paid DESC NULLS LAST, r.name LIMIT $5 OFFSET $6`,
      [c.id, c.sent_at ?? new Date(), c.attribution_days, q.filter, q.pageSize, (q.page - 1) * q.pageSize],
    ),
    c.sent_at
      ? query(
        `SELECT d::date AS date, COALESCE((SELECT sum(p.amount) FROM payments p WHERE p.status = 'recorded' AND p.paid_at >= d AND p.paid_at < d + interval '1 day'
                  AND p.paid_at >= $2 AND p.member_id IN (SELECT member_id FROM campaign_recipients WHERE campaign_id = $1 AND status <> 'skipped')), 0) AS value
           FROM generate_series(date_trunc('day', $2::timestamptz), date_trunc('day', $2::timestamptz) + make_interval(days => $3 - 1), interval '1 day') d
          WHERE d <= now() ORDER BY d`,
        [c.id, c.sent_at, c.attribution_days])
      : Promise.resolve([]),
  ]);
  const branches = await query(`SELECT id, name FROM branches WHERE id = ANY($1)`, [c.branch_ids]);
  res.json({ ...c, branches, byChannel, recipients: paged(recipients, q.page, q.pageSize), daily });
});

campaignsRouter.post('/', can('marketing.manage'), async (req, res) => {
  const b = campaignSchema.parse(req.body);
  const branchIds = scopeBranches(req, b.branchIds);
  const row = await tx(async (c) => {
    const r = await one(
      `INSERT INTO campaigns (organization_id, name, type, audience, branch_ids, channels, subject, body, offer_code, offer_valid_until, attribution_days, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [auth(req).orgId, b.name, b.type, JSON.stringify(b.audience), branchIds, b.channels, b.subject ?? null, b.body, b.offerCode ?? null, b.offerValidUntil ?? null, b.attributionDays, auth(req).userId], c);
    await audit(c, req, { action: 'campaign.created', entityType: 'campaign', entityId: r.id, summary: `Campaign “${b.name}” drafted` });
    return r;
  });
  res.status(201).json(row);
});

campaignsRouter.put('/:id', can('marketing.manage'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const b = campaignSchema.parse(req.body);
  const c0 = await loadCampaign(req, id);
  if (!['draft', 'scheduled'].includes(c0.status)) throw conflict('Sent campaigns can’t be edited — duplicate it instead');
  const branchIds = scopeBranches(req, b.branchIds);
  await pool.query(
    `UPDATE campaigns SET name=$2, type=$3, audience=$4, branch_ids=$5, channels=$6, subject=$7, body=$8, offer_code=$9, offer_valid_until=$10, attribution_days=$11, updated_at=now() WHERE id=$1`,
    [id, b.name, b.type, JSON.stringify(b.audience), branchIds, b.channels, b.subject ?? null, b.body, b.offerCode ?? null, b.offerValidUntil ?? null, b.attributionDays],
  );
  res.status(204).end();
});

/**
 * Queues the campaign to everyone in the audience on each channel. Push
 * lands in the Member App straight away; WhatsApp/SMS/email go through the
 * outbox (gateway, or the manual queue when none is connected).
 */
export async function sendCampaign(campaignId: string, actorId: string | null) {
  const c = await one(`UPDATE campaigns SET status = 'sending', updated_at = now() WHERE id = $1 AND status IN ('draft','scheduled') RETURNING *`, [campaignId]);
  if (!c) return null;
  const rows = await resolveAudience(c.organization_id, c.audience, c.branch_ids);
  const extraVars = {
    offer_code: c.offer_code ?? '',
    offer_valid_until: c.offer_valid_until ? new Date(`${c.offer_valid_until}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '',
  };
  let queued = 0;
  for (const r of rows) {
    await tx(async (tc) => {
      for (const ch of c.channels) {
        const res = await enqueueMessage(tc, {
          orgId: c.organization_id, memberId: r.member_id, leadId: r.lead_id, channel: ch, subject: c.subject, body: c.body,
          campaignId: c.id, promotional: true, loggedBy: actorId, extraVars,
        });
        await tc.query(
          `INSERT INTO campaign_recipients (campaign_id, member_id, lead_id, channel, status, skip_reason, communication_log_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [c.id, r.member_id, r.lead_id, ch, res.status, res.reason ?? null, res.logId ?? null],
        );
        if (res.status !== 'skipped') queued++;
      }
    });
  }
  await pool.query(`UPDATE campaigns SET status = 'sent', sent_at = now(), updated_at = now() WHERE id = $1`, [c.id]);
  return { audience: rows.length, queued };
}

campaignsRouter.post('/:id/send', can('marketing.manage'), async (req, res) => {
  const c = await loadCampaign(req, uuid.parse(req.params.id));
  if (!['draft', 'scheduled'].includes(c.status)) throw conflict(`This campaign is ${c.status}`);
  const result = await sendCampaign(c.id, auth(req).userId);
  if (!result) throw conflict('This campaign is already being sent');
  await audit(pool, req, { action: 'campaign.sent', entityType: 'campaign', entityId: c.id, summary: `Campaign “${c.name}” sent to ${result.audience} recipients (${result.queued} messages)` });
  res.json(result);
});

campaignsRouter.post('/:id/schedule', can('marketing.manage'), async (req, res) => {
  const { at } = z.object({ at: z.string().datetime({ offset: true }) }).parse(req.body);
  if (Date.parse(at) < Date.now() + 60_000) throw badRequest('Pick a time in the future');
  const c = await loadCampaign(req, uuid.parse(req.params.id));
  if (!['draft', 'scheduled'].includes(c.status)) throw conflict(`This campaign is ${c.status}`);
  await pool.query(`UPDATE campaigns SET status = 'scheduled', scheduled_at = $2, updated_at = now() WHERE id = $1`, [c.id, at]);
  await audit(pool, req, { action: 'campaign.scheduled', entityType: 'campaign', entityId: c.id, summary: `Campaign “${c.name}” scheduled for ${new Date(at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}` });
  res.status(204).end();
});

campaignsRouter.post('/:id/cancel', can('marketing.manage'), async (req, res) => {
  const c = await loadCampaign(req, uuid.parse(req.params.id));
  if (c.status === 'sent') {
    // Stop whatever hasn't gone out yet.
    const stopped = await query(`UPDATE communication_logs SET status = 'failed', error = 'Campaign cancelled' WHERE campaign_id = $1 AND status = 'queued' RETURNING id`, [c.id]);
    await pool.query(`UPDATE campaign_recipients SET status = 'failed', skip_reason = 'Campaign cancelled' WHERE communication_log_id = ANY($1)`, [stopped.map((s) => s.id)]);
    await audit(pool, req, { action: 'campaign.stopped', entityType: 'campaign', entityId: c.id, summary: `Campaign “${c.name}”: ${stopped.length} unsent messages stopped` });
    return res.json({ stopped: stopped.length });
  }
  if (!['draft', 'scheduled'].includes(c.status)) throw conflict(`This campaign is ${c.status}`);
  await pool.query(`UPDATE campaigns SET status = 'cancelled', updated_at = now() WHERE id = $1`, [c.id]);
  await audit(pool, req, { action: 'campaign.cancelled', entityType: 'campaign', entityId: c.id, summary: `Campaign “${c.name}” cancelled` });
  res.json({ stopped: 0 });
});

campaignsRouter.post('/:id/duplicate', can('marketing.manage'), async (req, res) => {
  const c = await loadCampaign(req, uuid.parse(req.params.id));
  const row = await one(
    `INSERT INTO campaigns (organization_id, name, type, audience, branch_ids, channels, subject, body, offer_code, offer_valid_until, attribution_days, created_by)
     SELECT organization_id, name || ' (copy)', type, audience, branch_ids, channels, subject, body, offer_code, offer_valid_until, attribution_days, $2 FROM campaigns WHERE id = $1 RETURNING id`,
    [c.id, auth(req).userId],
  );
  res.status(201).json(row);
});

export async function runScheduledCampaigns() {
  const due = await query(`SELECT id, created_by FROM campaigns WHERE status = 'scheduled' AND scheduled_at <= now()`);
  for (const c of due) {
    try {
      await sendCampaign(c.id, c.created_by);
    } catch (err) {
      console.error('scheduled campaign failed', err);
    }
  }
}
