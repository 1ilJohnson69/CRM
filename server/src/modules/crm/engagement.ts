import { Router, type Request } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { one, query, tx } from '../../db/pool.js';
import { auth, branchScope, can } from '../../lib/auth.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { paginationSchema, paged, uuid } from '../../lib/http.js';

const FOLLOW_UP_TYPES = ['call', 'whatsapp', 'sms', 'email', 'in_person', 'other'] as const;
const PURPOSES = ['general', 'sales', 'trial', 'renewal', 'payment', 'reactivation', 'feedback'] as const;
const OUTCOMES = ['connected', 'no_answer', 'interested', 'not_interested', 'callback', 'converted', 'renewed', 'paid', 'other'] as const;
const CHANNELS = ['call', 'whatsapp', 'sms', 'email', 'in_person', 'note'] as const;

const target = z
  .object({ leadId: uuid.optional().nullable(), memberId: uuid.optional().nullable() })
  .refine((v) => !!v.leadId !== !!v.memberId, 'Pick exactly one lead or member');

/** Resolves the lead or member a follow-up / message is about, enforcing branch access. */
async function resolveTarget(req: Request, t: { leadId?: string | null; memberId?: string | null }, c?: PoolClient) {
  if (t.leadId) {
    const l = await one(
      `SELECT l.id, l.branch_id, l.full_name, l.phone, l.email, l.stage, l.assigned_to, l.trial_at, p.name AS plan_name, p.price AS plan_price
         FROM leads l LEFT JOIN membership_plans p ON p.id = l.interested_plan_id WHERE l.id = $1 AND l.organization_id = $2`,
      [t.leadId, auth(req).orgId],
      c,
    );
    if (!l || !auth(req).branchIds.includes(l.branch_id)) throw notFound('Lead');
    return { kind: 'lead' as const, ...l };
  }
  const m = await one(
    `SELECT m.id, m.branch_id, m.member_code, m.assigned_staff_id AS assigned_to, u.full_name, u.phone, u.email,
            cm.plan_name, cm.end_date, cm.days_remaining, cm.status, cm.price AS plan_price, bal.outstanding
       FROM members m JOIN users u ON u.id = m.user_id
       JOIN member_current_membership cm ON cm.member_id = m.id JOIN member_balances bal ON bal.member_id = m.id
      WHERE m.id = $1 AND m.organization_id = $2`,
    [t.memberId, auth(req).orgId],
    c,
  );
  if (!m || !auth(req).branchIds.includes(m.branch_id)) throw notFound('Member');
  return { kind: 'member' as const, ...m };
}

/**
 * Records a touchpoint. Contacting a lead stamps last_contacted_at and moves
 * a brand-new lead to "contacted" so the pipeline reflects real activity.
 */
export async function logCommunication(
  c: PoolClient,
  req: Request,
  input: { leadId?: string | null; memberId?: string | null; channel: string; direction?: string; templateKey?: string | null; subject?: string | null; body?: string | null; outcome?: string | null; followUpId?: string | null },
) {
  const t = await resolveTarget(req, input, c);
  const row = await one(
    `INSERT INTO communication_logs (organization_id, branch_id, lead_id, member_id, channel, direction, template_key, subject, body, outcome, follow_up_id, logged_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [auth(req).orgId, t.branch_id, input.leadId ?? null, input.memberId ?? null, input.channel, input.direction ?? 'outbound',
      input.templateKey ?? null, input.subject ?? null, input.body ?? null, input.outcome ?? null, input.followUpId ?? null, auth(req).userId],
    c,
  );
  if (t.kind === 'lead' && input.channel !== 'note' && (input.direction ?? 'outbound') !== 'internal') {
    await c.query(`UPDATE leads SET last_contacted_at = now(), updated_at = now() WHERE id = $1`, [t.id]);
    if (t.stage === 'new') {
      await c.query(`UPDATE leads SET stage = 'contacted', stage_changed_at = now() WHERE id = $1`, [t.id]);
      await c.query(`INSERT INTO lead_stage_history (lead_id, from_stage, to_stage, changed_by) VALUES ($1,'new','contacted',$2)`, [t.id, auth(req).userId]);
    }
  }
  return row;
}

// ------------------------------------------------------------- follow-ups --

export const followUpsRouter = Router();

const followUpList = paginationSchema.extend({
  bucket: z.enum(['overdue', 'today', 'upcoming', 'open', 'done']).default('open'),
  assignedTo: z.string().default('me'),
  purpose: z.enum(PURPOSES).optional(),
  leadId: uuid.optional(),
  memberId: uuid.optional(),
});

followUpsRouter.get('/summary', can('followups.manage'), async (req, res) => {
  const { assignedTo } = z.object({ assignedTo: z.string().default('me') }).parse(req.query);
  const row = await one(
    `SELECT count(*) FILTER (WHERE due_at < date_trunc('day', now())) AS overdue,
            count(*) FILTER (WHERE due_at >= date_trunc('day', now()) AND due_at < date_trunc('day', now()) + interval '1 day') AS today,
            count(*) FILTER (WHERE due_at >= date_trunc('day', now()) + interval '1 day' AND due_at < date_trunc('day', now()) + interval '8 days') AS upcoming,
            (SELECT count(*) FROM follow_ups d WHERE d.organization_id = $1 AND d.branch_id = ANY($2) AND d.status = 'done'
                AND d.completed_at >= date_trunc('day', now()) AND ($3::uuid IS NULL OR d.completed_by = $3)) AS done_today
       FROM follow_ups WHERE organization_id = $1 AND branch_id = ANY($2) AND status = 'pending' AND ($3::uuid IS NULL OR assigned_to = $3)`,
    [auth(req).orgId, branchScope(req), assignedTo === 'all' ? null : assignedTo === 'me' ? auth(req).userId : assignedTo],
  );
  res.json(Object.fromEntries(Object.entries(row!).map(([k, v]) => [k, Number(v)])));
});

followUpsRouter.get('/', can('followups.manage'), async (req, res) => {
  const q = followUpList.parse(req.query);
  const params: unknown[] = [auth(req).orgId, branchScope(req)];
  const where = [`f.organization_id = $1`, `f.branch_id = ANY($2)`];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replaceAll('$?', `$${params.length}`));
  };
  // A follow-up list scoped to one lead/member shows everyone's tasks.
  if (q.assignedTo !== 'all' && !q.leadId && !q.memberId) add(`f.assigned_to = $?`, q.assignedTo === 'me' ? auth(req).userId : q.assignedTo);
  const day = `date_trunc('day', now())`;
  if (!q.leadId && !q.memberId) {
    if (q.bucket === 'overdue') where.push(`f.status = 'pending' AND f.due_at < ${day}`);
    if (q.bucket === 'today') where.push(`f.status = 'pending' AND f.due_at >= ${day} AND f.due_at < ${day} + interval '1 day'`);
    if (q.bucket === 'upcoming') where.push(`f.status = 'pending' AND f.due_at >= ${day} + interval '1 day'`);
    if (q.bucket === 'open') where.push(`f.status = 'pending'`);
    if (q.bucket === 'done') where.push(`f.status <> 'pending'`);
  }
  if (q.purpose) add(`f.purpose = $?`, q.purpose);
  if (q.leadId) add(`f.lead_id = $?`, q.leadId);
  if (q.memberId) add(`f.member_id = $?`, q.memberId);
  params.push(q.pageSize, (q.page - 1) * q.pageSize);
  const order = q.bucket === 'done' ? 'f.completed_at DESC NULLS LAST' : `f.status = 'pending' DESC, f.due_at`;
  const rows = await query(
    `SELECT f.*, au.full_name AS assigned_name, cu.full_name AS completed_by_name,
            COALESCE(l.full_name, mu.full_name) AS subject_name, COALESCE(l.phone, mu.phone) AS subject_phone,
            l.stage AS lead_stage, m.member_code, cm.status AS member_status, cm.plan_name AS member_plan, cm.end_date AS member_end_date,
            count(*) OVER() AS total_count
       FROM follow_ups f
       LEFT JOIN users au ON au.id = f.assigned_to LEFT JOIN users cu ON cu.id = f.completed_by
       LEFT JOIN leads l ON l.id = f.lead_id
       LEFT JOIN members m ON m.id = f.member_id LEFT JOIN users mu ON mu.id = m.user_id
       LEFT JOIN member_current_membership cm ON cm.member_id = m.id
      WHERE ${where.join(' AND ')}
      ORDER BY ${order}
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  res.json(paged(rows, q.page, q.pageSize));
});

const followUpCreate = z
  .object({
    leadId: uuid.optional().nullable(),
    memberId: uuid.optional().nullable(),
    type: z.enum(FOLLOW_UP_TYPES),
    purpose: z.enum(PURPOSES).default('general'),
    dueAt: z.string().datetime({ offset: true }),
    assignedTo: uuid.optional().nullable(),
    notes: z.string().trim().max(1000).optional().nullable(),
  })
  .refine((v) => !!v.leadId !== !!v.memberId, 'Pick exactly one lead or member');

async function insertFollowUp(c: PoolClient, req: Request, body: z.infer<typeof followUpCreate>) {
  const t = await resolveTarget(req, body, c);
  if (t.kind === 'lead' && ['won', 'lost'].includes(t.stage)) throw conflict('This lead is closed');
  return one(
    `INSERT INTO follow_ups (organization_id, branch_id, lead_id, member_id, type, purpose, due_at, assigned_to, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [auth(req).orgId, t.branch_id, body.leadId ?? null, body.memberId ?? null, body.type, body.purpose, body.dueAt,
      body.assignedTo ?? t.assigned_to ?? auth(req).userId, body.notes ?? null, auth(req).userId],
    c,
  );
}

followUpsRouter.post('/', can('followups.manage'), async (req, res) => {
  const body = followUpCreate.parse(req.body);
  res.status(201).json(await tx((c) => insertFollowUp(c, req, body)));
});

async function loadFollowUp(c: PoolClient, req: Request, id: string) {
  const f = await one(`SELECT * FROM follow_ups WHERE id = $1 AND organization_id = $2 FOR UPDATE`, [id, auth(req).orgId], c);
  if (!f || !auth(req).branchIds.includes(f.branch_id)) throw notFound('Follow-up');
  return f;
}

followUpsRouter.post('/:id/complete', can('followups.manage'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const body = z
    .object({
      outcome: z.enum(OUTCOMES),
      notes: z.string().trim().max(2000).optional().nullable(),
      next: z.object({ type: z.enum(FOLLOW_UP_TYPES), dueAt: z.string().datetime({ offset: true }), notes: z.string().trim().optional().nullable() }).optional().nullable(),
    })
    .parse(req.body);
  const result = await tx(async (c) => {
    const f = await loadFollowUp(c, req, id);
    if (f.status !== 'pending') throw conflict('This follow-up is already closed');
    await c.query(
      `UPDATE follow_ups SET status = 'done', outcome = $2, outcome_notes = $3, completed_at = now(), completed_by = $4 WHERE id = $1`,
      [id, body.outcome, body.notes ?? null, auth(req).userId],
    );
    // Completing a contact task is itself a touchpoint.
    if (f.type !== 'other') {
      await logCommunication(c, req, {
        leadId: f.lead_id, memberId: f.member_id, channel: f.type, outcome: body.outcome, body: body.notes ?? f.notes, followUpId: id,
      });
    }
    const next = body.next
      ? await insertFollowUp(c, req, { leadId: f.lead_id, memberId: f.member_id, type: body.next.type, purpose: f.purpose, dueAt: body.next.dueAt, assignedTo: f.assigned_to, notes: body.next.notes ?? null })
      : null;
    return { next };
  });
  res.json(result);
});

followUpsRouter.patch('/:id', can('followups.manage'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const body = z.object({ dueAt: z.string().datetime({ offset: true }).optional(), assignedTo: uuid.optional(), notes: z.string().trim().optional().nullable(), type: z.enum(FOLLOW_UP_TYPES).optional() }).parse(req.body);
  await tx(async (c) => {
    const f = await loadFollowUp(c, req, id);
    if (f.status !== 'pending') throw conflict('This follow-up is already closed');
    await c.query(
      `UPDATE follow_ups SET due_at = COALESCE($2, due_at), assigned_to = COALESCE($3, assigned_to), notes = COALESCE($4, notes), type = COALESCE($5, type) WHERE id = $1`,
      [id, body.dueAt ?? null, body.assignedTo ?? null, body.notes ?? null, body.type ?? null],
    );
  });
  res.status(204).end();
});

followUpsRouter.post('/:id/cancel', can('followups.manage'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  await tx(async (c) => {
    const f = await loadFollowUp(c, req, id);
    if (f.status !== 'pending') throw conflict('This follow-up is already closed');
    await c.query(`UPDATE follow_ups SET status = 'cancelled', completed_at = now(), completed_by = $2 WHERE id = $1`, [id, auth(req).userId]);
  });
  res.status(204).end();
});

// ---------------------------------------------------------- communication --

export const communicationsRouter = Router();

const commList = paginationSchema.extend({
  channel: z.enum(CHANNELS).optional(),
  leadId: uuid.optional(),
  memberId: uuid.optional(),
  loggedBy: z.string().optional(),
  search: z.string().trim().optional(),
});

communicationsRouter.get('/', can('communications.log'), async (req, res) => {
  const q = commList.parse(req.query);
  const params: unknown[] = [auth(req).orgId, branchScope(req)];
  const where = [`c.organization_id = $1`, `c.branch_id = ANY($2)`];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replaceAll('$?', `$${params.length}`));
  };
  if (q.channel) add(`c.channel = $?`, q.channel);
  if (q.leadId) add(`c.lead_id = $?`, q.leadId);
  if (q.memberId) add(`c.member_id = $?`, q.memberId);
  if (q.loggedBy) add(`c.logged_by = $?`, q.loggedBy === 'me' ? auth(req).userId : q.loggedBy);
  if (q.search) add(`(COALESCE(l.full_name, mu.full_name) ILIKE $? OR c.body ILIKE $?)`, `%${q.search}%`);
  params.push(q.pageSize, (q.page - 1) * q.pageSize);
  const rows = await query(
    `SELECT c.*, u.full_name AS logged_by_name, COALESCE(l.full_name, mu.full_name) AS subject_name, m.member_code, t.name AS template_name,
            count(*) OVER() AS total_count
       FROM communication_logs c
       LEFT JOIN users u ON u.id = c.logged_by
       LEFT JOIN leads l ON l.id = c.lead_id
       LEFT JOIN members m ON m.id = c.member_id LEFT JOIN users mu ON mu.id = m.user_id
       LEFT JOIN message_templates t ON t.organization_id = c.organization_id AND t.key = c.template_key
      WHERE ${where.join(' AND ')}
      ORDER BY c.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  res.json(paged(rows, q.page, q.pageSize));
});

communicationsRouter.get('/stats', can('communications.log'), async (req, res) => {
  const rows = await query(
    `SELECT channel, count(*) AS n FROM communication_logs
      WHERE organization_id = $1 AND branch_id = ANY($2) AND created_at >= now() - interval '30 days' GROUP BY channel`,
    [auth(req).orgId, branchScope(req)],
  );
  res.json(Object.fromEntries(rows.map((r) => [r.channel, Number(r.n)])));
});

communicationsRouter.post('/', can('communications.log'), async (req, res) => {
  const body = z
    .object({
      leadId: uuid.optional().nullable(),
      memberId: uuid.optional().nullable(),
      channel: z.enum(CHANNELS),
      direction: z.enum(['outbound', 'inbound', 'internal']).default('outbound'),
      templateKey: z.string().optional().nullable(),
      subject: z.string().trim().max(200).optional().nullable(),
      body: z.string().trim().max(4000).optional().nullable(),
      outcome: z.string().trim().max(60).optional().nullable(),
      followUp: z.object({ type: z.enum(FOLLOW_UP_TYPES), dueAt: z.string().datetime({ offset: true }), purpose: z.enum(PURPOSES).default('general'), notes: z.string().optional().nullable() }).optional().nullable(),
    })
    .and(target)
    .parse(req.body);
  const result = await tx(async (c) => {
    const log = await logCommunication(c, req, body);
    const followUp = body.followUp
      ? await insertFollowUp(c, req, { leadId: body.leadId, memberId: body.memberId, ...body.followUp, assignedTo: null })
      : null;
    return { log, followUp };
  });
  res.status(201).json(result);
});

// -------------------------------------------------------------- templates --

const PLACEHOLDERS = ['first_name', 'full_name', 'member_code', 'plan', 'expiry_date', 'days_left', 'amount_due', 'trial_date', 'gym', 'branch', 'branch_phone'] as const;

function fmtDate(d: string | Date | null | undefined) {
  if (!d) return '';
  const date = typeof d === 'string' && d.length === 10 ? new Date(`${d}T00:00:00Z`) : new Date(d);
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}

export function renderTemplate(text: string, vars: Record<string, string>) {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, k) => vars[k] ?? '');
}

const waNumber = (phone?: string | null) => {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  return digits.length === 10 ? `91${digits}` : digits;
};

export const templatesRouter = Router();

templatesRouter.get('/', can('communications.log'), async (req, res) => {
  res.json({ placeholders: PLACEHOLDERS, data: await query(`SELECT * FROM message_templates WHERE organization_id = $1 ORDER BY audience, name`, [auth(req).orgId]) });
});

const templateSchema = z.object({
  name: z.string().trim().min(2),
  channel: z.enum(['whatsapp', 'sms', 'email', 'any']),
  audience: z.enum(['lead', 'member', 'any']),
  subject: z.string().trim().optional().nullable(),
  body: z.string().trim().min(2).max(2000),
  isActive: z.boolean().default(true),
});

templatesRouter.post('/', can('templates.manage'), async (req, res) => {
  const b = templateSchema.parse(req.body);
  const key = `${b.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}_${Date.now().toString(36)}`;
  res.status(201).json(
    await one(
      `INSERT INTO message_templates (organization_id, key, name, channel, audience, subject, body, is_active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [auth(req).orgId, key, b.name, b.channel, b.audience, b.subject ?? null, b.body, b.isActive],
    ),
  );
});

templatesRouter.put('/:id', can('templates.manage'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const b = templateSchema.parse(req.body);
  const row = await tx(async (c) => {
    const before = await one(`SELECT * FROM message_templates WHERE id = $1 AND organization_id = $2`, [id, auth(req).orgId], c);
    if (!before) throw notFound('Template');
    const after = await one(
      `UPDATE message_templates SET name=$2, channel=$3, audience=$4, subject=$5, body=$6, is_active=$7, updated_at=now() WHERE id=$1 RETURNING *`,
      [id, b.name, b.channel, b.audience, b.subject ?? null, b.body, b.isActive],
      c,
    );
    await audit(c, req, { action: 'template.updated', entityType: 'template', entityId: id, summary: `Template “${b.name}” updated`, before: { body: before.body }, after: { body: b.body } });
    return after;
  });
  res.json(row);
});

/**
 * Renders a template for one lead/member and returns ready-to-open links.
 * Sending happens on the staff member's own WhatsApp/phone/email until a
 * provider is connected; the CRM logs it either way.
 */
templatesRouter.get('/compose', can('communications.log'), async (req, res) => {
  const q = z
    .object({ leadId: uuid.optional(), memberId: uuid.optional(), templateKey: z.string().optional(), channel: z.enum(CHANNELS).default('whatsapp') })
    .refine((v) => !!v.leadId !== !!v.memberId, 'Pick exactly one lead or member')
    .parse(req.query);
  const t = await resolveTarget(req, q);
  const [org, branch] = await Promise.all([
    one(`SELECT name FROM organizations WHERE id = $1`, [auth(req).orgId]),
    one(`SELECT name, phone FROM branches WHERE id = $1`, [t.branch_id]),
  ]);
  const vars: Record<string, string> = {
    first_name: t.full_name.split(' ')[0],
    full_name: t.full_name,
    member_code: 'member_code' in t ? t.member_code : '',
    plan: t.plan_name ?? 'membership',
    expiry_date: 'end_date' in t ? fmtDate(t.end_date) : '',
    days_left: 'days_remaining' in t && t.days_remaining !== null ? String(t.days_remaining) : '',
    amount_due: 'outstanding' in t ? `₹${Number(t.outstanding).toLocaleString('en-IN')}` : '',
    trial_date: 'trial_at' in t ? fmtDate(t.trial_at) : '',
    gym: org!.name,
    branch: branch!.name,
    branch_phone: branch!.phone ?? '',
  };
  const tpl = q.templateKey
    ? await one(`SELECT * FROM message_templates WHERE organization_id = $1 AND key = $2`, [auth(req).orgId, q.templateKey])
    : null;
  if (q.templateKey && !tpl) throw badRequest('Unknown template');
  const body = tpl ? renderTemplate(tpl.body, vars) : '';
  const subject = tpl?.subject ? renderTemplate(tpl.subject, vars) : '';
  const wa = waNumber(t.phone);
  res.json({
    to: { name: t.full_name, phone: t.phone, email: t.email },
    subject,
    body,
    links: {
      whatsapp: wa ? `https://wa.me/${wa}${body ? `?text=${encodeURIComponent(body)}` : ''}` : null,
      sms: t.phone ? `sms:${t.phone}${body ? `?body=${encodeURIComponent(body)}` : ''}` : null,
      email: t.email ? `mailto:${t.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` : null,
      call: t.phone ? `tel:${t.phone}` : null,
    },
  });
});

