import { Router } from 'express';
import { z } from 'zod';
import { one, pool, query, tx } from '../../db/pool.js';
import { assertBranch, auth, branchScope, can } from '../../lib/auth.js';
import { audit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { paginationSchema, paged, uuid } from '../../lib/http.js';
import { CHANNELS, channelStatus, dispatchOutbox, enqueueMessage, PLACEHOLDERS } from './service.js';

export const messagingRouter = Router();

/** Channel status only — gateway URLs and tokens never leave the server. */
messagingRouter.get('/integrations', can('communications.log'), async (req, res) => {
  const org = await one(`SELECT messaging_settings FROM organizations WHERE id = $1`, [auth(req).orgId]);
  const stats = await query(
    `SELECT channel, count(*) FILTER (WHERE status = 'queued')::int AS queued, count(*) FILTER (WHERE status IN ('sent','delivered') AND created_at >= now() - interval '7 days')::int AS sent_7d,
            count(*) FILTER (WHERE status = 'failed' AND created_at >= now() - interval '7 days')::int AS failed_7d
       FROM communication_logs WHERE organization_id = $1 AND branch_id = ANY($2) AND channel = ANY($3) GROUP BY channel`,
    [auth(req).orgId, branchScope(req), [...CHANNELS]],
  );
  res.json({
    channels: CHANNELS.map((ch) => ({ ...channelStatus(ch), ...(stats.find((s) => s.channel === ch) ?? { queued: 0, sent_7d: 0, failed_7d: 0 }) })),
    settings: org!.messaging_settings,
    placeholders: PLACEHOLDERS,
  });
});

messagingRouter.put('/settings', can('automations.manage'), async (req, res) => {
  const b = z.object({ quietStart: z.coerce.number().int().min(0).max(23), quietEnd: z.coerce.number().int().min(0).max(23), senderName: z.string().trim().max(60).optional().nullable() }).parse(req.body);
  await tx(async (c) => {
    await c.query(`UPDATE organizations SET messaging_settings = $2 WHERE id = $1`, [auth(req).orgId, JSON.stringify(b)]);
    await audit(c, req, { action: 'messaging.settings', entityType: 'organization', entityId: auth(req).orgId, summary: `Promotional quiet hours set to ${b.quietStart}:00–${b.quietEnd}:00`, after: b });
  });
  res.json(b);
});

/** Sends a test message to a member through the chosen channel's real path. */
messagingRouter.post('/test', can('automations.manage'), async (req, res) => {
  const b = z.object({ channel: z.enum(CHANNELS), memberId: uuid }).parse(req.body);
  const m = await one(`SELECT branch_id FROM members WHERE id = $1 AND organization_id = $2`, [b.memberId, auth(req).orgId]);
  if (!m) throw notFound('Member');
  assertBranch(req, m.branch_id);
  const r = await enqueueMessage(pool, {
    orgId: auth(req).orgId, memberId: b.memberId, channel: b.channel, subject: 'Test from {{gym}}',
    body: 'Hi {{first_name}}, this is a test message from {{gym}} {{branch}}.', loggedBy: auth(req).userId,
  });
  if (r.status === 'skipped') throw badRequest(r.reason ?? 'Skipped');
  await dispatchOutbox();
  const log = await one(`SELECT status, error, provider FROM communication_logs WHERE id = $1`, [r.logId]);
  res.status(201).json(log);
});

// ------------------------------------------------------------------ outbox ----

/** Messages waiting to go out — for channels without a gateway staff send these by hand. */
messagingRouter.get('/outbox', can('communications.log'), async (req, res) => {
  const q = paginationSchema.extend({ channel: z.enum(['whatsapp', 'sms', 'email']).optional(), status: z.enum(['queued', 'failed']).default('queued') }).parse(req.query);
  const params: unknown[] = [auth(req).orgId, branchScope(req), q.status];
  const where = [`c.organization_id = $1`, `c.branch_id = ANY($2)`, `c.status = $3`, `c.channel IN ('whatsapp','sms','email')`];
  if (q.channel) { params.push(q.channel); where.push(`c.channel = $${params.length}`); }
  params.push(q.pageSize, (q.page - 1) * q.pageSize);
  const rows = await query(
    `SELECT c.id, c.channel, c.recipient, c.subject, c.body, c.status, c.error, c.attempts, c.created_at, c.promotional,
            c.member_id, c.lead_id, COALESCE(mu.full_name, l.full_name) AS name, m.member_code,
            cp.name AS campaign_name, ar.name AS rule_name, count(*) OVER() AS total_count
       FROM communication_logs c
       LEFT JOIN members m ON m.id = c.member_id LEFT JOIN users mu ON mu.id = m.user_id LEFT JOIN leads l ON l.id = c.lead_id
       LEFT JOIN campaigns cp ON cp.id = c.campaign_id LEFT JOIN automation_rules ar ON ar.id = c.automation_rule_id
      WHERE ${where.join(' AND ')} ORDER BY c.created_at
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  res.json(paged(rows.map((r) => ({ ...r, gateway: channelStatus(r.channel).connected })), q.page, q.pageSize));
});

messagingRouter.post('/outbox/mark-sent', can('communications.log'), async (req, res) => {
  const { ids } = z.object({ ids: z.array(uuid).min(1).max(200) }).parse(req.body);
  const rows = await tx(async (c) => {
    const updated = await query(
      `UPDATE communication_logs SET status = 'sent', sent_at = now(), provider = 'manual', logged_by = $3
        WHERE id = ANY($1) AND organization_id = $2 AND branch_id = ANY($4) AND status IN ('queued','failed') RETURNING id`,
      [ids, auth(req).orgId, auth(req).userId, auth(req).branchIds],
      c,
    );
    await c.query(`UPDATE campaign_recipients SET status = 'sent' WHERE communication_log_id = ANY($1)`, [updated.map((u) => u.id)]);
    return updated;
  });
  res.json({ updated: rows.length });
});

messagingRouter.post('/outbox/discard', can('communications.log'), async (req, res) => {
  const { ids } = z.object({ ids: z.array(uuid).min(1).max(200) }).parse(req.body);
  const rows = await query(
    `UPDATE communication_logs SET status = 'failed', error = 'Discarded by ' || $3
      WHERE id = ANY($1) AND organization_id = $2 AND branch_id = ANY($4) AND status = 'queued' RETURNING id`,
    [ids, auth(req).orgId, auth(req).fullName, auth(req).branchIds],
  );
  await pool.query(`UPDATE campaign_recipients SET status = 'failed', skip_reason = 'Discarded' WHERE communication_log_id = ANY($1)`, [rows.map((r) => r.id)]);
  res.json({ updated: rows.length });
});

messagingRouter.post('/outbox/retry', can('communications.log'), async (req, res) => {
  const { ids } = z.object({ ids: z.array(uuid).min(1).max(200) }).parse(req.body);
  const rows = await query(
    `UPDATE communication_logs SET status = 'queued', attempts = 0, error = NULL WHERE id = ANY($1) AND organization_id = $2 AND branch_id = ANY($3) AND status = 'failed' RETURNING id`,
    [ids, auth(req).orgId, auth(req).branchIds],
  );
  res.json({ updated: rows.length });
});

// ----------------------------------------------------------------- consent ----

messagingRouter.post('/consent', can('members.write'), async (req, res) => {
  const b = z.object({ memberId: uuid.optional(), leadId: uuid.optional(), optOut: z.boolean() }).refine((v) => !!v.memberId !== !!v.leadId).parse(req.body);
  const table = b.memberId ? 'members' : 'leads';
  const id = b.memberId ?? b.leadId;
  await tx(async (c) => {
    const row = await one(`SELECT branch_id FROM ${table} WHERE id = $1 AND organization_id = $2`, [id, auth(req).orgId], c);
    if (!row) throw notFound(b.memberId ? 'Member' : 'Lead');
    assertBranch(req, row.branch_id);
    await c.query(`UPDATE ${table} SET marketing_opt_out = $2 WHERE id = $1`, [id, b.optOut]);
    await audit(c, req, { action: 'consent.updated', entityType: b.memberId ? 'member' : 'lead', entityId: id, branchId: row.branch_id, summary: b.optOut ? 'Opted out of promotional messages' : 'Opted back in to promotional messages' });
  });
  res.status(204).end();
});
