import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { one, query } from '../../db/pool.js';
import { auth } from '../../lib/auth.js';
import { notFound } from '../../lib/errors.js';
import { isoDate, uuid } from '../../lib/http.js';

// ---------------------------------------------------------------- schemas --

export const workoutPlanSchema = z.object({
  name: z.string().trim().min(2).max(120),
  goal: z.string().trim().max(120).optional().nullable(),
  level: z.enum(['beginner', 'intermediate', 'advanced']).optional().nullable(),
  durationWeeks: z.coerce.number().int().min(1).max(52).optional().nullable(),
  daysPerWeek: z.coerce.number().int().min(1).max(7).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
  trainerId: uuid.optional().nullable(),
  startsOn: isoDate.optional().nullable(),
  endsOn: isoDate.optional().nullable(),
  days: z
    .array(
      z.object({
        id: uuid.optional().nullable(),
        name: z.string().trim().min(1).max(60),
        focus: z.string().trim().max(80).optional().nullable(),
        notes: z.string().trim().max(1000).optional().nullable(),
        exercises: z
          .array(
            z.object({
              exerciseId: uuid,
              sets: z.coerce.number().int().min(1).max(20),
              reps: z.string().trim().min(1).max(30),
              weight: z.string().trim().max(30).optional().nullable(),
              restSeconds: z.coerce.number().int().min(0).max(900).optional().nullable(),
              tempo: z.string().trim().max(20).optional().nullable(),
              notes: z.string().trim().max(300).optional().nullable(),
            }),
          )
          .max(30),
      }),
    )
    .min(1, 'Add at least one day')
    .max(7),
});
export type WorkoutPlanInput = z.infer<typeof workoutPlanSchema>;

export const nutritionPlanSchema = z.object({
  name: z.string().trim().min(2).max(120),
  goal: z.string().trim().max(120).optional().nullable(),
  calorieTarget: z.coerce.number().int().min(800).max(6000).optional().nullable(),
  proteinG: z.coerce.number().int().min(0).max(500).optional().nullable(),
  carbsG: z.coerce.number().int().min(0).max(900).optional().nullable(),
  fatG: z.coerce.number().int().min(0).max(400).optional().nullable(),
  waterL: z.coerce.number().min(0).max(10).optional().nullable(),
  dietType: z.enum(['vegetarian', 'eggetarian', 'non_vegetarian', 'vegan', 'jain']).optional().nullable(),
  restrictions: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  recommendations: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
  avoid: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
  notes: z.string().trim().max(2000).optional().nullable(),
  nutritionistId: uuid.optional().nullable(),
  startsOn: isoDate.optional().nullable(),
  endsOn: isoDate.optional().nullable(),
  meals: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(60),
        time: z.string().trim().max(20).optional().nullable(),
        notes: z.string().trim().max(300).optional().nullable(),
        items: z
          .array(
            z.object({
              food: z.string().trim().min(1).max(120),
              quantity: z.string().trim().max(60).optional().nullable(),
              calories: z.coerce.number().int().min(0).max(3000).optional().nullable(),
              proteinG: z.coerce.number().min(0).max(300).optional().nullable(),
              carbsG: z.coerce.number().min(0).max(500).optional().nullable(),
              fatG: z.coerce.number().min(0).max(300).optional().nullable(),
            }),
          )
          .max(20),
      }),
    )
    .max(10),
});
export type NutritionPlanInput = z.infer<typeof nutritionPlanSchema>;

// ------------------------------------------------------------- plan I/O --

export async function writeWorkoutContent(c: PoolClient, planId: string, days: WorkoutPlanInput['days']) {
  // Keep day ids stable where possible so workout logs stay linked to them.
  const existing = await query(`SELECT id FROM workout_days WHERE plan_id = $1`, [planId], c);
  const keep = new Set(days.map((d) => d.id).filter(Boolean));
  for (const d of existing) if (!keep.has(d.id)) await c.query(`DELETE FROM workout_days WHERE id = $1`, [d.id]);
  // Park day numbers out of the way so renumbering can't collide.
  await c.query(`UPDATE workout_days SET day_number = day_number + 100 WHERE plan_id = $1`, [planId]);
  for (const [i, d] of days.entries()) {
    let dayId = d.id && existing.some((e) => e.id === d.id) ? d.id : null;
    if (dayId) {
      await c.query(`UPDATE workout_days SET day_number = $2, name = $3, focus = $4, notes = $5 WHERE id = $1`, [dayId, i + 1, d.name, d.focus ?? null, d.notes ?? null]);
      await c.query(`DELETE FROM workout_exercises WHERE day_id = $1`, [dayId]);
    } else {
      dayId = (await one(`INSERT INTO workout_days (plan_id, day_number, name, focus, notes) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [planId, i + 1, d.name, d.focus ?? null, d.notes ?? null], c))!.id;
    }
    for (const [j, e] of d.exercises.entries()) {
      await c.query(
        `INSERT INTO workout_exercises (day_id, exercise_id, sort, sets, reps, weight, rest_seconds, tempo, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [dayId, e.exerciseId, j, e.sets, e.reps, e.weight ?? null, e.restSeconds ?? null, e.tempo ?? null, e.notes ?? null],
      );
    }
  }
}

export async function writeNutritionContent(c: PoolClient, planId: string, meals: NutritionPlanInput['meals']) {
  await c.query(`DELETE FROM nutrition_meals WHERE plan_id = $1`, [planId]);
  for (const [i, m] of meals.entries()) {
    const meal = await one(`INSERT INTO nutrition_meals (plan_id, sort, name, time, notes) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [planId, i, m.name, m.time ?? null, m.notes ?? null], c);
    for (const [j, it] of m.items.entries()) {
      await c.query(
        `INSERT INTO nutrition_meal_items (meal_id, sort, food, quantity, calories, protein_g, carbs_g, fat_g) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [meal!.id, j, it.food, it.quantity ?? null, it.calories ?? null, it.proteinG ?? null, it.carbsG ?? null, it.fatG ?? null],
      );
    }
  }
}

export async function loadWorkoutPlan(planId: string, db?: PoolClient) {
  const plan = await one(
    `SELECT p.*, tu.full_name AS trainer_name, u.full_name AS member_name, m.member_code, src.name AS template_name
       FROM workout_plans p LEFT JOIN users tu ON tu.id = p.trainer_id
       LEFT JOIN members m ON m.id = p.member_id LEFT JOIN users u ON u.id = m.user_id
       LEFT JOIN workout_plans src ON src.id = p.source_template_id
      WHERE p.id = $1`,
    [planId],
    db,
  );
  if (!plan) return null;
  const days = await query(`SELECT * FROM workout_days WHERE plan_id = $1 ORDER BY day_number`, [planId], db);
  const exercises = await query(
    `SELECT we.*, e.name AS exercise_name, e.category, e.muscle_group, e.equipment, e.instructions, e.video_url
       FROM workout_exercises we JOIN exercises e ON e.id = we.exercise_id
      WHERE we.day_id = ANY($1) ORDER BY we.sort`,
    [days.map((d) => d.id)],
    db,
  );
  return { ...plan, days: days.map((d) => ({ ...d, exercises: exercises.filter((e) => e.day_id === d.id) })) };
}

export async function loadNutritionPlan(planId: string, db?: PoolClient) {
  const plan = await one(
    `SELECT p.*, nu.full_name AS nutritionist_name, u.full_name AS member_name, m.member_code, src.name AS template_name
       FROM nutrition_plans p LEFT JOIN users nu ON nu.id = p.nutritionist_id
       LEFT JOIN members m ON m.id = p.member_id LEFT JOIN users u ON u.id = m.user_id
       LEFT JOIN nutrition_plans src ON src.id = p.source_template_id
      WHERE p.id = $1`,
    [planId],
    db,
  );
  if (!plan) return null;
  const meals = await query(`SELECT * FROM nutrition_meals WHERE plan_id = $1 ORDER BY sort`, [planId], db);
  const items = await query(`SELECT * FROM nutrition_meal_items WHERE meal_id = ANY($1) ORDER BY sort`, [meals.map((m) => m.id)], db);
  const withItems = meals.map((m) => {
    const its = items.filter((i) => i.meal_id === m.id);
    return { ...m, items: its, totals: totals(its) };
  });
  return { ...plan, meals: withItems, totals: totals(items) };
}

function totals(items: any[]) {
  const sum = (k: string) => Math.round(items.reduce((s, i) => s + Number(i[k] ?? 0), 0));
  return { calories: sum('calories'), protein_g: sum('protein_g'), carbs_g: sum('carbs_g'), fat_g: sum('fat_g') };
}

/** Plan rows → editor input shape, used when copying a template. */
export function workoutToInput(p: any): WorkoutPlanInput {
  return {
    name: p.name, goal: p.goal, level: p.level, durationWeeks: p.duration_weeks, daysPerWeek: p.days_per_week, notes: p.notes, trainerId: p.trainer_id,
    days: p.days.map((d: any) => ({
      name: d.name, focus: d.focus, notes: d.notes,
      exercises: d.exercises.map((e: any) => ({ exerciseId: e.exercise_id, sets: e.sets, reps: e.reps, weight: e.weight, restSeconds: e.rest_seconds, tempo: e.tempo, notes: e.notes })),
    })),
  };
}

export function nutritionToInput(p: any): NutritionPlanInput {
  return {
    name: p.name, goal: p.goal, calorieTarget: p.calorie_target, proteinG: p.protein_g, carbsG: p.carbs_g, fatG: p.fat_g, waterL: p.water_l == null ? null : Number(p.water_l),
    dietType: p.diet_type, restrictions: p.restrictions, recommendations: p.recommendations, avoid: p.avoid, notes: p.notes, nutritionistId: p.nutritionist_id,
    meals: p.meals.map((m: any) => ({
      name: m.name, time: m.time, notes: m.notes,
      items: m.items.map((i: any) => ({ food: i.food, quantity: i.quantity, calories: i.calories, proteinG: i.protein_g == null ? null : Number(i.protein_g), carbsG: i.carbs_g == null ? null : Number(i.carbs_g), fatG: i.fat_g == null ? null : Number(i.fat_g) })),
    })),
  };
}

export async function memberInScope(req: Request, memberId: string, c?: PoolClient) {
  const m = await one(
    `SELECT m.id, m.branch_id, m.gender, m.date_of_birth, u.full_name, u.id AS user_id FROM members m JOIN users u ON u.id = m.user_id
      WHERE m.id = $1 AND m.organization_id = $2`,
    [memberId, auth(req).orgId],
    c,
  );
  if (!m || !auth(req).branchIds.includes(m.branch_id)) throw notFound('Member');
  return m;
}

/** Mifflin–St Jeor resting energy, from the latest weight/height and the member's age and sex. */
export function bmr(weightKg: number | null, heightCm: number | null, dob: string | null, gender: string | null) {
  if (!weightKg || !heightCm || !dob || !gender || gender === 'other') return null;
  const age = Math.floor((Date.now() - Date.parse(`${dob}T00:00:00Z`)) / (365.25 * 86400_000));
  return Math.round(10 * Number(weightKg) + 6.25 * Number(heightCm) - 5 * age + (gender === 'male' ? 5 : -161));
}

/** Image type sniffed from the bytes themselves, not the client's claim. */
export function sniffImage(buf: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}
