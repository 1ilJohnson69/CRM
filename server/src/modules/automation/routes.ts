import { Router, type Request } from 'express';
import { z } from 'zod';
import { one, pool, query, tx } from '../../db/pool.js';
import { auth, can } from '../../lib/auth.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { paginationSchema, paged, uuid } from '../../lib/http.js';
import { actionSchema, DEFAULT_RULES, ensureDefaultRules, runRule, TRIGGERS, type Trigger } from './engine.js';

export const automationsRouter = Router();

const describe = (r: any) => TRIGGERS[r.trigger as Trigger].describe(r.params);

automationsRouter.get('/', can('automations.manage'), async (req, res) => {
  await ensureDefaultRules(pool, auth(req).orgId);
  const rules = await query(
    `SELECT r.*, (SELECT count(*) FROM automation_runs x WHERE x.rule_id = r.id AND x.created_at >= now() - interval '7 days')::int AS runs_7d,
            (SELECT count(*) FROM automation_runs x WHERE x.rule_id = r.id AND x.created_at >= now() - interval '30 days')::int AS runs_30d,
            (SELECT max(created_at) FROM automation_runs x WHERE x.rule_id = r.id) AS last_fired_at
       FROM automation_rules r WHERE r.organization_id = $1 ORDER BY r.is_system DESC, r.created_at`,
    [auth(req).orgId],
  );
  const order = (r: any) => (r.is_system ? DEFAULT_RULES.findIndex((d) => d.key === r.key) : 100);
  rules.sort((a, b) => order(a) - order(b));
  res.json(rules.map((r) => ({ ...r, trigger_label: TRIGGERS[r.trigger as Trigger].label, trigger_description: describe(r), subject: TRIGGERS[r.trigger as Trigger].subject })));
});

automationsRouter.get('/meta', can('automations.manage'), async (req, res) => {
  const templates = await query(`SELECT key, name, channel, audience FROM message_templates WHERE organization_id = $1 AND is_active ORDER BY name`, [auth(req).orgId]);
  res.json({
    triggers: Object.entries(TRIGGERS).map(([key, t]) => ({ key, label: t.label, subject: t.subject, params: Object.keys(t.params.shape) })),
    templates,
  });
});

const ruleSchema = z.object({
  name: z.string().trim().min(3).max(80),
  description: z.string().trim().max(300).optional().nullable(),
  trigger: z.enum(Object.keys(TRIGGERS) as [Trigger, ...Trigger[]]),
  params: z.record(z.string(), z.unknown()),
  actions: z.array(actionSchema).min(1).max(5),
  promotional: z.boolean().default(false),
  enabled: z.boolean().default(true),
});

function validate(b: z.infer<typeof ruleSchema>) {
  const params = TRIGGERS[b.trigger].params.parse(b.params);
  if (TRIGGERS[b.trigger].subject === 'lead' && b.actions.some((a) => ['notify_member', 'award_points'].includes(a.type))) {
    throw badRequest('Lead rules can only message, notify staff or create follow-ups');
  }
  return params;
}

async function loadRule(req: Request, id: string) {
  const r = await one(`SELECT * FROM automation_rules WHERE id = $1 AND organization_id = $2`, [id, auth(req).orgId]);
  if (!r) throw notFound('Automation');
  return r;
}

automationsRouter.post('/', can('automations.manage'), async (req, res) => {
  const b = ruleSchema.parse(req.body);
  const params = validate(b);
  const key = `custom_${Date.now().toString(36)}`;
  const row = await tx(async (c) => {
    const r = await one(
      `INSERT INTO automation_rules (organization_id, key, name, description, trigger, params, actions, promotional, enabled, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [auth(req).orgId, key, b.name, b.description ?? null, b.trigger, JSON.stringify(params), JSON.stringify(b.actions), b.promotional, b.enabled, auth(req).userId], c);
    await audit(c, req, { action: 'automation.created', entityType: 'automation_rule', entityId: r.id, summary: `Automation “${b.name}” created`, after: b });
    return r;
  });
  res.status(201).json(row);
});

automationsRouter.put('/:id', can('automations.manage'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const before = await loadRule(req, id);
  const b = ruleSchema.parse(req.body);
  if (before.is_system && b.trigger !== before.trigger) throw conflict('Built-in automations keep their trigger — create a new rule instead');
  const params = validate(b);
  await tx(async (c) => {
    await c.query(
      `UPDATE automation_rules SET name=$2, description=$3, trigger=$4, params=$5, actions=$6, promotional=$7, enabled=$8, updated_at=now() WHERE id=$1`,
      [id, b.name, b.description ?? null, b.trigger, JSON.stringify(params), JSON.stringify(b.actions), b.promotional, b.enabled]);
    await audit(c, req, {
      action: 'automation.updated', entityType: 'automation_rule', entityId: id, summary: `Automation “${b.name}” ${before.enabled !== b.enabled ? (b.enabled ? 'switched on' : 'switched off') : 'updated'}`,
      before: { enabled: before.enabled, params: before.params, actions: before.actions }, after: { enabled: b.enabled, params, actions: b.actions },
    });
  });
  res.status(204).end();
});

automationsRouter.delete('/:id', can('automations.manage'), async (req, res) => {
  const r = await loadRule(req, uuid.parse(req.params.id));
  if (r.is_system) throw conflict('Built-in automations can be switched off but not deleted');
  await tx(async (c) => {
    await c.query(`DELETE FROM automation_rules WHERE id = $1`, [r.id]);
    await audit(c, req, { action: 'automation.deleted', entityType: 'automation_rule', entityId: r.id, summary: `Automation “${r.name}” deleted` });
  });
  res.status(204).end();
});

/** Who would this rule act on right now, without doing anything. */
automationsRouter.post('/:id/preview', can('automations.manage'), async (req, res) => {
  res.json(await runRule(await loadRule(req, uuid.parse(req.params.id)), { dryRun: true }));
});

automationsRouter.post('/:id/run', can('automations.manage'), async (req, res) => {
  const r = await loadRule(req, uuid.parse(req.params.id));
  if (!r.enabled) throw conflict('Switch the automation on first');
  const result = await runRule(r);
  await audit(pool, req, { action: 'automation.run', entityType: 'automation_rule', entityId: r.id, summary: `Automation “${r.name}” run manually: ${result.fired} fired` });
  res.json(result);
});

automationsRouter.get('/:id/runs', can('automations.manage'), async (req, res) => {
  const r = await loadRule(req, uuid.parse(req.params.id));
  const q = paginationSchema.parse(req.query);
  const rows = await query(
    `SELECT x.id, x.occurrence_key, x.results, x.created_at, x.member_id, x.lead_id, COALESCE(mu.full_name, l.full_name) AS name, m.member_code, b.name AS branch_name,
            count(*) OVER() AS total_count
       FROM automation_runs x LEFT JOIN members m ON m.id = x.member_id LEFT JOIN users mu ON mu.id = m.user_id LEFT JOIN leads l ON l.id = x.lead_id
       LEFT JOIN branches b ON b.id = x.branch_id
      WHERE x.rule_id = $1 AND (x.branch_id IS NULL OR x.branch_id = ANY($2))
      ORDER BY x.created_at DESC LIMIT $3 OFFSET $4`,
    [r.id, auth(req).branchIds, q.pageSize, (q.page - 1) * q.pageSize],
  );
  res.json(paged(rows, q.page, q.pageSize));
});
