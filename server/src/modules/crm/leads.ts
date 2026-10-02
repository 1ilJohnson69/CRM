import { Router, type Request } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { one, query, tx } from '../../db/pool.js';
import { assertBranch, auth, branchScope, can } from '../../lib/auth.js';
import { audit, notify } from '../../lib/audit.js';
import { badRequest, conflict, HttpError, notFound } from '../../lib/errors.js';
import { paginationSchema, paged, uuid } from '../../lib/http.js';
import { createMember, memberCreateSchema } from '../members/service.js';

export const LEAD_STAGES = ['new', 'contacted', 'interested', 'trial_booked', 'trial_completed', 'negotiation', 'won', 'lost'] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];
const STAGE_LABEL: Record<LeadStage, string> = {
  new: 'New', contacted: 'Contacted', interested: 'Interested', trial_booked: 'Trial booked', trial_completed: 'Trial completed',
  negotiation: 'Negotiation', won: 'Won', lost: 'Lost',
};

const phoneSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .pipe(z.string().regex(/^\+?\d{10,13}$/, 'Enter a valid phone number'));

const leadFields = {
  fullName: z.string().trim().min(2),
  phone: phoneSchema.optional().nullable(),
  email: z.string().trim().email().toLowerCase().optional().nullable().or(z.literal('').transform(() => null)),
  gender: z.enum(['male', 'female', 'other']).optional().nullable(),
  branchId: uuid,
  sourceId: uuid.optional().nullable(),
  referredByMemberId: uuid.optional().nullable(),
  interestedPlanId: uuid.optional().nullable(),
  interestedService: z.string().trim().optional().nullable(),
  budget: z.coerce.number().min(0).optional().nullable(),
  goal: z.string().trim().optional().nullable(),
  expectedValue: z.coerce.number().min(0).optional().nullable(),
  assignedTo: uuid.optional().nullable(),
  trialAt: z.string().datetime({ offset: true }).optional().nullable(),
  notes: z.string().trim().optional().nullable(),
};

/** Lead row with everything list and board views need. */
const LEAD_SELECT = `
  SELECT l.*, s.name AS source_name, p.name AS plan_name, p.price AS plan_price, b.name AS branch_name,
         au.full_name AS assigned_name, rm.member_code AS referred_by_code, ru.full_name AS referred_by_name,
         nf.next_follow_up_at, nf.next_follow_up_type,
         COALESCE(l.expected_value, p.price) AS potential_value
    FROM leads l
    JOIN branches b ON b.id = l.branch_id
    LEFT JOIN lead_sources s ON s.id = l.source_id
    LEFT JOIN membership_plans p ON p.id = l.interested_plan_id
    LEFT JOIN users au ON au.id = l.assigned_to
    LEFT JOIN members rm ON rm.id = l.referred_by_member_id
    LEFT JOIN users ru ON ru.id = rm.user_id
    LEFT JOIN LATERAL (
      SELECT f.due_at AS next_follow_up_at, f.type AS next_follow_up_type FROM follow_ups f
       WHERE f.lead_id = l.id AND f.status = 'pending' ORDER BY f.due_at LIMIT 1
    ) nf ON true`;

async function loadLead(c: PoolClient | undefined, req: Request, id: string, lock = false) {
  const lead = await one(
    `SELECT * FROM leads WHERE id = $1 AND organization_id = $2 ${lock ? 'FOR UPDATE' : ''}`,
    [id, auth(req).orgId],
    c,
  );
  if (!lead || !auth(req).branchIds.includes(lead.branch_id)) throw notFound('Lead');
  return lead;
}

async function recordStage(c: PoolClient, req: Request, leadId: string, from: string | null, to: string) {
  await c.query(`INSERT INTO lead_stage_history (lead_id, from_stage, to_stage, changed_by) VALUES ($1,$2,$3,$4)`, [leadId, from, to, auth(req).userId]);
}

/** Possible duplicates by phone/email among open leads and members. */
async function findDuplicates(orgId: string, phone?: string | null, email?: string | null, excludeLeadId?: string) {
  if (!phone && !email) return { leads: [], members: [] };
  const [leads, members] = await Promise.all([
    query(
      `SELECT id, full_name, stage, phone, email FROM leads
        WHERE organization_id = $1 AND stage NOT IN ('won', 'lost') AND ($4::uuid IS NULL OR id <> $4)
          AND (($2::text IS NOT NULL AND phone = $2) OR ($3::text IS NOT NULL AND lower(email) = lower($3)))
        LIMIT 5`,
      [orgId, phone ?? null, email ?? null, excludeLeadId ?? null],
    ),
    query(
      `SELECT m.id, m.member_code, u.full_name, cm.status FROM members m JOIN users u ON u.id = m.user_id
         JOIN member_current_membership cm ON cm.member_id = m.id
        WHERE m.organization_id = $1 AND (($2::text IS NOT NULL AND u.phone = $2) OR ($3::text IS NOT NULL AND lower(u.email) = lower($3)))
        LIMIT 5`,
      [orgId, phone ?? null, email ?? null],
    ),
  ]);
  return { leads, members };
}

export async function cancelPendingFollowUps(c: PoolClient, req: Request, where: { leadId?: string; memberId?: string }, outcome: string, purpose?: string) {
  await c.query(
    `UPDATE follow_ups SET status = 'done', outcome = $3, completed_at = now(), completed_by = $4,
            outcome_notes = COALESCE(outcome_notes, 'Closed automatically')
      WHERE status = 'pending' AND (lead_id = $1 OR member_id = $2) AND ($5::text IS NULL OR purpose = $5)`,
    [where.leadId ?? null, where.memberId ?? null, outcome, auth(req).userId, purpose ?? null],
  );
}

export const leadsRouter = Router();

// ------------------------------------------------------------------ board --

leadsRouter.get('/board', can('leads.read'), async (req, res) => {
  const q = z.object({ assignedTo: z.string().optional(), sourceId: uuid.optional(), search: z.string().trim().optional() }).parse(req.query);
  const params: unknown[] = [auth(req).orgId, branchScope(req)];
  const where = [`l.organization_id = $1`, `l.branch_id = ANY($2)`,
    // Closed deals stay on the board for 30 days, then live only in the list view.
    `(l.stage NOT IN ('won','lost') OR l.stage_changed_at > now() - interval '30 days')`];
  if (q.assignedTo) {
    params.push(q.assignedTo === 'me' ? auth(req).userId : q.assignedTo);
    where.push(`l.assigned_to = $${params.length}`);
  }
  if (q.sourceId) {
    params.push(q.sourceId);
    where.push(`l.source_id = $${params.length}`);
  }
  if (q.search) {
    params.push(`%${q.search}%`);
    where.push(`(l.full_name ILIKE $${params.length} OR l.phone ILIKE $${params.length} OR l.email ILIKE $${params.length})`);
  }
  const rows = await query(`${LEAD_SELECT} WHERE ${where.join(' AND ')} ORDER BY l.position, l.created_at DESC`, params);
  res.json(
    LEAD_STAGES.map((stage) => {
      const leads = rows.filter((r) => r.stage === stage);
      return { stage, label: STAGE_LABEL[stage], count: leads.length, value: leads.reduce((s, l) => s + Number(l.potential_value ?? 0), 0), leads };
    }),
  );
});

// ------------------------------------------------------------------- list --

const listSchema = paginationSchema.extend({
  search: z.string().trim().optional(),
  stage: z.enum([...LEAD_STAGES, 'open']).optional(),
  sourceId: uuid.optional(),
  assignedTo: z.string().optional(),
  followUp: z.enum(['overdue', 'today', 'none']).optional(),
});

leadsRouter.get('/', can('leads.read'), async (req, res) => {
  const q = listSchema.parse(req.query);
  const params: unknown[] = [auth(req).orgId, branchScope(req)];
  const where = [`l.organization_id = $1`, `l.branch_id = ANY($2)`];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replaceAll('$?', `$${params.length}`));
  };
  if (q.search) add(`(l.full_name ILIKE $? OR l.phone ILIKE $? OR l.email ILIKE $?)`, `%${q.search}%`);
  if (q.stage === 'open') where.push(`l.stage NOT IN ('won','lost')`);
  else if (q.stage) add(`l.stage = $?`, q.stage);
  if (q.sourceId) add(`l.source_id = $?`, q.sourceId);
  if (q.assignedTo) add(`l.assigned_to = $?`, q.assignedTo === 'me' ? auth(req).userId : q.assignedTo);
  if (q.followUp === 'overdue') where.push(`nf.next_follow_up_at < now()`);
  if (q.followUp === 'today') where.push(`nf.next_follow_up_at::date = current_date`);
  if (q.followUp === 'none') where.push(`nf.next_follow_up_at IS NULL AND l.stage NOT IN ('won','lost')`);
  params.push(q.pageSize, (q.page - 1) * q.pageSize);
  const rows = await query(
    `SELECT x.*, count(*) OVER() AS total_count FROM (${LEAD_SELECT} WHERE ${where.join(' AND ')}) x
      ORDER BY x.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  res.json(paged(rows, q.page, q.pageSize));
});

leadsRouter.get('/sources', can('leads.read'), async (req, res) => {
  res.json(await query(`SELECT * FROM lead_sources WHERE organization_id = $1 ORDER BY sort, name`, [auth(req).orgId]));
});

leadsRouter.post('/sources', can('leads.write'), async (req, res) => {
  const { name } = z.object({ name: z.string().trim().min(2) }).parse(req.body);
  res.status(201).json(
    await one(
      `INSERT INTO lead_sources (organization_id, name, sort) VALUES ($1, $2, (SELECT COALESCE(max(sort), 0) + 1 FROM lead_sources WHERE organization_id = $1)) RETURNING *`,
      [auth(req).orgId, name],
    ),
  );
});

leadsRouter.get('/duplicates', can('leads.read'), async (req, res) => {
  const q = z.object({ phone: phoneSchema.optional(), email: z.string().trim().optional(), excludeLeadId: uuid.optional() }).parse(req.query);
  res.json(await findDuplicates(auth(req).orgId, q.phone, q.email || null, q.excludeLeadId));
});

// ----------------------------------------------------------------- create --

leadsRouter.post('/', can('leads.write'), async (req, res) => {
  const body = z.object({ ...leadFields, allowDuplicate: z.boolean().default(false), firstFollowUpAt: z.string().datetime({ offset: true }).optional().nullable() }).parse(req.body);
  if (!body.phone && !body.email) throw badRequest('Add a phone number or email');
  assertBranch(req, body.branchId);
  if (!body.allowDuplicate) {
    const dups = await findDuplicates(auth(req).orgId, body.phone, body.email);
    if (dups.leads.length || dups.members.length) throw new HttpError(409, 'possible_duplicate', 'This person may already exist', dups);
  }
  const lead = await tx(async (c) => {
    const assignee = body.assignedTo ?? auth(req).userId;
    const top = await one(`SELECT COALESCE(min(position), 0) - 1 AS p FROM leads WHERE branch_id = $1 AND stage = 'new'`, [body.branchId], c);
    const row = await one(
      `INSERT INTO leads (organization_id, branch_id, full_name, phone, email, gender, source_id, referred_by_member_id, interested_plan_id,
                          interested_service, budget, goal, expected_value, assigned_to, trial_at, notes, position, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [auth(req).orgId, body.branchId, body.fullName, body.phone ?? null, body.email ?? null, body.gender ?? null, body.sourceId ?? null,
        body.referredByMemberId ?? null, body.interestedPlanId ?? null, body.interestedService ?? null, body.budget ?? null, body.goal ?? null,
        body.expectedValue ?? null, assignee, body.trialAt ?? null, body.notes ?? null, top!.p, auth(req).userId],
      c,
    );
    await recordStage(c, req, row.id, null, 'new');
    // Speed-to-lead: every new lead gets a first call scheduled unless the creator picked a time.
    await c.query(
      `INSERT INTO follow_ups (organization_id, branch_id, lead_id, type, purpose, due_at, assigned_to, notes, auto_generated, created_by)
       VALUES ($1,$2,$3,'call','sales', COALESCE($4::timestamptz, now() + interval '1 hour'), $5, 'First contact', $6, $7)`,
      [auth(req).orgId, body.branchId, row.id, body.firstFollowUpAt ?? null, assignee, !body.firstFollowUpAt, auth(req).userId],
    );
    const source = body.sourceId ? await one(`SELECT name FROM lead_sources WHERE id = $1`, [body.sourceId], c) : null;
    await audit(c, req, {
      action: 'lead.created', entityType: 'lead', entityId: row.id, branchId: body.branchId,
      summary: `New lead ${body.fullName}${source ? ` from ${source.name}` : ''}`,
      after: { phone: body.phone, email: body.email, source: source?.name },
    });
    await notify(c, {
      orgId: auth(req).orgId, branchId: body.branchId, recipientId: assignee !== auth(req).userId ? assignee : null,
      type: 'lead.created', title: `New lead: ${body.fullName}`, body: `${source?.name ?? 'Direct'} · first call due within the hour`,
      entityType: 'lead', entityId: row.id,
    });
    return row;
  });
  res.status(201).json(lead);
});

// ----------------------------------------------------------------- detail --

leadsRouter.get('/:id', can('leads.read'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  await loadLead(undefined, req, id);
  const [lead, history, followUps, comms] = await Promise.all([
    one(`${LEAD_SELECT} WHERE l.id = $1`, [id]),
    query(
      `SELECT h.*, u.full_name AS changed_by_name FROM lead_stage_history h LEFT JOIN users u ON u.id = h.changed_by
        WHERE h.lead_id = $1 ORDER BY h.changed_at`,
      [id],
    ),
    query(
      `SELECT f.*, au.full_name AS assigned_name, cu.full_name AS completed_by_name FROM follow_ups f
         LEFT JOIN users au ON au.id = f.assigned_to LEFT JOIN users cu ON cu.id = f.completed_by
        WHERE f.lead_id = $1 ORDER BY f.status = 'pending' DESC, f.due_at DESC`,
      [id],
    ),
    query(
      `SELECT c.*, u.full_name AS logged_by_name FROM communication_logs c LEFT JOIN users u ON u.id = c.logged_by
        WHERE c.lead_id = $1 ORDER BY c.created_at DESC`,
      [id],
    ),
  ]);
  res.json({ ...lead, history, follow_ups: followUps, communications: comms });
});

leadsRouter.patch('/:id', can('leads.write'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const body = z.object(leadFields).partial().parse(req.body);
  if (body.branchId) assertBranch(req, body.branchId);
  await tx(async (c) => {
    const before = await loadLead(c, req, id, true);
    const map: Record<string, string> = {
      fullName: 'full_name', phone: 'phone', email: 'email', gender: 'gender', branchId: 'branch_id', sourceId: 'source_id',
      referredByMemberId: 'referred_by_member_id', interestedPlanId: 'interested_plan_id', interestedService: 'interested_service',
      budget: 'budget', goal: 'goal', expectedValue: 'expected_value', assignedTo: 'assigned_to', trialAt: 'trial_at', notes: 'notes',
    };
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [k, col] of Object.entries(map)) {
      if ((body as any)[k] !== undefined) {
        params.push((body as any)[k]);
        sets.push(`${col} = $${params.length}`);
      }
    }
    if (!sets.length) return;
    const after = await one(`UPDATE leads SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, params, c);
    if (!after.phone && !after.email) throw badRequest('A lead needs a phone number or email');
    if (body.assignedTo && body.assignedTo !== before.assigned_to) {
      // Reassigning a lead hands over its open follow-ups too.
      await c.query(`UPDATE follow_ups SET assigned_to = $2 WHERE lead_id = $1 AND status = 'pending'`, [id, body.assignedTo]);
      await notify(c, { orgId: auth(req).orgId, recipientId: body.assignedTo, type: 'lead.assigned', title: `Lead assigned to you: ${after.full_name}`, entityType: 'lead', entityId: id });
    }
    await audit(c, req, {
      action: 'lead.updated', entityType: 'lead', entityId: id, branchId: after.branch_id, summary: `Lead ${after.full_name} updated`,
      before: Object.fromEntries(Object.keys(body).map((k) => [k, before[map[k]]])), after: body,
    });
  });
  res.status(204).end();
});

// ------------------------------------------------------------------ stage --

leadsRouter.post('/:id/move', can('leads.write'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const body = z
    .object({
      stage: z.enum(LEAD_STAGES).exclude(['won']),
      beforeId: uuid.optional().nullable(),
      afterId: uuid.optional().nullable(),
      lostReason: z.string().trim().min(2).optional(),
      trialAt: z.string().datetime({ offset: true }).optional(),
    })
    .parse(req.body);
  await tx(async (c) => {
    const lead = await loadLead(c, req, id, true);
    if (lead.stage === 'won') throw conflict('This lead is already a member');
    if (body.stage === 'lost' && !body.lostReason) throw badRequest('Add a reason for losing this lead');

    // Fractional ranking: place between the neighbours the card was dropped next to.
    const [before, after] = await Promise.all([
      body.beforeId ? one(`SELECT position FROM leads WHERE id = $1`, [body.beforeId], c) : null,
      body.afterId ? one(`SELECT position FROM leads WHERE id = $1`, [body.afterId], c) : null,
    ]);
    let position: number;
    if (before && after) position = (before.position + after.position) / 2;
    else if (before) position = before.position + 1;
    else if (after) position = after.position - 1;
    else position = (await one(`SELECT COALESCE(min(position), 0) - 1 AS p FROM leads WHERE branch_id = $1 AND stage = $2`, [lead.branch_id, body.stage], c))!.p;

    const stageChanged = body.stage !== lead.stage;
    await c.query(
      `UPDATE leads SET stage = $2, position = $3, lost_reason = CASE WHEN $2 = 'lost' THEN $4 ELSE NULL END,
              trial_at = COALESCE($5::timestamptz, trial_at),
              stage_changed_at = CASE WHEN $6 THEN now() ELSE stage_changed_at END, updated_at = now()
        WHERE id = $1`,
      [id, body.stage, position, body.lostReason ?? null, body.trialAt ?? null, stageChanged],
    );
    if (!stageChanged) return;
    await recordStage(c, req, id, lead.stage, body.stage);
    if (body.stage === 'lost') await cancelPendingFollowUps(c, req, { leadId: id }, 'not_interested');
    if (body.stage === 'trial_booked' && body.trialAt) {
      await c.query(
        `INSERT INTO follow_ups (organization_id, branch_id, lead_id, type, purpose, due_at, assigned_to, notes, auto_generated, created_by)
         VALUES ($1,$2,$3,'call','trial', $4::timestamptz + interval '3 hours', $5, 'Post-trial check-in', true, $6)`,
        [lead.organization_id, lead.branch_id, id, body.trialAt, lead.assigned_to ?? auth(req).userId, auth(req).userId],
      );
    }
    await audit(c, req, {
      action: 'lead.stage_changed', entityType: 'lead', entityId: id, branchId: lead.branch_id,
      summary: `${lead.full_name} moved ${STAGE_LABEL[lead.stage as LeadStage]} → ${STAGE_LABEL[body.stage]}${body.lostReason ? ` (${body.lostReason})` : ''}`,
      before: { stage: lead.stage }, after: { stage: body.stage, lost_reason: body.lostReason },
    });
  });
  res.status(204).end();
});

leadsRouter.post('/:id/reopen', can('leads.write'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  await tx(async (c) => {
    const lead = await loadLead(c, req, id, true);
    if (lead.stage !== 'lost') throw conflict('Only lost leads can be reopened');
    await c.query(`UPDATE leads SET stage = 'contacted', lost_reason = NULL, stage_changed_at = now(), updated_at = now() WHERE id = $1`, [id]);
    await recordStage(c, req, id, 'lost', 'contacted');
    await audit(c, req, { action: 'lead.reopened', entityType: 'lead', entityId: id, branchId: lead.branch_id, summary: `${lead.full_name} reopened` });
  });
  res.status(204).end();
});

// ---------------------------------------------------------------- convert --

const convertSchema = z.union([
  z.object({ existingMemberId: uuid }),
  memberCreateSchema.omit({ branchId: true, source: true }).partial({ fullName: true, phone: true }),
]);

/**
 * Lead → member. Creates (or links) the canonical member record, optionally
 * sells the first membership and collects payment, and closes the deal, all
 * in one transaction.
 */
leadsRouter.post('/:id/convert', can('leads.write', 'members.write'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const body = convertSchema.parse(req.body);
  const result = await tx(async (c) => {
    const lead = await loadLead(c, req, id, true);
    if (lead.stage === 'won') throw conflict('This lead is already converted');
    let memberId: string;
    let created: Awaited<ReturnType<typeof createMember>> | null = null;
    if ('existingMemberId' in body) {
      const m = await one(`SELECT id, branch_id FROM members WHERE id = $1 AND organization_id = $2`, [body.existingMemberId, auth(req).orgId], c);
      if (!m) throw notFound('Member');
      assertBranch(req, m.branch_id);
      memberId = m.id;
    } else {
      const source = lead.source_id ? await one(`SELECT name FROM lead_sources WHERE id = $1`, [lead.source_id], c) : null;
      const input = memberCreateSchema.parse({
        ...body,
        fullName: body.fullName ?? lead.full_name,
        phone: body.phone ?? lead.phone,
        email: body.email === undefined ? lead.email : body.email,
        gender: body.gender ?? lead.gender,
        branchId: lead.branch_id,
        source: source?.name ?? null,
        assignedStaffId: body.assignedStaffId ?? lead.assigned_to,
      });
      created = await createMember(c, req, input);
      memberId = created.member.id;
    }
    await c.query(
      `UPDATE leads SET stage = 'won', converted_member_id = $2, converted_at = now(), stage_changed_at = now(), updated_at = now() WHERE id = $1`,
      [id, memberId],
    );
    await recordStage(c, req, id, lead.stage, 'won');
    await cancelPendingFollowUps(c, req, { leadId: id }, 'converted');
    await audit(c, req, {
      action: 'lead.converted', entityType: 'lead', entityId: id, branchId: lead.branch_id,
      summary: `${lead.full_name} converted to member${created ? ` ${created.member.member_code}` : ''}`,
      before: { stage: lead.stage }, after: { stage: 'won', member_id: memberId },
    });
    return { memberId, ...(created ?? {}) };
  });
  res.status(201).json(result);
});
