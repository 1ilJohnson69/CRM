import { Router } from 'express';
import { z } from 'zod';
import { one, pool, query, tx } from '../../db/pool.js';
import { auth, branchScope, can } from '../../lib/auth.js';
import { audit } from '../../lib/audit.js';
import { conflict, notFound } from '../../lib/errors.js';
import { paginationSchema, paged, uuid } from '../../lib/http.js';

const STATUSES = ['active', 'expiring_soon', 'expired', 'frozen', 'cancelled', 'pending', 'none'] as const;

// Every rule is typed and compiled to parameterised SQL — users build
// segments from this vocabulary, never from raw SQL.
export const segmentRules = z
  .object({
    statuses: z.array(z.enum(STATUSES)).optional(),
    planIds: z.array(uuid).optional(),
    branchIds: z.array(uuid).optional(),
    expiresWithinDays: z.number().int().min(0).max(365).optional(),
    expiredWithinDays: z.number().int().min(1).max(3650).optional(),
    joinedWithinDays: z.number().int().min(1).max(3650).optional(),
    lifetimeValueMin: z.number().min(0).optional(),
    lifetimeValueMax: z.number().min(0).optional(),
    hasOutstanding: z.boolean().optional(),
    hasPersonalTraining: z.boolean().optional(),
    hasClassAccess: z.boolean().optional(),
    referredSomeone: z.boolean().optional(),
    noContactDays: z.number().int().min(1).max(3650).optional(),
    genders: z.array(z.enum(['male', 'female', 'other'])).optional(),
    sources: z.array(z.string().trim().min(1)).optional(),
    ageMin: z.number().int().min(0).max(120).optional(),
    ageMax: z.number().int().min(0).max(120).optional(),
    birthdayThisMonth: z.boolean().optional(),
  })
  .strict();
export type SegmentRules = z.infer<typeof segmentRules>;

/**
 * Appends WHERE fragments for a rule set. Expects aliases m (members),
 * cm (member_current_membership) and bal (member_balances) in the query.
 */
export function compileRules(rules: SegmentRules, params: unknown[]): string[] {
  const where: string[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (rules.statuses?.length) where.push(`cm.status = ANY(${p(rules.statuses)})`);
  if (rules.planIds?.length) where.push(`cm.plan_id = ANY(${p(rules.planIds)})`);
  if (rules.branchIds?.length) where.push(`m.branch_id = ANY(${p(rules.branchIds)})`);
  if (rules.expiresWithinDays !== undefined) {
    where.push(`cm.status IN ('active','expiring_soon') AND NOT cm.has_upcoming AND cm.end_date BETWEEN current_date AND current_date + ${p(rules.expiresWithinDays)}::int`);
  }
  if (rules.expiredWithinDays !== undefined) where.push(`cm.status = 'expired' AND cm.end_date >= current_date - ${p(rules.expiredWithinDays)}::int`);
  if (rules.joinedWithinDays !== undefined) where.push(`m.join_date >= current_date - ${p(rules.joinedWithinDays)}::int`);
  if (rules.lifetimeValueMin !== undefined) where.push(`bal.lifetime_value >= ${p(rules.lifetimeValueMin)}`);
  if (rules.lifetimeValueMax !== undefined) where.push(`bal.lifetime_value <= ${p(rules.lifetimeValueMax)}`);
  if (rules.hasOutstanding !== undefined) where.push(rules.hasOutstanding ? `bal.outstanding > 0` : `bal.outstanding = 0`);
  if (rules.hasPersonalTraining !== undefined) {
    where.push(`${rules.hasPersonalTraining ? '' : 'NOT '}(EXISTS (
      SELECT 1 FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
       WHERE i.member_id = m.id AND ii.item_type = 'pt' AND i.status <> 'void' AND i.issue_date >= current_date - 365)
      OR EXISTS (SELECT 1 FROM membership_plans mp WHERE mp.id = cm.plan_id AND mp.pt_access AND cm.status IN ('active','expiring_soon','frozen')))`);
  }
  if (rules.hasClassAccess !== undefined) {
    where.push(`${rules.hasClassAccess ? '' : 'NOT '}EXISTS (SELECT 1 FROM membership_plans mp WHERE mp.id = cm.plan_id AND mp.class_access AND cm.status IN ('active','expiring_soon','frozen'))`);
  }
  if (rules.referredSomeone !== undefined) {
    where.push(`${rules.referredSomeone ? '' : 'NOT '}EXISTS (SELECT 1 FROM leads rl WHERE rl.referred_by_member_id = m.id AND rl.stage = 'won')`);
  }
  if (rules.noContactDays !== undefined) {
    where.push(`NOT EXISTS (SELECT 1 FROM communication_logs cl WHERE cl.member_id = m.id AND cl.created_at >= now() - make_interval(days => ${p(rules.noContactDays)}::int))`);
  }
  if (rules.genders?.length) where.push(`m.gender = ANY(${p(rules.genders)})`);
  if (rules.sources?.length) where.push(`m.source = ANY(${p(rules.sources)})`);
  if (rules.ageMin !== undefined) where.push(`m.date_of_birth <= current_date - make_interval(years => ${p(rules.ageMin)}::int)`);
  if (rules.ageMax !== undefined) where.push(`m.date_of_birth > current_date - make_interval(years => ${p(rules.ageMax)}::int + 1)`);
  if (rules.birthdayThisMonth) where.push(`extract(month FROM m.date_of_birth) = extract(month FROM current_date)`);
  return where;
}

/** Shared FROM clause for anything that filters members by segment rules. */
export const SEGMENT_FROM = `
  FROM members m
  JOIN users u ON u.id = m.user_id
  JOIN branches b ON b.id = m.branch_id
  JOIN member_current_membership cm ON cm.member_id = m.id
  JOIN member_balances bal ON bal.member_id = m.id`;

export const segmentsRouter = Router();

async function run(req: Parameters<typeof auth>[0], rules: SegmentRules, page: number, pageSize: number) {
  const params: unknown[] = [auth(req).orgId, branchScope(req)];
  const where = [`m.organization_id = $1`, `m.branch_id = ANY($2)`, ...compileRules(rules, params)];
  params.push(pageSize, (page - 1) * pageSize);
  const rows = await query(
    `SELECT m.id, m.member_code, u.full_name, u.phone, u.email, b.name AS branch_name, cm.plan_name, cm.status, cm.end_date, cm.days_remaining,
            bal.outstanding, bal.lifetime_value, m.join_date, count(*) OVER() AS total_count
     ${SEGMENT_FROM}
     WHERE ${where.join(' AND ')}
     ORDER BY bal.lifetime_value DESC, u.full_name
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return paged(rows, page, pageSize);
}

segmentsRouter.get('/', can('members.read'), async (req, res) => {
  const segments = await query(`SELECT * FROM segments WHERE organization_id = $1 ORDER BY is_system DESC, name`, [auth(req).orgId]);
  // Counts are live; segments are definitions, not snapshots.
  const withCounts = await Promise.all(
    segments.map(async (s) => {
      const params: unknown[] = [auth(req).orgId, branchScope(req)];
      const where = [`m.organization_id = $1`, `m.branch_id = ANY($2)`, ...compileRules(segmentRules.parse(s.rules), params)];
      const r = await one(`SELECT count(*) AS n, COALESCE(sum(bal.outstanding), 0) AS outstanding ${SEGMENT_FROM} WHERE ${where.join(' AND ')}`, params);
      return { ...s, member_count: Number(r!.n), outstanding: r!.outstanding };
    }),
  );
  res.json(withCounts);
});

segmentsRouter.post('/preview', can('members.read'), async (req, res) => {
  const { rules } = z.object({ rules: segmentRules }).parse(req.body);
  res.json(await run(req, rules, 1, 8));
});

segmentsRouter.get('/:id/members', can('members.read'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const q = paginationSchema.parse(req.query);
  const s = await one(`SELECT * FROM segments WHERE id = $1 AND organization_id = $2`, [id, auth(req).orgId]);
  if (!s) throw notFound('Segment');
  res.json({ segment: s, ...(await run(req, segmentRules.parse(s.rules), q.page, q.pageSize)) });
});

segmentsRouter.get('/:id/export', can('members.read'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const s = await one(`SELECT * FROM segments WHERE id = $1 AND organization_id = $2`, [id, auth(req).orgId]);
  if (!s) throw notFound('Segment');
  const result = await run(req, segmentRules.parse(s.rules), 1, 100_000);
  const cols = ['member_code', 'full_name', 'phone', 'email', 'branch_name', 'plan_name', 'status', 'end_date', 'outstanding', 'lifetime_value', 'join_date'];
  // Prefix formula-like values so spreadsheets never execute them.
  const cell = (v: unknown) => {
    let t = v === null || v === undefined ? '' : String(v);
    if (/^[=@]|^[+\-](?!\d)/.test(t)) t = `'${t}`;
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const csv = [cols.join(','), ...result.data.map((r: any) => cols.map((c) => cell(r[c])).join(','))].join('\n');
  await audit(pool, req, { action: 'segment.exported', entityType: 'segment', entityId: id, summary: `Segment “${s.name}” exported (${result.data.length} members)` });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${s.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.csv"`);
  res.send(csv);
});

const segmentSchema = z.object({ name: z.string().trim().min(2).max(80), description: z.string().trim().max(300).optional().nullable(), rules: segmentRules });

segmentsRouter.post('/', can('segments.manage'), async (req, res) => {
  const b = segmentSchema.parse(req.body);
  const row = await tx(async (c) => {
    const s = await one(
      `INSERT INTO segments (organization_id, name, description, rules, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [auth(req).orgId, b.name, b.description ?? null, JSON.stringify(b.rules), auth(req).userId],
      c,
    );
    await audit(c, req, { action: 'segment.created', entityType: 'segment', entityId: s.id, summary: `Segment “${b.name}” created`, after: b.rules });
    return s;
  });
  res.status(201).json(row);
});

segmentsRouter.put('/:id', can('segments.manage'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const b = segmentSchema.parse(req.body);
  await tx(async (c) => {
    const before = await one(`SELECT * FROM segments WHERE id = $1 AND organization_id = $2`, [id, auth(req).orgId], c);
    if (!before) throw notFound('Segment');
    if (before.is_system) throw conflict('Built-in segments can’t be edited. Duplicate it instead.');
    await c.query(`UPDATE segments SET name=$2, description=$3, rules=$4, updated_at=now() WHERE id=$1`, [id, b.name, b.description ?? null, JSON.stringify(b.rules)]);
    await audit(c, req, { action: 'segment.updated', entityType: 'segment', entityId: id, summary: `Segment “${b.name}” updated`, before: before.rules, after: b.rules });
  });
  res.status(204).end();
});

segmentsRouter.delete('/:id', can('segments.manage'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  await tx(async (c) => {
    const s = await one(`SELECT * FROM segments WHERE id = $1 AND organization_id = $2`, [id, auth(req).orgId], c);
    if (!s) throw notFound('Segment');
    if (s.is_system) throw conflict('Built-in segments can’t be deleted');
    await c.query(`DELETE FROM segments WHERE id = $1`, [id]);
    await audit(c, req, { action: 'segment.deleted', entityType: 'segment', entityId: id, summary: `Segment “${s.name}” deleted`, before: s.rules });
  });
  res.status(204).end();
});
