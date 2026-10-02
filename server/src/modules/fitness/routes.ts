import express, { Router, type Request } from 'express';
import crypto from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../../config.js';
import { one, pool, query, tx } from '../../db/pool.js';
import { auth, branchScope, can } from '../../lib/auth.js';
import { audit, notify } from '../../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { isoDate, uuid } from '../../lib/http.js';
import {
  bmr, loadNutritionPlan, loadWorkoutPlan, memberInScope, nutritionPlanSchema, nutritionToInput, sniffImage, workoutPlanSchema, workoutToInput,
  writeNutritionContent, writeWorkoutContent, type NutritionPlanInput, type WorkoutPlanInput,
} from './service.js';

export const fitnessRouter = Router();

// ---------------------------------------------------------- exercise library --

fitnessRouter.get('/exercises', can('workouts.read'), async (req, res) => {
  const q = z.object({ search: z.string().trim().optional(), category: z.string().optional(), all: z.coerce.boolean().optional() }).parse(req.query);
  res.json(await query(
    `SELECT e.*, (SELECT count(*) FROM workout_exercises we WHERE we.exercise_id = e.id) AS used_in
       FROM exercises e
      WHERE e.organization_id = $1 AND ($2::text IS NULL OR e.name ILIKE $2 OR e.muscle_group ILIKE $2 OR e.equipment ILIKE $2)
        AND ($3::text IS NULL OR e.category = $3) AND ($4 OR e.is_active)
      ORDER BY e.category, e.name`,
    [auth(req).orgId, q.search ? `%${q.search}%` : null, q.category ?? null, !!q.all],
  ));
});

const exerciseSchema = z.object({
  name: z.string().trim().min(2).max(80),
  category: z.enum(['strength', 'cardio', 'mobility', 'core', 'plyometric', 'conditioning']),
  muscleGroup: z.string().trim().max(60).optional().nullable(),
  equipment: z.string().trim().max(60).optional().nullable(),
  instructions: z.string().trim().max(2000).optional().nullable(),
  videoUrl: z.string().trim().url().refine((u) => /^https:\/\//.test(u), 'Use an https link').optional().nullable().or(z.literal('').transform(() => null)),
  isActive: z.boolean().default(true),
});

fitnessRouter.post('/exercises', can('workouts.manage'), async (req, res) => {
  const b = exerciseSchema.parse(req.body);
  res.status(201).json(await one(
    `INSERT INTO exercises (organization_id, name, category, muscle_group, equipment, instructions, video_url, is_active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [auth(req).orgId, b.name, b.category, b.muscleGroup ?? null, b.equipment ?? null, b.instructions ?? null, b.videoUrl ?? null, b.isActive],
  ));
});

fitnessRouter.put('/exercises/:id', can('workouts.manage'), async (req, res) => {
  const b = exerciseSchema.parse(req.body);
  const row = await one(
    `UPDATE exercises SET name=$3, category=$4, muscle_group=$5, equipment=$6, instructions=$7, video_url=$8, is_active=$9 WHERE id=$1 AND organization_id=$2 RETURNING *`,
    [uuid.parse(req.params.id), auth(req).orgId, b.name, b.category, b.muscleGroup ?? null, b.equipment ?? null, b.instructions ?? null, b.videoUrl ?? null, b.isActive],
  );
  if (!row) throw notFound('Exercise');
  res.json(row);
});

// -------------------------------------------------------------- overview --

fitnessRouter.get('/overview', async (req, res) => {
  const ctx = auth(req);
  if (!['workouts.read', 'nutrition.read', 'assessments.read'].some((p) => ctx.permissions.has(p))) throw forbidden();
  const { mine } = z.object({ mine: z.coerce.boolean().optional() }).parse(req.query);
  const scope = [ctx.orgId, branchScope(req), mine ? ctx.userId : null];
  const [counts, needsPlan, assessmentsDue, endingSoon] = await Promise.all([
    one(
      `SELECT count(*) AS active_members,
              count(*) FILTER (WHERE wp.id IS NOT NULL) AS with_workout,
              count(*) FILTER (WHERE np.id IS NOT NULL) AS with_nutrition,
              count(*) FILTER (WHERE la.assessed_on IS NULL OR la.assessed_on < current_date - o.assessment_interval_days) AS assessments_due,
              (SELECT count(*) FROM workout_logs wl JOIN members mm ON mm.id = wl.member_id
                WHERE mm.organization_id = $1 AND mm.branch_id = ANY($2) AND wl.performed_on >= current_date - 13) AS logs_14d,
              COALESCE(sum(wp.days_per_week), 0) AS planned_days_per_week
         FROM members m
         JOIN organizations o ON o.id = m.organization_id
         JOIN member_current_membership cm ON cm.member_id = m.id
         LEFT JOIN member_fitness_profiles fp ON fp.member_id = m.id
         LEFT JOIN workout_plans wp ON wp.member_id = m.id AND wp.status = 'active'
         LEFT JOIN nutrition_plans np ON np.member_id = m.id AND np.status = 'active'
         LEFT JOIN LATERAL (SELECT assessed_on FROM fitness_assessments fa WHERE fa.member_id = m.id ORDER BY assessed_on DESC LIMIT 1) la ON true
        WHERE m.organization_id = $1 AND m.branch_id = ANY($2) AND cm.status IN ('active', 'expiring_soon')
          AND ($3::uuid IS NULL OR fp.assigned_trainer_id = $3 OR fp.assigned_nutritionist_id = $3 OR wp.trainer_id = $3)`,
      scope,
    ),
    query(
      `SELECT m.id, m.member_code, u.full_name, cm.plan_name, vs.visits_30d, fp.primary_goal, tu.full_name AS trainer_name
         FROM members m JOIN users u ON u.id = m.user_id
         JOIN member_current_membership cm ON cm.member_id = m.id
         JOIN member_visit_stats vs ON vs.member_id = m.id
         LEFT JOIN member_fitness_profiles fp ON fp.member_id = m.id
         LEFT JOIN users tu ON tu.id = fp.assigned_trainer_id
        WHERE m.organization_id = $1 AND m.branch_id = ANY($2) AND cm.status IN ('active', 'expiring_soon')
          AND NOT EXISTS (SELECT 1 FROM workout_plans wp WHERE wp.member_id = m.id AND wp.status = 'active')
          AND ($3::uuid IS NULL OR fp.assigned_trainer_id = $3)
        ORDER BY vs.visits_30d DESC, m.join_date DESC LIMIT 12`,
      scope,
    ),
    query(
      `SELECT m.id, m.member_code, u.full_name, la.assessed_on, cm.plan_name, tu.full_name AS trainer_name
         FROM members m JOIN users u ON u.id = m.user_id JOIN organizations o ON o.id = m.organization_id
         JOIN member_current_membership cm ON cm.member_id = m.id
         LEFT JOIN member_fitness_profiles fp ON fp.member_id = m.id LEFT JOIN users tu ON tu.id = fp.assigned_trainer_id
         LEFT JOIN LATERAL (SELECT assessed_on FROM fitness_assessments fa WHERE fa.member_id = m.id ORDER BY assessed_on DESC LIMIT 1) la ON true
        WHERE m.organization_id = $1 AND m.branch_id = ANY($2) AND cm.status IN ('active', 'expiring_soon')
          AND (la.assessed_on IS NULL OR la.assessed_on < current_date - o.assessment_interval_days)
          AND ($3::uuid IS NULL OR fp.assigned_trainer_id = $3 OR fp.assigned_nutritionist_id = $3)
        ORDER BY la.assessed_on NULLS FIRST, m.join_date LIMIT 12`,
      scope,
    ),
    query(
      `SELECT wp.id, wp.name, wp.ends_on, u.full_name, m.id AS member_id FROM workout_plans wp
         JOIN members m ON m.id = wp.member_id JOIN users u ON u.id = m.user_id
        WHERE wp.organization_id = $1 AND m.branch_id = ANY($2) AND wp.status = 'active' AND wp.ends_on <= current_date + 7
          AND ($3::uuid IS NULL OR wp.trainer_id = $3)
        ORDER BY wp.ends_on LIMIT 10`,
      scope,
    ),
  ]);
  const c = Object.fromEntries(Object.entries(counts!).map(([k, v]) => [k, Number(v)]));
  res.json({
    ...c,
    // Logged sessions vs. what active plans prescribe, over two weeks.
    adherence: c.planned_days_per_week ? Math.min(100, Math.round((c.logs_14d / (c.planned_days_per_week * 2)) * 100)) : 0,
    needsPlan, assessmentsDue, endingSoon,
  });
});

// ------------------------------------------------------- generic plan CRUD --

type Kind = 'workout' | 'nutrition';
const KIND = {
  workout: {
    table: 'workout_plans', staffCol: 'trainer_id', read: 'workouts.read', manage: 'workouts.manage', schema: workoutPlanSchema,
    load: loadWorkoutPlan, write: (c: any, id: string, b: any) => writeWorkoutContent(c, id, (b as WorkoutPlanInput).days), toInput: workoutToInput, label: 'Workout plan',
    cols: (b: WorkoutPlanInput) => ({ name: b.name, goal: b.goal ?? null, level: b.level ?? null, duration_weeks: b.durationWeeks ?? null, days_per_week: b.daysPerWeek ?? null, notes: b.notes ?? null, trainer_id: b.trainerId ?? null, starts_on: b.startsOn ?? null, ends_on: b.endsOn ?? null }),
  },
  nutrition: {
    table: 'nutrition_plans', staffCol: 'nutritionist_id', read: 'nutrition.read', manage: 'nutrition.manage', schema: nutritionPlanSchema,
    load: loadNutritionPlan, write: (c: any, id: string, b: any) => writeNutritionContent(c, id, (b as NutritionPlanInput).meals), toInput: nutritionToInput, label: 'Nutrition plan',
    cols: (b: NutritionPlanInput) => ({
      name: b.name, goal: b.goal ?? null, calorie_target: b.calorieTarget ?? null, protein_g: b.proteinG ?? null, carbs_g: b.carbsG ?? null, fat_g: b.fatG ?? null,
      water_l: b.waterL ?? null, diet_type: b.dietType ?? null, restrictions: b.restrictions, recommendations: b.recommendations, avoid: b.avoid, notes: b.notes ?? null,
      nutritionist_id: b.nutritionistId ?? null, starts_on: b.startsOn ?? null, ends_on: b.endsOn ?? null,
    }),
  },
} as const;

async function loadScoped(req: Request, kind: Kind, id: string, c?: any) {
  const p = await KIND[kind].load(id, c);
  if (!p || p.organization_id !== auth(req).orgId) throw notFound(KIND[kind].label);
  if (p.member_id && !auth(req).branchIds.includes(p.branch_id)) throw notFound(KIND[kind].label);
  return p;
}

/** Inserts a plan (template or member plan) and its content; retires the member's previous active plan. */
async function insertPlan(c: any, req: Request, kind: Kind, body: any, opts: { memberId?: string | null; sourceTemplateId?: string | null; status?: string }) {
  const k = KIND[kind];
  let branchId = null;
  if (opts.memberId) {
    const m = await memberInScope(req, opts.memberId, c);
    branchId = m.branch_id;
    if ((opts.status ?? 'active') === 'active') {
      await c.query(`UPDATE ${k.table} SET status = 'completed', updated_at = now() WHERE member_id = $1 AND status = 'active'`, [opts.memberId]);
    }
  }
  const cols = { ...k.cols(body), organization_id: auth(req).orgId, branch_id: branchId, member_id: opts.memberId ?? null, is_template: !opts.memberId,
    source_template_id: opts.sourceTemplateId ?? null, status: opts.memberId ? opts.status ?? 'active' : 'active', created_by: auth(req).userId };
  if (opts.memberId && !cols.starts_on) cols.starts_on = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  if (kind === 'workout' && opts.memberId && !cols.ends_on && (cols as any).duration_weeks && cols.starts_on) {
    const end = new Date(`${cols.starts_on}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + (cols as any).duration_weeks * 7 - 1);
    cols.ends_on = end.toISOString().slice(0, 10);
  }
  const keys = Object.keys(cols);
  const row = await one(`INSERT INTO ${k.table} (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, Object.values(cols), c);
  await k.write(c, row!.id, body);
  return row!.id as string;
}

function planRoutes(kind: Kind) {
  const r = Router();
  const k = KIND[kind];

  r.get('/', can(k.read), async (req, res) => {
    const q = z.object({ memberId: uuid.optional(), templates: z.coerce.boolean().optional(), staffId: z.string().optional(), status: z.string().optional() }).parse(req.query);
    const params: unknown[] = [auth(req).orgId];
    const where = [`p.organization_id = $1`];
    if (q.templates) where.push(`p.is_template`);
    else {
      params.push(branchScope(req));
      where.push(`NOT p.is_template AND p.branch_id = ANY($${params.length})`);
    }
    if (q.memberId) { params.push(q.memberId); where.push(`p.member_id = $${params.length}`); }
    if (q.staffId) { params.push(q.staffId === 'me' ? auth(req).userId : q.staffId); where.push(`p.${k.staffCol} = $${params.length}`); }
    if (q.status) { params.push(q.status); where.push(`p.status = $${params.length}`); }
    const extra = kind === 'workout'
      ? `, (SELECT count(*) FROM workout_days d WHERE d.plan_id = p.id) AS day_count,
           (SELECT count(*) FROM workout_logs l WHERE l.plan_id = p.id AND l.performed_on >= current_date - 13) AS logs_14d,
           (SELECT max(performed_on) FROM workout_logs l WHERE l.plan_id = p.id) AS last_logged_on,
           (SELECT count(*) FROM workout_plans c WHERE c.source_template_id = p.id AND c.status = 'active') AS active_assignments`
      : `, (SELECT count(*) FROM nutrition_meals ml WHERE ml.plan_id = p.id) AS meal_count,
           (SELECT count(*) FROM nutrition_plans c WHERE c.source_template_id = p.id AND c.status = 'active') AS active_assignments`;
    res.json(await query(
      `SELECT p.*, su.full_name AS staff_name, u.full_name AS member_name, m.member_code ${extra}
         FROM ${k.table} p LEFT JOIN users su ON su.id = p.${k.staffCol}
         LEFT JOIN members m ON m.id = p.member_id LEFT JOIN users u ON u.id = m.user_id
        WHERE ${where.join(' AND ')}
        ORDER BY p.status = 'active' DESC, p.updated_at DESC LIMIT 300`,
      params,
    ));
  });

  r.get('/:id', can(k.read), async (req, res) => {
    const plan = await loadScoped(req, kind, uuid.parse(req.params.id));
    if (kind === 'workout' && plan.member_id) {
      plan.logs = await query(
        `SELECT l.*, d.name AS day_name, u.full_name AS logged_by_name FROM workout_logs l LEFT JOIN workout_days d ON d.id = l.day_id
           LEFT JOIN users u ON u.id = l.logged_by WHERE l.plan_id = $1 ORDER BY l.performed_on DESC, l.created_at DESC LIMIT 40`,
        [plan.id],
      );
    }
    res.json(plan);
  });

  // Create a template, or a member plan from scratch.
  r.post('/', can(k.manage), async (req, res) => {
    const b = z.object({ memberId: uuid.optional().nullable(), plan: k.schema }).parse(req.body);
    const id = await tx(async (c) => {
      const planId = await insertPlan(c, req, kind, b.plan, { memberId: b.memberId });
      await audit(c, req, { action: `${kind}_plan.created`, entityType: k.table.slice(0, -1), entityId: planId, summary: `${k.label} “${b.plan.name}” created${b.memberId ? '' : ' as a template'}` });
      return planId;
    });
    res.status(201).json({ id });
  });

  r.put('/:id', can(k.manage), async (req, res) => {
    const id = uuid.parse(req.params.id);
    const b = k.schema.parse(req.body);
    await tx(async (c) => {
      const before = await loadScoped(req, kind, id, c);
      if (['completed', 'archived'].includes(before.status) && !before.is_template) throw conflict('This plan is closed. Assign a new one instead.');
      const cols = k.cols(b as any);
      const keys = Object.keys(cols);
      await c.query(
        `UPDATE ${k.table} SET ${keys.map((key, i) => `${key} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`,
        [id, ...Object.values(cols)],
      );
      await k.write(c, id, b);
      await audit(c, req, { action: `${kind}_plan.updated`, entityType: k.table.slice(0, -1), entityId: id, branchId: before.branch_id, summary: `${k.label} “${b.name}” updated${before.member_name ? ` for ${before.member_name}` : ''}` });
      if (before.member_id) {
        const m = await one(`SELECT user_id FROM members WHERE id = $1`, [before.member_id], c);
        await notify(c, { orgId: auth(req).orgId, recipientId: m!.user_id, audience: 'member', type: `${kind}_plan.updated`, title: `Your ${kind} plan was updated`, body: b.name, entityType: k.table.slice(0, -1), entityId: id });
      }
    });
    res.status(204).end();
  });

  // Copy a template (or another member's plan) onto a member.
  r.post('/:id/assign', can(k.manage), async (req, res) => {
    const id = uuid.parse(req.params.id);
    const b = z.object({ memberId: uuid, startsOn: isoDate.optional(), staffId: uuid.optional().nullable() }).parse(req.body);
    const planId = await tx(async (c) => {
      const src = await loadScoped(req, kind, id, c);
      const input = k.toInput(src) as any;
      if (b.startsOn) input.startsOn = b.startsOn;
      if (b.staffId !== undefined) input[kind === 'workout' ? 'trainerId' : 'nutritionistId'] = b.staffId;
      else if (!input[kind === 'workout' ? 'trainerId' : 'nutritionistId']) input[kind === 'workout' ? 'trainerId' : 'nutritionistId'] = auth(req).userId;
      const newId = await insertPlan(c, req, kind, input, { memberId: b.memberId, sourceTemplateId: src.is_template ? src.id : src.source_template_id });
      const m = await memberInScope(req, b.memberId, c);
      await notify(c, { orgId: auth(req).orgId, recipientId: m.user_id, audience: 'member', type: `${kind}_plan.assigned`, title: `New ${kind} plan: ${src.name}`, body: 'Open the app to see it.', entityType: k.table.slice(0, -1), entityId: newId });
      await audit(c, req, { action: `${kind}_plan.assigned`, entityType: k.table.slice(0, -1), entityId: newId, branchId: m.branch_id, summary: `${k.label} “${src.name}” assigned to ${m.full_name}` });
      return newId;
    });
    res.status(201).json({ id: planId });
  });

  r.post('/:id/save-as-template', can(k.manage), async (req, res) => {
    const id = uuid.parse(req.params.id);
    const { name } = z.object({ name: z.string().trim().min(2) }).parse(req.body);
    const newId = await tx(async (c) => {
      const src = await loadScoped(req, kind, id, c);
      return insertPlan(c, req, kind, { ...(k.toInput(src) as any), name }, {});
    });
    res.status(201).json({ id: newId });
  });

  r.post('/:id/status', can(k.manage), async (req, res) => {
    const id = uuid.parse(req.params.id);
    const { status } = z.object({ status: z.enum(['active', 'completed', 'archived', 'draft']) }).parse(req.body);
    await tx(async (c) => {
      const p = await loadScoped(req, kind, id, c);
      if (status === 'active' && p.member_id) {
        await c.query(`UPDATE ${k.table} SET status = 'completed' WHERE member_id = $1 AND status = 'active' AND id <> $2`, [p.member_id, id]);
      }
      await c.query(`UPDATE ${k.table} SET status = $2, updated_at = now() WHERE id = $1`, [id, status]);
    });
    res.status(204).end();
  });
  return r;
}

fitnessRouter.use('/workout-plans', planRoutes('workout'));
fitnessRouter.use('/nutrition-plans', planRoutes('nutrition'));

// Trainer logs a session on the member's behalf (members log from the app).
fitnessRouter.post('/workout-plans/:id/logs', can('workouts.manage'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const b = z.object({ dayId: uuid.optional().nullable(), performedOn: isoDate.optional(), durationMin: z.coerce.number().int().min(1).max(300).optional().nullable(), rpe: z.coerce.number().int().min(1).max(10).optional().nullable(), notes: z.string().trim().max(1000).optional().nullable() }).parse(req.body);
  const plan = await loadScoped(req, 'workout', id);
  if (!plan.member_id) throw badRequest('Templates have no logs');
  const row = await one(
    `INSERT INTO workout_logs (organization_id, plan_id, day_id, member_id, performed_on, duration_min, rpe, notes, source, logged_by)
     VALUES ($1,$2,$3,$4,COALESCE($5::date, current_date),$6,$7,$8,'crm',$9) RETURNING *`,
    [auth(req).orgId, id, b.dayId ?? null, plan.member_id, b.performedOn ?? null, b.durationMin ?? null, b.rpe ?? null, b.notes ?? null, auth(req).userId],
  );
  res.status(201).json(row);
});

// ------------------------------------------------------- fitness profile --

const profileSchema = z.object({
  primaryGoal: z.enum(['fat_loss', 'muscle_gain', 'strength', 'general_fitness', 'endurance', 'mobility', 'rehab', 'sport']).optional().nullable(),
  targetWeightKg: z.coerce.number().min(20).max(350).optional().nullable(),
  experienceLevel: z.enum(['beginner', 'intermediate', 'advanced']).optional().nullable(),
  trainingDaysPerWeek: z.coerce.number().int().min(1).max(7).optional().nullable(),
  injuries: z.string().trim().max(1000).optional().nullable(),
  medicalNotes: z.string().trim().max(1000).optional().nullable(),
  dietaryPreference: z.enum(['vegetarian', 'eggetarian', 'non_vegetarian', 'vegan', 'jain']).optional().nullable(),
  assignedTrainerId: uuid.optional().nullable(),
  assignedNutritionistId: uuid.optional().nullable(),
});

fitnessRouter.get('/members/:id/summary', can('assessments.read'), async (req, res) => {
  const m = await memberInScope(req, uuid.parse(req.params.id));
  const [profile, assessments, workout, nutrition, logs, photos] = await Promise.all([
    one(
      `SELECT fp.*, tu.full_name AS trainer_name, nu.full_name AS nutritionist_name FROM member_fitness_profiles fp
         LEFT JOIN users tu ON tu.id = fp.assigned_trainer_id LEFT JOIN users nu ON nu.id = fp.assigned_nutritionist_id WHERE fp.member_id = $1`,
      [m.id],
    ),
    query(`SELECT a.*, u.full_name AS assessed_by_name FROM fitness_assessments a LEFT JOIN users u ON u.id = a.assessed_by WHERE a.member_id = $1 ORDER BY a.assessed_on DESC`, [m.id]),
    one(`SELECT id, name, days_per_week, starts_on, ends_on FROM workout_plans WHERE member_id = $1 AND status = 'active'`, [m.id]),
    one(`SELECT id, name, calorie_target, protein_g FROM nutrition_plans WHERE member_id = $1 AND status = 'active'`, [m.id]),
    one(`SELECT count(*) FILTER (WHERE performed_on >= current_date - 27) AS last_28, max(performed_on) AS last_on FROM workout_logs WHERE member_id = $1`, [m.id]),
    query(`SELECT id, taken_on, angle, assessment_id, created_at FROM progress_photos WHERE member_id = $1 ORDER BY taken_on DESC, created_at DESC`, [m.id]),
  ]);
  const latest = assessments[0];
  const withHeight = assessments.find((a) => a.height_cm);
  res.json({
    profile,
    assessments,
    latest: latest ? { ...latest, bmr: bmr(latest.weight_kg, latest.height_cm ?? withHeight?.height_cm, m.date_of_birth, m.gender) } : null,
    first: assessments.at(-1) ?? null,
    workout,
    nutrition,
    logs: { last28: Number(logs!.last_28), lastOn: logs!.last_on },
    photos,
  });
});

fitnessRouter.put('/members/:id/profile', async (req, res) => {
  const ctx = auth(req);
  if (!['assessments.manage', 'workouts.manage', 'nutrition.manage'].some((p) => ctx.permissions.has(p))) throw forbidden();
  const m = await memberInScope(req, uuid.parse(req.params.id));
  const b = profileSchema.parse(req.body);
  await tx(async (c) => {
    await c.query(
      `INSERT INTO member_fitness_profiles (member_id, primary_goal, target_weight_kg, experience_level, training_days_per_week, injuries, medical_notes,
                                            dietary_preference, assigned_trainer_id, assigned_nutritionist_id, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (member_id) DO UPDATE SET primary_goal = EXCLUDED.primary_goal, target_weight_kg = EXCLUDED.target_weight_kg,
         experience_level = EXCLUDED.experience_level, training_days_per_week = EXCLUDED.training_days_per_week, injuries = EXCLUDED.injuries,
         medical_notes = EXCLUDED.medical_notes, dietary_preference = EXCLUDED.dietary_preference, assigned_trainer_id = EXCLUDED.assigned_trainer_id,
         assigned_nutritionist_id = EXCLUDED.assigned_nutritionist_id, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [m.id, b.primaryGoal ?? null, b.targetWeightKg ?? null, b.experienceLevel ?? null, b.trainingDaysPerWeek ?? null, b.injuries ?? null, b.medicalNotes ?? null,
        b.dietaryPreference ?? null, b.assignedTrainerId ?? null, b.assignedNutritionistId ?? null, ctx.userId],
    );
    await audit(c, req, { action: 'fitness_profile.updated', entityType: 'member', entityId: m.id, branchId: m.branch_id, summary: `${m.full_name}'s fitness profile updated`, after: b });
  });
  res.status(204).end();
});

// ------------------------------------------------------------ assessments --

const assessmentSchema = z.object({
  memberId: uuid,
  appointmentId: uuid.optional().nullable(),
  assessedOn: isoDate.optional(),
  weightKg: z.coerce.number().min(20).max(350).optional().nullable(),
  heightCm: z.coerce.number().min(100).max(250).optional().nullable(),
  bodyFatPct: z.coerce.number().min(2).max(70).optional().nullable(),
  muscleMassKg: z.coerce.number().min(5).max(150).optional().nullable(),
  visceralFat: z.coerce.number().int().min(1).max(60).optional().nullable(),
  restingHr: z.coerce.number().int().min(30).max(200).optional().nullable(),
  bpSystolic: z.coerce.number().int().min(60).max(250).optional().nullable(),
  bpDiastolic: z.coerce.number().int().min(30).max(160).optional().nullable(),
  chestCm: z.coerce.number().min(30).max(250).optional().nullable(),
  waistCm: z.coerce.number().min(30).max(250).optional().nullable(),
  hipsCm: z.coerce.number().min(30).max(250).optional().nullable(),
  armCm: z.coerce.number().min(10).max(80).optional().nullable(),
  thighCm: z.coerce.number().min(20).max(120).optional().nullable(),
  pushups: z.coerce.number().int().min(0).max(300).optional().nullable(),
  plankSeconds: z.coerce.number().int().min(0).max(3600).optional().nullable(),
  squats1min: z.coerce.number().int().min(0).max(200).optional().nullable(),
  sitReachCm: z.coerce.number().min(-40).max(60).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
});
const ASSESS_COLS: Record<string, string> = {
  weightKg: 'weight_kg', heightCm: 'height_cm', bodyFatPct: 'body_fat_pct', muscleMassKg: 'muscle_mass_kg', visceralFat: 'visceral_fat', restingHr: 'resting_hr',
  bpSystolic: 'bp_systolic', bpDiastolic: 'bp_diastolic', chestCm: 'chest_cm', waistCm: 'waist_cm', hipsCm: 'hips_cm', armCm: 'arm_cm', thighCm: 'thigh_cm',
  pushups: 'pushups', plankSeconds: 'plank_seconds', squats1min: 'squats_1min', sitReachCm: 'sit_reach_cm', notes: 'notes',
};

fitnessRouter.get('/assessments', can('assessments.read'), async (req, res) => {
  const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(60), mine: z.coerce.boolean().optional() }).parse(req.query);
  res.json(await query(
    `SELECT a.id, a.member_id, a.assessed_on, a.weight_kg, a.body_fat_pct, a.bmi, a.waist_cm, u.full_name AS member_name, m.member_code, su.full_name AS assessed_by_name,
            prev.weight_kg AS prev_weight_kg, prev.body_fat_pct AS prev_body_fat_pct
       FROM fitness_assessments a JOIN members m ON m.id = a.member_id JOIN users u ON u.id = m.user_id LEFT JOIN users su ON su.id = a.assessed_by
       LEFT JOIN LATERAL (SELECT weight_kg, body_fat_pct FROM fitness_assessments p WHERE p.member_id = a.member_id AND p.assessed_on < a.assessed_on ORDER BY assessed_on DESC LIMIT 1) prev ON true
      WHERE a.organization_id = $1 AND a.branch_id = ANY($2) AND ($3::uuid IS NULL OR a.assessed_by = $3)
      ORDER BY a.assessed_on DESC, a.created_at DESC LIMIT $4`,
    [auth(req).orgId, branchScope(req), q.mine ? auth(req).userId : null, q.limit],
  ));
});

fitnessRouter.post('/assessments', can('assessments.manage'), async (req, res) => {
  const b = assessmentSchema.parse(req.body);
  const row = await tx(async (c) => {
    const m = await memberInScope(req, b.memberId, c);
    const keys = Object.keys(ASSESS_COLS).filter((k) => (b as any)[k] !== undefined && (b as any)[k] !== null);
    if (!keys.some((k) => k !== 'notes')) throw badRequest('Record at least one measurement');
    // Height rarely changes: carry the last known value forward so BMI is always available.
    let height = b.heightCm;
    if (!height) height = (await one(`SELECT height_cm FROM fitness_assessments WHERE member_id = $1 AND height_cm IS NOT NULL ORDER BY assessed_on DESC LIMIT 1`, [m.id], c))?.height_cm ?? null;
    const cols = ['organization_id', 'branch_id', 'member_id', 'appointment_id', 'assessed_on', 'assessed_by', 'height_cm', ...keys.filter((k) => k !== 'heightCm').map((k) => ASSESS_COLS[k])];
    const vals = [auth(req).orgId, m.branch_id, m.id, b.appointmentId ?? null, b.assessedOn ?? new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }), auth(req).userId, height, ...keys.filter((k) => k !== 'heightCm').map((k) => (b as any)[k])];
    const a = await one(`INSERT INTO fitness_assessments (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, vals, c);
    if (b.appointmentId) {
      await c.query(`UPDATE appointments SET status = 'completed', updated_at = now() WHERE id = $1 AND status = 'scheduled' AND member_id = $2`, [b.appointmentId, m.id]);
    }
    await notify(c, { orgId: auth(req).orgId, recipientId: m.user_id, audience: 'member', type: 'assessment.recorded', title: 'New fitness assessment', body: 'See your progress in the app.', entityType: 'fitness_assessment', entityId: a!.id });
    await audit(c, req, { action: 'assessment.recorded', entityType: 'fitness_assessment', entityId: a!.id, branchId: m.branch_id, summary: `Fitness assessment recorded for ${m.full_name}${a!.weight_kg ? ` · ${a!.weight_kg} kg` : ''}` });
    return a;
  });
  res.status(201).json(row);
});

fitnessRouter.put('/assessments/:id', can('assessments.manage'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const b = assessmentSchema.omit({ memberId: true, appointmentId: true }).parse(req.body);
  await tx(async (c) => {
    const a = await one(`SELECT * FROM fitness_assessments WHERE id = $1 AND organization_id = $2 FOR UPDATE`, [id, auth(req).orgId], c);
    if (!a || !auth(req).branchIds.includes(a.branch_id)) throw notFound('Assessment');
    const keys = Object.keys(ASSESS_COLS);
    await c.query(
      `UPDATE fitness_assessments SET assessed_on = COALESCE($2, assessed_on), ${keys.map((k, i) => `${ASSESS_COLS[k]} = $${i + 3}`).join(', ')}, updated_at = now() WHERE id = $1`,
      [id, b.assessedOn ?? null, ...keys.map((k) => (b as any)[k] ?? null)],
    );
    await audit(c, req, { action: 'assessment.updated', entityType: 'fitness_assessment', entityId: id, branchId: a.branch_id, summary: `Assessment of ${a.assessed_on} corrected`, before: Object.fromEntries(keys.map((k) => [k, a[ASSESS_COLS[k]]])), after: b });
  });
  res.status(204).end();
});

// --------------------------------------------------------- progress photos --

const MAX_PHOTO = 6 * 1024 * 1024;
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export async function storePhoto(req: Request, memberId: string, body: Buffer, meta: { angle: string; takenOn?: string; assessmentId?: string | null }, source: 'crm' | 'app') {
  if (!Buffer.isBuffer(body) || body.length === 0) throw badRequest('Attach a photo');
  if (body.length > MAX_PHOTO) throw badRequest('Photos must be under 6 MB');
  const type = sniffImage(body);
  if (!type) throw badRequest('Only JPEG, PNG or WebP photos are accepted');
  const key = `${crypto.randomUUID()}.${EXT[type]}`;
  const dir = path.join(config.uploadDir, 'progress');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, key), body, { mode: 0o600 });
  try {
    return await one(
      `INSERT INTO progress_photos (organization_id, member_id, assessment_id, taken_on, angle, storage_key, content_type, size_bytes, uploaded_by, source)
       VALUES ($1,$2,$3,COALESCE($4::date, current_date),$5,$6,$7,$8,$9,$10) RETURNING id, taken_on, angle, assessment_id, created_at`,
      [auth(req).orgId, memberId, meta.assessmentId ?? null, meta.takenOn ?? null, meta.angle, key, type, body.length, auth(req).userId, source],
    );
  } catch (err) {
    await unlink(path.join(dir, key)).catch(() => {});
    throw err;
  }
}

export async function sendPhoto(res: express.Response, photo: { storage_key: string; content_type: string }) {
  // Storage keys are server-generated UUIDs; never a client-supplied path.
  const file = await readFile(path.join(config.uploadDir, 'progress', path.basename(photo.storage_key))).catch(() => null);
  if (!file) throw notFound('Photo');
  res.setHeader('Content-Type', photo.content_type);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(file);
}

const photoMeta = z.object({ angle: z.enum(['front', 'side', 'back', 'other']).default('front'), takenOn: isoDate.optional(), assessmentId: uuid.optional() });
export const rawImage = express.raw({ type: ['image/jpeg', 'image/png', 'image/webp', 'application/octet-stream'], limit: MAX_PHOTO + 1024 });

fitnessRouter.post('/members/:id/photos', can('assessments.manage'), rawImage, async (req, res) => {
  const m = await memberInScope(req, uuid.parse(req.params.id));
  const meta = photoMeta.parse(req.query);
  const row = await storePhoto(req, m.id, req.body, meta, 'crm');
  await audit(pool, req, { action: 'photo.uploaded', entityType: 'member', entityId: m.id, branchId: m.branch_id, summary: `Progress photo (${meta.angle}) added for ${m.full_name}` });
  res.status(201).json(row);
});

fitnessRouter.get('/photos/:id', can('assessments.read'), async (req, res) => {
  const p = await one(
    `SELECT p.*, m.branch_id FROM progress_photos p JOIN members m ON m.id = p.member_id WHERE p.id = $1 AND p.organization_id = $2`,
    [uuid.parse(req.params.id), auth(req).orgId],
  );
  if (!p || !auth(req).branchIds.includes(p.branch_id)) throw notFound('Photo');
  await sendPhoto(res, p);
});

fitnessRouter.delete('/photos/:id', can('assessments.manage'), async (req, res) => {
  const p = await one(
    `SELECT p.*, m.branch_id FROM progress_photos p JOIN members m ON m.id = p.member_id WHERE p.id = $1 AND p.organization_id = $2`,
    [uuid.parse(req.params.id), auth(req).orgId],
  );
  if (!p || !auth(req).branchIds.includes(p.branch_id)) throw notFound('Photo');
  await tx(async (c) => {
    await c.query(`DELETE FROM progress_photos WHERE id = $1`, [p.id]);
    await audit(c, req, { action: 'photo.deleted', entityType: 'member', entityId: p.member_id, branchId: p.branch_id, summary: `Progress photo from ${p.taken_on} deleted` });
  });
  await unlink(path.join(config.uploadDir, 'progress', path.basename(p.storage_key))).catch(() => {});
  res.status(204).end();
});
