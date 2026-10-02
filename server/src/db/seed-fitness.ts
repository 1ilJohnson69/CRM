import { one, tx } from './pool.js';
import { addToDate, today } from '../lib/http.js';
import { writeNutritionContent, writeWorkoutContent } from '../modules/fitness/service.js';

let s = 20264004;
const rand = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
const round1 = (n: number) => Math.round(n * 10) / 10;

const EXERCISES: [string, string, string, string, string][] = [
  ['Barbell Back Squat', 'strength', 'Quads, glutes', 'Barbell', 'Brace, sit between the hips, knees track over toes, drive up through mid-foot.'],
  ['Front Squat', 'strength', 'Quads, core', 'Barbell', 'Elbows high, upright torso, full depth.'],
  ['Goblet Squat', 'strength', 'Quads, glutes', 'Dumbbell', 'Hold the bell at chest, elbows inside knees at the bottom.'],
  ['Romanian Deadlift', 'strength', 'Hamstrings, glutes', 'Barbell', 'Soft knees, hinge at hips, bar stays close to legs.'],
  ['Conventional Deadlift', 'strength', 'Posterior chain', 'Barbell', 'Bar over mid-foot, lats tight, push the floor away.'],
  ['Walking Lunge', 'strength', 'Quads, glutes', 'Dumbbells', 'Long stride, back knee kisses the floor.'],
  ['Bulgarian Split Squat', 'strength', 'Quads, glutes', 'Dumbbells', 'Rear foot on bench, torso slightly forward.'],
  ['Leg Press', 'strength', 'Quads', 'Machine', 'Lower until hips start to tuck, press without locking out.'],
  ['Hip Thrust', 'strength', 'Glutes', 'Barbell', 'Chin tucked, ribs down, squeeze at the top.'],
  ['Leg Curl', 'strength', 'Hamstrings', 'Machine', 'Control the eccentric.'],
  ['Standing Calf Raise', 'strength', 'Calves', 'Machine', 'Full stretch at the bottom, pause at the top.'],
  ['Barbell Bench Press', 'strength', 'Chest, triceps', 'Barbell', 'Shoulder blades pinned, bar to lower chest, feet planted.'],
  ['Incline Dumbbell Press', 'strength', 'Upper chest', 'Dumbbells', '30° bench, elbows ~45°.'],
  ['Push-up', 'strength', 'Chest, triceps', 'Bodyweight', 'Plank position, chest to floor.'],
  ['Overhead Press', 'strength', 'Shoulders', 'Barbell', 'Squeeze glutes, press in a straight line, head through.'],
  ['Lateral Raise', 'strength', 'Side delts', 'Dumbbells', 'Lead with elbows, stop at shoulder height.'],
  ['Cable Fly', 'strength', 'Chest', 'Cable', 'Slight elbow bend, hug a tree.'],
  ['Triceps Rope Pushdown', 'strength', 'Triceps', 'Cable', 'Elbows pinned, split the rope at the bottom.'],
  ['Pull-up', 'strength', 'Lats, biceps', 'Bodyweight', 'Dead hang to chin over bar.'],
  ['Lat Pulldown', 'strength', 'Lats', 'Cable', 'Pull to upper chest, chest proud.'],
  ['Barbell Row', 'strength', 'Upper back', 'Barbell', 'Hinge to ~45°, row to the belly button.'],
  ['Seated Cable Row', 'strength', 'Mid back', 'Cable', 'Squeeze shoulder blades, no torso swing.'],
  ['Single-arm Dumbbell Row', 'strength', 'Lats', 'Dumbbell', 'Brace on bench, row to the hip.'],
  ['Face Pull', 'strength', 'Rear delts', 'Cable', 'Rope to forehead, thumbs back.'],
  ['Dumbbell Curl', 'strength', 'Biceps', 'Dumbbells', 'No swinging, full range.'],
  ['Plank', 'core', 'Core', 'Bodyweight', 'Straight line head to heels, squeeze glutes.'],
  ['Dead Bug', 'core', 'Core', 'Bodyweight', 'Lower back glued to the floor.'],
  ['Hanging Knee Raise', 'core', 'Abs', 'Pull-up bar', 'Curl the pelvis up, no swinging.'],
  ['Pallof Press', 'core', 'Obliques', 'Cable', 'Resist the rotation.'],
  ['Russian Twist', 'core', 'Obliques', 'Plate', 'Rotate from the ribs.'],
  ['Kettlebell Swing', 'conditioning', 'Posterior chain', 'Kettlebell', 'Hip hinge, snap the hips, arms are ropes.'],
  ['Burpee', 'conditioning', 'Full body', 'Bodyweight', 'Chest to floor, jump and clap overhead.'],
  ['Battle Ropes', 'conditioning', 'Full body', 'Ropes', 'Alternate waves, stay low.'],
  ['Box Jump', 'plyometric', 'Legs', 'Box', 'Land soft, step down.'],
  ['Jump Squat', 'plyometric', 'Legs', 'Bodyweight', 'Explode up, land quietly.'],
  ['Rowing Machine', 'cardio', 'Full body', 'Rower', 'Legs, then body, then arms.'],
  ['Treadmill Intervals', 'cardio', 'Cardio', 'Treadmill', '1 min fast / 1 min easy.'],
  ['Assault Bike', 'cardio', 'Full body', 'Air bike', 'Push and pull.'],
  ['Incline Walk', 'cardio', 'Cardio', 'Treadmill', '10–12% incline, brisk pace.'],
  ['Hip 90/90', 'mobility', 'Hips', 'Bodyweight', 'Tall spine, rotate between sides.'],
  ['Cat-Cow', 'mobility', 'Spine', 'Bodyweight', 'Move one vertebra at a time.'],
  ['World’s Greatest Stretch', 'mobility', 'Full body', 'Bodyweight', 'Lunge, elbow to instep, rotate open.'],
  ['Thoracic Rotation', 'mobility', 'Upper back', 'Bodyweight', 'Side-lying book openers.'],
  ['Couch Stretch', 'mobility', 'Hip flexors', 'Bodyweight', 'Squeeze the glute of the back leg.'],
];

type Ex = [string, number, string, string | null, number];
const WORKOUT_TEMPLATES: { name: string; goal: string; level: string; weeks: number; days: [string, string, Ex[]][] }[] = [
  {
    name: 'Foundations · Full Body 3×', goal: 'General fitness', level: 'beginner', weeks: 8,
    days: [
      ['Full Body A', 'Squat + push', [['Goblet Squat', 3, '10-12', '12 kg', 90], ['Push-up', 3, '8-10', null, 60], ['Lat Pulldown', 3, '10-12', '35 kg', 60], ['Romanian Deadlift', 3, '10', '30 kg', 90], ['Plank', 3, '30 s', null, 45]]],
      ['Full Body B', 'Hinge + pull', [['Leg Press', 3, '12', '80 kg', 90], ['Incline Dumbbell Press', 3, '10', '12 kg', 75], ['Seated Cable Row', 3, '12', '35 kg', 60], ['Walking Lunge', 2, '10/leg', '8 kg', 60], ['Dead Bug', 3, '10/side', null, 45]]],
      ['Full Body C', 'Conditioning', [['Kettlebell Swing', 4, '15', '16 kg', 60], ['Single-arm Dumbbell Row', 3, '10/side', '14 kg', 60], ['Overhead Press', 3, '8', '25 kg', 90], ['Rowing Machine', 1, '10 min', null, 0], ['World’s Greatest Stretch', 2, '5/side', null, 0]]],
    ],
  },
  {
    name: 'Upper / Lower · 4 Day Hypertrophy', goal: 'Muscle gain', level: 'intermediate', weeks: 10,
    days: [
      ['Upper A', 'Chest & back', [['Barbell Bench Press', 4, '6-8', '60 kg', 120], ['Barbell Row', 4, '8', '55 kg', 90], ['Incline Dumbbell Press', 3, '10', '20 kg', 75], ['Lat Pulldown', 3, '10-12', '50 kg', 60], ['Lateral Raise', 3, '15', '8 kg', 45], ['Triceps Rope Pushdown', 3, '12', '25 kg', 45]]],
      ['Lower A', 'Squat focus', [['Barbell Back Squat', 4, '6-8', '80 kg', 150], ['Romanian Deadlift', 3, '8-10', '70 kg', 120], ['Leg Press', 3, '12', '140 kg', 90], ['Leg Curl', 3, '12', '35 kg', 60], ['Standing Calf Raise', 4, '12', '60 kg', 45]]],
      ['Upper B', 'Shoulders & arms', [['Overhead Press', 4, '6-8', '40 kg', 120], ['Pull-up', 4, 'AMRAP', 'BW', 90], ['Cable Fly', 3, '12-15', '15 kg', 60], ['Face Pull', 3, '15', '20 kg', 45], ['Dumbbell Curl', 3, '12', '12 kg', 45]]],
      ['Lower B', 'Hinge focus', [['Conventional Deadlift', 4, '5', '100 kg', 180], ['Bulgarian Split Squat', 3, '10/leg', '16 kg', 90], ['Hip Thrust', 3, '10', '90 kg', 90], ['Hanging Knee Raise', 3, '12', null, 45]]],
    ],
  },
  {
    name: 'Fat Loss Circuit · 3 Day', goal: 'Fat loss', level: 'beginner', weeks: 6,
    days: [
      ['Circuit A', 'Metabolic', [['Goblet Squat', 3, '15', '10 kg', 30], ['Push-up', 3, '10', null, 30], ['Kettlebell Swing', 3, '20', '12 kg', 30], ['Battle Ropes', 3, '30 s', null, 30], ['Incline Walk', 1, '20 min', null, 0]]],
      ['Circuit B', 'Metabolic', [['Walking Lunge', 3, '12/leg', null, 30], ['Seated Cable Row', 3, '15', '30 kg', 30], ['Burpee', 3, '10', null, 45], ['Russian Twist', 3, '20', '5 kg', 30], ['Assault Bike', 1, '10 × 20 s on/40 s off', null, 0]]],
      ['Circuit C', 'Strength-endurance', [['Leg Press', 3, '15', '60 kg', 45], ['Lat Pulldown', 3, '15', '30 kg', 45], ['Jump Squat', 3, '12', null, 45], ['Plank', 3, '40 s', null, 30], ['Treadmill Intervals', 1, '15 min', null, 0]]],
    ],
  },
  {
    name: 'Strength 5×5', goal: 'Strength', level: 'intermediate', weeks: 12,
    days: [
      ['Day A', 'Squat · bench · row', [['Barbell Back Squat', 5, '5', '90 kg', 180], ['Barbell Bench Press', 5, '5', '70 kg', 180], ['Barbell Row', 5, '5', '60 kg', 120]]],
      ['Day B', 'Squat · press · deadlift', [['Barbell Back Squat', 5, '5', '90 kg', 180], ['Overhead Press', 5, '5', '45 kg', 150], ['Conventional Deadlift', 1, '5', '120 kg', 180]]],
    ],
  },
  {
    name: 'Mobility & Back Care', goal: 'Mobility', level: 'beginner', weeks: 4,
    days: [
      ['Mobility Flow', 'Hips & spine', [['Cat-Cow', 2, '10', null, 0], ['Hip 90/90', 2, '6/side', null, 0], ['Thoracic Rotation', 2, '8/side', null, 0], ['Couch Stretch', 2, '45 s/side', null, 0], ['Dead Bug', 3, '8/side', null, 30], ['Pallof Press', 3, '10/side', '10 kg', 30]]],
      ['Strength Support', 'Posterior chain', [['Hip Thrust', 3, '12', '40 kg', 60], ['Face Pull', 3, '15', '15 kg', 45], ['Goblet Squat', 3, '10', '10 kg', 60], ['Plank', 3, '30 s', null, 30]]],
    ],
  },
];

type Item = [string, string, number, number, number, number];
const NUTRITION_TEMPLATES: { name: string; goal: string; diet: string; kcal: number; p: number; c: number; f: number; water: number; rec: string[]; avoid: string[]; meals: [string, string, Item[]][] }[] = [
  {
    name: 'Fat Loss · Vegetarian 1700', goal: 'Fat loss', diet: 'vegetarian', kcal: 1700, p: 110, c: 180, f: 55, water: 3,
    rec: ['Protein at every meal', 'Fill half the plate with vegetables', 'Walk 10 minutes after dinner'], avoid: ['Fried snacks', 'Sugary chai and soft drinks', 'Refined maida'],
    meals: [
      ['Breakfast', '08:00', [['Moong dal chilla', '2 medium', 280, 16, 34, 7], ['Low-fat curd', '150 g', 90, 6, 7, 3]]],
      ['Lunch', '13:00', [['Brown rice', '1 cup cooked', 215, 5, 45, 2], ['Dal tadka', '1 bowl', 180, 11, 24, 5], ['Paneer bhurji', '100 g paneer', 300, 20, 6, 22], ['Cucumber salad', '1 plate', 30, 1, 6, 0]]],
      ['Snack', '17:00', [['Whey protein in water', '1 scoop', 120, 24, 3, 2], ['Apple', '1 medium', 95, 0, 25, 0]]],
      ['Dinner', '20:30', [['Phulka', '2', 160, 6, 32, 1], ['Mixed veg sabzi', '1 bowl', 120, 4, 14, 6], ['Tofu tikka', '120 g', 180, 18, 5, 10]]],
    ],
  },
  {
    name: 'Muscle Gain · High Protein 2800', goal: 'Muscle gain', diet: 'non_vegetarian', kcal: 2800, p: 170, c: 330, f: 85, water: 4,
    rec: ['Eat within an hour after training', 'Creatine 5 g daily', '7–8 hours of sleep'], avoid: ['Skipping breakfast', 'Alcohol on training days'],
    meals: [
      ['Breakfast', '07:30', [['Masala omelette', '3 eggs + 2 whites', 330, 27, 4, 22], ['Whole wheat toast', '3 slices', 240, 9, 42, 3], ['Banana', '1 large', 120, 1, 31, 0]]],
      ['Lunch', '13:00', [['Chicken curry', '200 g chicken', 380, 44, 8, 18], ['Jeera rice', '1.5 cups', 320, 6, 66, 3], ['Rajma', '1 bowl', 210, 13, 34, 2]]],
      ['Pre-workout', '17:00', [['Peanut butter sandwich', '2 slices + 1 tbsp', 330, 13, 40, 13], ['Black coffee', '1 cup', 5, 0, 1, 0]]],
      ['Post-workout', '19:30', [['Whey protein with milk', '1 scoop + 300 ml', 300, 34, 18, 10], ['Oats', '60 g', 230, 8, 40, 4]]],
      ['Dinner', '21:00', [['Grilled fish', '200 g', 280, 42, 0, 12], ['Roti', '3', 300, 9, 54, 4], ['Palak sabzi', '1 bowl', 110, 5, 10, 6]]],
    ],
  },
  {
    name: 'Maintenance · Balanced Eggetarian 2200', goal: 'General fitness', diet: 'eggetarian', kcal: 2200, p: 120, c: 260, f: 70, water: 3.5,
    rec: ['Plan meals for the week on Sunday', 'Two fruits a day'], avoid: ['Late-night snacking'],
    meals: [
      ['Breakfast', '08:00', [['Poha with peanuts', '1.5 cups', 330, 8, 54, 9], ['Boiled eggs', '2', 155, 13, 1, 11]]],
      ['Lunch', '13:00', [['Roti', '3', 300, 9, 54, 4], ['Chana masala', '1 bowl', 270, 14, 40, 6], ['Salad + curd', '1 plate', 120, 6, 12, 4]]],
      ['Snack', '17:00', [['Sprouts chaat', '1 bowl', 180, 12, 28, 2], ['Buttermilk', '1 glass', 60, 3, 5, 2]]],
      ['Dinner', '20:30', [['Egg bhurji', '3 eggs', 280, 19, 4, 20], ['Millet khichdi', '1 bowl', 320, 11, 52, 7]]],
    ],
  },
];

/** Idempotent: does nothing if the exercise library already exists. */
export async function seedFitness() {
  const has = await one(`SELECT count(*)::int AS n FROM exercises`);
  if (has!.n > 0) return;
  const org = await one(`SELECT id FROM organizations ORDER BY created_at LIMIT 1`);
  if (!org) return;

  await tx(async (c) => {
    const q = (text: string, params: unknown[] = []) => c.query(text, params).then((r) => r.rows);
    const now = today();
    const ex: Record<string, string> = {};
    for (const [name, category, muscle, equipment, instructions] of EXERCISES) {
      const [r] = await q(`INSERT INTO exercises (organization_id, name, category, muscle_group, equipment, instructions) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [org.id, name, category, muscle, equipment, instructions]);
      ex[name] = r.id;
    }
    const trainers = await q(
      `SELECT u.id, r.key, COALESCE(array_agg(sb.branch_id) FILTER (WHERE sb.branch_id IS NOT NULL), '{}') AS branches
         FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN staff_branches sb ON sb.user_id = u.id
        WHERE u.organization_id = $1 AND r.key IN ('trainer', 'nutritionist') GROUP BY u.id, r.key`,
      [org.id],
    );
    const trainerAt = (b: string) => pick(trainers.filter((t: any) => t.key === 'trainer' && t.branches.includes(b)));
    const nutritionist = trainers.find((t: any) => t.key === 'nutritionist');

    const wTemplates: Record<string, string> = {};
    for (const t of WORKOUT_TEMPLATES) {
      const [p] = await q(
        `INSERT INTO workout_plans (organization_id, is_template, name, goal, level, duration_weeks, days_per_week, notes) VALUES ($1,true,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [org.id, t.name, t.goal, t.level, t.weeks, t.days.length, 'Progress load when all sets hit the top of the rep range.'],
      );
      wTemplates[t.goal] = p.id;
      await writeWorkoutContent(c, p.id, t.days.map(([name, focus, exs]) => ({ name, focus, exercises: exs.map(([n, sets, reps, weight, rest]) => ({ exerciseId: ex[n], sets, reps, weight, restSeconds: rest })) })));
    }
    const nTemplates: Record<string, any> = {};
    for (const t of NUTRITION_TEMPLATES) {
      const [p] = await q(
        `INSERT INTO nutrition_plans (organization_id, is_template, name, goal, calorie_target, protein_g, carbs_g, fat_g, water_l, diet_type, recommendations, avoid, nutritionist_id)
         VALUES ($1,true,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [org.id, t.name, t.goal, t.kcal, t.p, t.c, t.f, t.water, t.diet, t.rec, t.avoid, nutritionist?.id ?? null],
      );
      nTemplates[t.goal] = { id: p.id, t };
      await writeNutritionContent(c, p.id, t.meals.map(([name, time, items]) => ({ name, time, items: items.map(([food, quantity, calories, proteinG, carbsG, fatG]) => ({ food, quantity, calories, proteinG, carbsG, fatG })) })));
    }

    // Coached members: anyone with PT, the Elite plan, or a recent assessment appointment.
    const coached = await q(
      `SELECT DISTINCT m.id, m.branch_id, m.gender, m.join_date, cm.plan_name, cm.status,
              (SELECT trainer_id FROM member_pt_packages pp WHERE pp.member_id = m.id ORDER BY pp.created_at DESC LIMIT 1) AS pt_trainer
         FROM members m JOIN member_current_membership cm ON cm.member_id = m.id
        WHERE m.organization_id = $1 AND cm.status IN ('active', 'expiring_soon', 'frozen')
          AND (EXISTS (SELECT 1 FROM member_pt_packages pp WHERE pp.member_id = m.id)
               OR cm.plan_name = 'Annual Elite'
               OR EXISTS (SELECT 1 FROM appointments a WHERE a.member_id = m.id AND a.type = 'assessment')
               OR m.id IN (SELECT id FROM members WHERE organization_id = $1 ORDER BY member_code LIMIT 40))`,
      [org.id],
    );
    const goalOf = (): string => pick(['fat_loss', 'fat_loss', 'muscle_gain', 'muscle_gain', 'general_fitness', 'strength', 'mobility']);
    const GOAL_TEMPLATE: Record<string, string> = { fat_loss: 'Fat loss', muscle_gain: 'Muscle gain', general_fitness: 'General fitness', strength: 'Strength', mobility: 'Mobility' };
    let plans = 0, logs = 0, assessments = 0, nPlans = 0;
    for (const m of coached) {
      const goal = goalOf();
      const trainer = m.pt_trainer ?? trainerAt(m.branch_id)?.id ?? null;
      const veg = rand() < 0.45;
      await q(
        `INSERT INTO member_fitness_profiles (member_id, primary_goal, target_weight_kg, experience_level, training_days_per_week, injuries, dietary_preference, assigned_trainer_id, assigned_nutritionist_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [m.id, goal, null, pick(['beginner', 'beginner', 'intermediate', 'advanced']), pick([3, 4, 4, 5]), rand() < 0.15 ? pick(['Lower back stiffness', 'Old ACL repair (left knee)', 'Shoulder impingement — avoid behind-neck press']) : null,
          veg ? 'vegetarian' : pick(['eggetarian', 'non_vegetarian']), trainer, m.plan_name === 'Annual Elite' || rand() < 0.15 ? nutritionist?.id ?? null : null],
      );

      // Assessment history trending toward the goal.
      const male = m.gender === 'male';
      const height = round1(male ? 165 + rand() * 20 : 152 + rand() * 18);
      let weight = round1(goal === 'fat_loss' ? (male ? 88 : 74) + rand() * 14 : goal === 'muscle_gain' ? (male ? 64 : 52) + rand() * 8 : (male ? 72 : 58) + rand() * 12);
      let fat = round1(goal === 'fat_loss' ? (male ? 27 : 34) + rand() * 6 : (male ? 17 : 25) + rand() * 6);
      let waist = round1(goal === 'fat_loss' ? (male ? 98 : 88) + rand() * 8 : (male ? 82 : 72) + rand() * 6);
      let push = Math.round(male ? 12 + rand() * 18 : 4 + rand() * 12);
      let plank = Math.round(40 + rand() * 60);
      const start = m.join_date < addToDate(now, 'day', -300) ? addToDate(now, 'day', -Math.floor(150 + rand() * 120)) : m.join_date;
      let date = addToDate(start, 'day', 3);
      const target = goal === 'fat_loss' ? round1(weight - 8 - rand() * 6) : goal === 'muscle_gain' ? round1(weight + 5 + rand() * 4) : null;
      if (target) await q(`UPDATE member_fitness_profiles SET target_weight_kg = $2 WHERE member_id = $1`, [m.id, target]);
      while (date <= now) {
        const muscle = round1(weight * (1 - fat / 100) * 0.52);
        await q(
          `INSERT INTO fitness_assessments (organization_id, branch_id, member_id, assessed_on, assessed_by, weight_kg, height_cm, body_fat_pct, muscle_mass_kg, visceral_fat, resting_hr,
                                            waist_cm, hips_cm, chest_cm, arm_cm, thigh_cm, pushups, plank_seconds, squats_1min, sit_reach_cm, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
          [org.id, m.branch_id, m.id, date, trainer, weight, height, fat, muscle, Math.max(2, Math.round(fat / 3.2)), Math.round(58 + rand() * 20),
            waist, round1(waist + (male ? 6 : 14)), round1(waist + (male ? 14 : 8)), round1(male ? 32 + rand() * 6 : 26 + rand() * 5), round1(male ? 54 + rand() * 6 : 52 + rand() * 6),
            push, plank, Math.round(28 + rand() * 20), round1(-4 + rand() * 16), date === addToDate(start, 'day', 3) ? 'Baseline assessment' : null],
        );
        assessments++;
        // Progress between check-ins, with noise.
        const delta = goal === 'fat_loss' ? -(1.2 + rand() * 2) : goal === 'muscle_gain' ? 0.6 + rand() * 1.1 : -0.4 + rand() * 0.8;
        weight = round1(weight + delta);
        fat = round1(Math.max(8, fat + (goal === 'fat_loss' ? -(0.8 + rand() * 1.2) : goal === 'muscle_gain' ? -0.2 + rand() * 0.5 : -0.3 + rand() * 0.4)));
        waist = round1(waist + (goal === 'fat_loss' ? -(1 + rand() * 1.5) : -0.3 + rand() * 0.6));
        push += Math.round(1 + rand() * 3);
        plank += Math.round(5 + rand() * 15);
        date = addToDate(date, 'day', 28 + Math.floor(rand() * 21));
      }

      // Current workout plan from the matching template, with a log history.
      const tplName = GOAL_TEMPLATE[goal];
      if (rand() < 0.88) {
        const started = addToDate(now, 'day', -Math.floor(7 + rand() * 50));
        const tpl = WORKOUT_TEMPLATES.find((t) => t.goal === tplName)!;
        const [p] = await q(
          `INSERT INTO workout_plans (organization_id, branch_id, member_id, source_template_id, name, goal, level, duration_weeks, days_per_week, trainer_id, status, starts_on, ends_on, created_by, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',$11::date,$12,$10,$11::date::timestamptz) RETURNING id`,
          [org.id, m.branch_id, m.id, wTemplates[tplName], tpl.name, tpl.goal, tpl.level, tpl.weeks, tpl.days.length, trainer, started, addToDate(started, 'day', tpl.weeks * 7 - 1)],
        );
        await writeWorkoutContent(c, p.id, tpl.days.map(([name, focus, exs]) => ({ name, focus, exercises: exs.map(([n, sets, reps, weight, rest]) => ({ exerciseId: ex[n], sets, reps, weight, restSeconds: rest })) })));
        plans++;
        const days = await q(`SELECT id, day_number, name FROM workout_days WHERE plan_id = $1 ORDER BY day_number`, [p.id]);
        const adherence = pick([0.35, 0.6, 0.8, 0.95]);
        let k = 0;
        for (let d = started; d < now; d = addToDate(d, 'day', 1)) {
          if (rand() > (tpl.days.length / 7) * adherence * 1.1) continue;
          const day = days[k++ % days.length];
          await q(
            `INSERT INTO workout_logs (organization_id, plan_id, day_id, member_id, performed_on, duration_min, rpe, source, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$5::date + time '19:00')`,
            [org.id, p.id, day.id, m.id, d, 40 + Math.floor(rand() * 35), 6 + Math.floor(rand() * 4), rand() < 0.8 ? 'app' : 'crm'],
          );
          logs++;
        }
      }

      const ntpl = nTemplates[goal === 'fat_loss' ? 'Fat loss' : goal === 'muscle_gain' ? 'Muscle gain' : 'General fitness'];
      if (nutritionist && (m.plan_name === 'Annual Elite' || rand() < 0.25)) {
        const t = ntpl.t;
        const [np] = await q(
          `INSERT INTO nutrition_plans (organization_id, branch_id, member_id, source_template_id, name, goal, calorie_target, protein_g, carbs_g, fat_g, water_l, diet_type, recommendations, avoid, nutritionist_id, status, starts_on)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'active',$16) RETURNING id`,
          [org.id, m.branch_id, m.id, ntpl.id, t.name, t.goal, t.kcal, t.p, t.c, t.f, t.water, t.diet, t.rec, t.avoid, nutritionist.id, addToDate(now, 'day', -Math.floor(rand() * 40))],
        );
        await writeNutritionContent(c, np.id, t.meals.map(([name, time, items]: any) => ({ name, time, items: items.map(([food, quantity, calories, proteinG, carbsG, fatG]: Item) => ({ food, quantity, calories, proteinG, carbsG, fatG })) })));
        nPlans++;
      }
    }
    console.log(`Seeded fitness: ${EXERCISES.length} exercises, ${WORKOUT_TEMPLATES.length + NUTRITION_TEMPLATES.length} templates, ${plans} workout plans, ${logs} workout logs, ${nPlans} nutrition plans, ${assessments} assessments.`);
  });
}
