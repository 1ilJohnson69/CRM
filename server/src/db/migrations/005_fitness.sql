-- Phase 4: workouts, nutrition, fitness assessments, progress photos.

-- Per-member fitness context: goal, limitations and who coaches them.
CREATE TABLE member_fitness_profiles (
  member_id                uuid PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  primary_goal             text CHECK (primary_goal IN ('fat_loss', 'muscle_gain', 'strength', 'general_fitness', 'endurance', 'mobility', 'rehab', 'sport')),
  target_weight_kg         numeric(5,1),
  experience_level         text CHECK (experience_level IN ('beginner', 'intermediate', 'advanced')),
  training_days_per_week   smallint CHECK (training_days_per_week BETWEEN 1 AND 7),
  injuries                 text,
  medical_notes            text,
  dietary_preference       text CHECK (dietary_preference IN ('vegetarian', 'eggetarian', 'non_vegetarian', 'vegan', 'jain')),
  assigned_trainer_id      uuid REFERENCES users(id),
  assigned_nutritionist_id uuid REFERENCES users(id),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  updated_by               uuid REFERENCES users(id)
);

-- Exercise library -----------------------------------------------------------

CREATE TABLE exercises (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  name            text NOT NULL,
  category        text NOT NULL CHECK (category IN ('strength', 'cardio', 'mobility', 'core', 'plyometric', 'conditioning')),
  muscle_group    text,
  equipment       text,
  instructions    text,
  video_url       text,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

-- Workout plans (member plans and reusable templates share one shape) -------

CREATE TABLE workout_plans (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id),
  branch_id          uuid REFERENCES branches(id),
  member_id          uuid REFERENCES members(id) ON DELETE CASCADE,
  is_template        boolean NOT NULL DEFAULT false,
  source_template_id uuid REFERENCES workout_plans(id) ON DELETE SET NULL,
  name               text NOT NULL,
  goal               text,
  level              text CHECK (level IN ('beginner', 'intermediate', 'advanced')),
  duration_weeks     smallint CHECK (duration_weeks BETWEEN 1 AND 52),
  days_per_week      smallint CHECK (days_per_week BETWEEN 1 AND 7),
  notes              text,
  trainer_id         uuid REFERENCES users(id),
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'completed', 'archived')),
  starts_on          date,
  ends_on            date,
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (is_template = (member_id IS NULL))
);
-- One live plan per member: assigning a new one retires the old.
CREATE UNIQUE INDEX workout_plans_one_active ON workout_plans (member_id) WHERE status = 'active' AND member_id IS NOT NULL;
CREATE INDEX workout_plans_org_idx ON workout_plans (organization_id, is_template, status);

CREATE TABLE workout_days (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id    uuid NOT NULL REFERENCES workout_plans(id) ON DELETE CASCADE,
  day_number smallint NOT NULL,
  name       text NOT NULL,
  focus      text,
  notes      text,
  UNIQUE (plan_id, day_number)
);

CREATE TABLE workout_exercises (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  day_id       uuid NOT NULL REFERENCES workout_days(id) ON DELETE CASCADE,
  exercise_id  uuid NOT NULL REFERENCES exercises(id),
  sort         smallint NOT NULL,
  sets         smallint NOT NULL CHECK (sets BETWEEN 1 AND 20),
  reps         text NOT NULL,
  weight       text,
  rest_seconds smallint CHECK (rest_seconds BETWEEN 0 AND 900),
  tempo        text,
  notes        text
);
CREATE INDEX workout_exercises_day_idx ON workout_exercises (day_id, sort);

-- Completed sessions, logged from the member app or by a trainer.
CREATE TABLE workout_logs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  plan_id      uuid NOT NULL REFERENCES workout_plans(id) ON DELETE CASCADE,
  day_id       uuid REFERENCES workout_days(id) ON DELETE SET NULL,
  member_id    uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  performed_on date NOT NULL DEFAULT current_date,
  duration_min smallint,
  rpe          smallint CHECK (rpe BETWEEN 1 AND 10),
  notes        text,
  entries      jsonb NOT NULL DEFAULT '[]',
  source       text NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'crm')),
  logged_by    uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workout_logs_member_idx ON workout_logs (member_id, performed_on DESC);
CREATE INDEX workout_logs_plan_idx ON workout_logs (plan_id, performed_on DESC);

-- Nutrition plans ------------------------------------------------------------

CREATE TABLE nutrition_plans (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id),
  branch_id          uuid REFERENCES branches(id),
  member_id          uuid REFERENCES members(id) ON DELETE CASCADE,
  is_template        boolean NOT NULL DEFAULT false,
  source_template_id uuid REFERENCES nutrition_plans(id) ON DELETE SET NULL,
  name               text NOT NULL,
  goal               text,
  calorie_target     int CHECK (calorie_target BETWEEN 800 AND 6000),
  protein_g          smallint CHECK (protein_g BETWEEN 0 AND 500),
  carbs_g            smallint CHECK (carbs_g BETWEEN 0 AND 900),
  fat_g              smallint CHECK (fat_g BETWEEN 0 AND 400),
  water_l            numeric(3,1),
  diet_type          text CHECK (diet_type IN ('vegetarian', 'eggetarian', 'non_vegetarian', 'vegan', 'jain')),
  restrictions       text[] NOT NULL DEFAULT '{}',
  recommendations    text[] NOT NULL DEFAULT '{}',
  avoid              text[] NOT NULL DEFAULT '{}',
  notes              text,
  nutritionist_id    uuid REFERENCES users(id),
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'completed', 'archived')),
  starts_on          date,
  ends_on            date,
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (is_template = (member_id IS NULL))
);
CREATE UNIQUE INDEX nutrition_plans_one_active ON nutrition_plans (member_id) WHERE status = 'active' AND member_id IS NOT NULL;

CREATE TABLE nutrition_meals (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id  uuid NOT NULL REFERENCES nutrition_plans(id) ON DELETE CASCADE,
  sort     smallint NOT NULL,
  name     text NOT NULL,
  time     text,
  notes    text
);

CREATE TABLE nutrition_meal_items (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meal_id   uuid NOT NULL REFERENCES nutrition_meals(id) ON DELETE CASCADE,
  sort      smallint NOT NULL,
  food      text NOT NULL,
  quantity  text,
  calories  smallint CHECK (calories BETWEEN 0 AND 3000),
  protein_g numeric(5,1),
  carbs_g   numeric(5,1),
  fat_g     numeric(5,1)
);

-- Assessments ----------------------------------------------------------------

CREATE TABLE fitness_assessments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  branch_id        uuid NOT NULL REFERENCES branches(id),
  member_id        uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  appointment_id   uuid REFERENCES appointments(id) ON DELETE SET NULL,
  assessed_on      date NOT NULL DEFAULT current_date,
  assessed_by      uuid REFERENCES users(id),
  weight_kg        numeric(5,1) CHECK (weight_kg BETWEEN 20 AND 350),
  height_cm        numeric(5,1) CHECK (height_cm BETWEEN 100 AND 250),
  body_fat_pct     numeric(4,1) CHECK (body_fat_pct BETWEEN 2 AND 70),
  muscle_mass_kg   numeric(5,1),
  visceral_fat     smallint,
  resting_hr       smallint CHECK (resting_hr BETWEEN 30 AND 200),
  bp_systolic      smallint,
  bp_diastolic     smallint,
  chest_cm         numeric(5,1),
  waist_cm         numeric(5,1),
  hips_cm          numeric(5,1),
  arm_cm           numeric(5,1),
  thigh_cm         numeric(5,1),
  pushups          smallint,
  plank_seconds    smallint,
  squats_1min      smallint,
  sit_reach_cm     numeric(4,1),
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- BMI is derived, never typed.
  bmi              numeric(4,1) GENERATED ALWAYS AS (
                     CASE WHEN weight_kg IS NOT NULL AND height_cm IS NOT NULL
                          THEN round(weight_kg / ((height_cm / 100) * (height_cm / 100)), 1) END) STORED
);
CREATE INDEX fitness_assessments_member_idx ON fitness_assessments (member_id, assessed_on DESC);

CREATE TABLE progress_photos (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  member_id       uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  assessment_id   uuid REFERENCES fitness_assessments(id) ON DELETE SET NULL,
  taken_on        date NOT NULL DEFAULT current_date,
  angle           text NOT NULL CHECK (angle IN ('front', 'side', 'back', 'other')),
  storage_key     text NOT NULL UNIQUE,
  content_type    text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes      int NOT NULL,
  uploaded_by     uuid REFERENCES users(id),
  source          text NOT NULL DEFAULT 'crm' CHECK (source IN ('crm', 'app')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX progress_photos_member_idx ON progress_photos (member_id, taken_on DESC);

ALTER TABLE organizations ADD COLUMN assessment_interval_days int NOT NULL DEFAULT 60;
ALTER TABLE workout_plans ADD COLUMN end_notified_at timestamptz;

-- Permissions ----------------------------------------------------------------

INSERT INTO permissions (key, module, description) VALUES
  ('workouts.read', 'Fitness', 'View workout plans and the exercise library'),
  ('workouts.manage', 'Fitness', 'Build and assign workout plans, edit exercises'),
  ('nutrition.read', 'Fitness', 'View nutrition plans'),
  ('nutrition.manage', 'Fitness', 'Build and assign nutrition plans'),
  ('assessments.read', 'Fitness', 'View fitness assessments, progress and photos'),
  ('assessments.manage', 'Fitness', 'Record assessments and upload progress photos')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, g.perm
  FROM roles r
  JOIN (VALUES
    ('super_admin', 'workouts.read'), ('super_admin', 'workouts.manage'), ('super_admin', 'nutrition.read'), ('super_admin', 'nutrition.manage'),
    ('super_admin', 'assessments.read'), ('super_admin', 'assessments.manage'),
    ('branch_manager', 'workouts.read'), ('branch_manager', 'workouts.manage'), ('branch_manager', 'nutrition.read'), ('branch_manager', 'nutrition.manage'),
    ('branch_manager', 'assessments.read'), ('branch_manager', 'assessments.manage'),
    ('trainer', 'workouts.read'), ('trainer', 'workouts.manage'), ('trainer', 'nutrition.read'), ('trainer', 'assessments.read'), ('trainer', 'assessments.manage'),
    ('nutritionist', 'nutrition.read'), ('nutritionist', 'nutrition.manage'), ('nutritionist', 'workouts.read'), ('nutritionist', 'assessments.read'), ('nutritionist', 'assessments.manage'),
    ('front_desk', 'workouts.read'), ('front_desk', 'assessments.read'),
    ('sales', 'assessments.read')
  ) AS g(role_key, perm) ON g.role_key = r.key
ON CONFLICT DO NOTHING;
