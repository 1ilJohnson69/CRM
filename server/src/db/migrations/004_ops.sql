-- Phase 3: attendance, classes, personal training, appointments.

ALTER TABLE organizations
  ADD COLUMN pt_no_show_consumes boolean NOT NULL DEFAULT true,
  ADD COLUMN class_cancel_cutoff_hours int NOT NULL DEFAULT 2,
  ADD COLUMN checkin_dedupe_minutes int NOT NULL DEFAULT 90,
  ADD COLUMN inactive_after_days int NOT NULL DEFAULT 14;

-- Attendance ----------------------------------------------------------------

-- Every entry attempt, including denied ones, so the desk and access
-- hardware share one audit trail.
CREATE TABLE attendance (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  branch_id       uuid NOT NULL REFERENCES branches(id),
  member_id       uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  checked_in_at   timestamptz NOT NULL DEFAULT now(),
  checked_out_at  timestamptz,
  method          text NOT NULL CHECK (method IN ('front_desk', 'qr', 'member_id', 'app', 'access_control')),
  status          text NOT NULL DEFAULT 'allowed' CHECK (status IN ('allowed', 'denied', 'override')),
  reason          text,
  device          text,
  recorded_by     uuid REFERENCES users(id),
  CHECK (checked_out_at IS NULL OR checked_out_at >= checked_in_at)
);
CREATE INDEX attendance_org_time_idx ON attendance (organization_id, checked_in_at DESC);
CREATE INDEX attendance_branch_time_idx ON attendance (branch_id, checked_in_at DESC);
CREATE INDEX attendance_member_idx ON attendance (member_id, checked_in_at DESC);

CREATE VIEW member_visit_stats AS
SELECT m.id AS member_id,
       max(a.checked_in_at) AS last_visit_at,
       count(a.id) FILTER (WHERE a.checked_in_at >= now() - interval '30 days') AS visits_30d,
       count(a.id) AS visits_total
  FROM members m
  LEFT JOIN attendance a ON a.member_id = m.id AND a.status <> 'denied'
 GROUP BY m.id;

CREATE TABLE staff_attendance (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  branch_id       uuid NOT NULL REFERENCES branches(id),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clock_in        timestamptz NOT NULL DEFAULT now(),
  clock_out       timestamptz,
  method          text NOT NULL DEFAULT 'front_desk' CHECK (method IN ('front_desk', 'self', 'access_control')),
  recorded_by     uuid REFERENCES users(id),
  CHECK (clock_out IS NULL OR clock_out >= clock_in)
);
CREATE INDEX staff_attendance_idx ON staff_attendance (organization_id, clock_in DESC);
CREATE UNIQUE INDEX staff_attendance_open_uq ON staff_attendance (user_id) WHERE clock_out IS NULL;

-- Trainers & availability ---------------------------------------------------

CREATE TABLE trainer_profiles (
  user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  specialties text[] NOT NULL DEFAULT '{}',
  bio         text,
  is_bookable boolean NOT NULL DEFAULT true
);

CREATE TABLE staff_availability (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  branch_id  uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  weekday    smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time time NOT NULL,
  end_time   time NOT NULL,
  CHECK (end_time > start_time)
);
CREATE INDEX staff_availability_user_idx ON staff_availability (user_id, weekday);

-- Classes -------------------------------------------------------------------

CREATE TABLE class_types (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES organizations(id),
  name                  text NOT NULL,
  description           text,
  category              text,
  default_duration_min  int NOT NULL DEFAULT 60 CHECK (default_duration_min BETWEEN 10 AND 240),
  default_capacity      int NOT NULL DEFAULT 20 CHECK (default_capacity > 0),
  requires_class_access boolean NOT NULL DEFAULT true,
  is_active             boolean NOT NULL DEFAULT true,
  UNIQUE (organization_id, name)
);

-- Recurring timetable; concrete sessions are generated from it.
CREATE TABLE class_schedules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  branch_id       uuid NOT NULL REFERENCES branches(id),
  class_type_id   uuid NOT NULL REFERENCES class_types(id),
  trainer_id      uuid REFERENCES users(id),
  weekdays        smallint[] NOT NULL CHECK (array_length(weekdays, 1) > 0),
  start_time      time NOT NULL,
  duration_min    int NOT NULL CHECK (duration_min BETWEEN 10 AND 240),
  capacity        int NOT NULL CHECK (capacity > 0),
  location        text,
  starts_on       date NOT NULL DEFAULT current_date,
  ends_on         date,
  is_active       boolean NOT NULL DEFAULT true,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE class_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  branch_id       uuid NOT NULL REFERENCES branches(id),
  class_type_id   uuid NOT NULL REFERENCES class_types(id),
  schedule_id     uuid REFERENCES class_schedules(id) ON DELETE SET NULL,
  trainer_id      uuid REFERENCES users(id),
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  capacity        int NOT NULL CHECK (capacity > 0),
  location        text,
  status          text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled', 'completed')),
  cancel_reason   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (schedule_id, starts_at),
  CHECK (ends_at > starts_at)
);
CREATE INDEX class_sessions_time_idx ON class_sessions (organization_id, branch_id, starts_at);

CREATE TABLE class_bookings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  session_id       uuid NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE,
  member_id        uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  status           text NOT NULL CHECK (status IN ('booked', 'waitlisted', 'cancelled', 'attended', 'no_show')),
  source           text NOT NULL DEFAULT 'crm' CHECK (source IN ('crm', 'app')),
  booked_by        uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  cancelled_at     timestamptz,
  attended_at      timestamptz,
  promoted_at      timestamptz,
  reminder_sent_at timestamptz
);
CREATE UNIQUE INDEX class_bookings_active_uq ON class_bookings (session_id, member_id) WHERE status <> 'cancelled';
CREATE INDEX class_bookings_member_idx ON class_bookings (member_id, created_at DESC);

-- Personal training ---------------------------------------------------------

CREATE TABLE pt_packages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  name            text NOT NULL,
  description     text,
  sessions        int NOT NULL CHECK (sessions > 0),
  validity_days   int NOT NULL CHECK (validity_days > 0),
  price           numeric(12,2) NOT NULL CHECK (price >= 0),
  tax_rate        numeric(5,2) NOT NULL DEFAULT 18,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE TABLE member_pt_packages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  branch_id       uuid NOT NULL REFERENCES branches(id),
  member_id       uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  package_id      uuid NOT NULL REFERENCES pt_packages(id),
  trainer_id      uuid REFERENCES users(id),
  sessions_total  int NOT NULL CHECK (sessions_total > 0),
  price           numeric(12,2) NOT NULL,
  discount        numeric(12,2) NOT NULL DEFAULT 0,
  starts_on       date NOT NULL DEFAULT current_date,
  expires_on      date NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'cancelled')),
  cancel_reason   text,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX member_pt_packages_member_idx ON member_pt_packages (member_id);
CREATE INDEX member_pt_packages_trainer_idx ON member_pt_packages (trainer_id);

ALTER TABLE invoice_items ADD COLUMN member_pt_package_id uuid REFERENCES member_pt_packages(id);

-- Appointments (PT sessions, consultations, assessments, trials) -----------

CREATE TABLE appointments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations(id),
  branch_id            uuid NOT NULL REFERENCES branches(id),
  type                 text NOT NULL CHECK (type IN ('pt', 'nutrition', 'assessment', 'trial', 'consultation', 'other')),
  staff_id             uuid REFERENCES users(id),
  member_id            uuid REFERENCES members(id) ON DELETE CASCADE,
  lead_id              uuid REFERENCES leads(id) ON DELETE CASCADE,
  member_pt_package_id uuid REFERENCES member_pt_packages(id),
  starts_at            timestamptz NOT NULL,
  ends_at              timestamptz NOT NULL,
  status               text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled', 'no_show')),
  -- Set when the appointment closes; decides whether a PT session was used.
  consumed_session     boolean NOT NULL DEFAULT false,
  location             text,
  notes                text,
  outcome_notes        text,
  cancel_reason        text,
  reminder_sent_at     timestamptz,
  created_by           uuid REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK ((member_id IS NULL) <> (lead_id IS NULL)),
  CHECK (type <> 'pt' OR member_pt_package_id IS NOT NULL)
);
CREATE INDEX appointments_time_idx ON appointments (organization_id, branch_id, starts_at);
CREATE INDEX appointments_staff_idx ON appointments (staff_id, starts_at);
CREATE INDEX appointments_member_idx ON appointments (member_id, starts_at);
CREATE INDEX appointments_package_idx ON appointments (member_pt_package_id);

-- Live package balance: sessions used are derived from appointments, never
-- typed in by hand, so the CRM and member app can't disagree.
CREATE VIEW member_pt_package_status AS
SELECT p.*,
       pk.name AS package_name,
       COALESCE(u.used, 0)::int AS sessions_used,
       COALESCE(u.booked, 0)::int AS sessions_booked,
       (p.sessions_total - COALESCE(u.used, 0))::int AS sessions_remaining,
       CASE
         WHEN p.status IN ('pending', 'cancelled') THEN p.status
         WHEN COALESCE(u.used, 0) >= p.sessions_total THEN 'exhausted'
         WHEN p.expires_on < current_date THEN 'expired'
         ELSE 'active'
       END AS effective_status
  FROM member_pt_packages p
  JOIN pt_packages pk ON pk.id = p.package_id
  LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE a.consumed_session) AS used,
           count(*) FILTER (WHERE a.status = 'scheduled') AS booked
      FROM appointments a WHERE a.member_pt_package_id = p.id
  ) u ON true;

-- Permissions ---------------------------------------------------------------

INSERT INTO permissions (key, module, description) VALUES
  ('attendance.read', 'Attendance', 'View check-ins and attendance analytics'),
  ('attendance.checkin', 'Attendance', 'Check members in and out'),
  ('attendance.override', 'Attendance', 'Allow entry despite a membership problem'),
  ('staff.attendance', 'Attendance', 'Clock staff in and out'),
  ('classes.read', 'Classes', 'View the class timetable and rosters'),
  ('classes.book', 'Classes', 'Book and cancel members in classes, mark attendance'),
  ('classes.manage', 'Classes', 'Create class types, schedules and one-off sessions'),
  ('appointments.read', 'Appointments', 'View the appointment calendar'),
  ('appointments.manage', 'Appointments', 'Book, reschedule, complete and cancel appointments'),
  ('pt.sell', 'Personal training', 'Sell PT packages'),
  ('pt.manage', 'Personal training', 'Edit PT packages and trainer profiles')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, g.perm
  FROM roles r
  JOIN (VALUES
    ('super_admin', 'attendance.read'), ('super_admin', 'attendance.checkin'), ('super_admin', 'attendance.override'), ('super_admin', 'staff.attendance'),
    ('super_admin', 'classes.read'), ('super_admin', 'classes.book'), ('super_admin', 'classes.manage'),
    ('super_admin', 'appointments.read'), ('super_admin', 'appointments.manage'), ('super_admin', 'pt.sell'), ('super_admin', 'pt.manage'),
    ('branch_manager', 'attendance.read'), ('branch_manager', 'attendance.checkin'), ('branch_manager', 'attendance.override'), ('branch_manager', 'staff.attendance'),
    ('branch_manager', 'classes.read'), ('branch_manager', 'classes.book'), ('branch_manager', 'classes.manage'),
    ('branch_manager', 'appointments.read'), ('branch_manager', 'appointments.manage'), ('branch_manager', 'pt.sell'), ('branch_manager', 'pt.manage'),
    ('front_desk', 'attendance.read'), ('front_desk', 'attendance.checkin'), ('front_desk', 'staff.attendance'),
    ('front_desk', 'classes.read'), ('front_desk', 'classes.book'), ('front_desk', 'appointments.read'), ('front_desk', 'appointments.manage'), ('front_desk', 'pt.sell'),
    ('sales', 'attendance.read'), ('sales', 'classes.read'), ('sales', 'classes.book'), ('sales', 'appointments.read'), ('sales', 'appointments.manage'), ('sales', 'pt.sell'),
    ('trainer', 'attendance.read'), ('trainer', 'classes.read'), ('trainer', 'classes.book'), ('trainer', 'appointments.read'), ('trainer', 'appointments.manage'),
    ('nutritionist', 'appointments.read'), ('nutritionist', 'appointments.manage'),
    ('accountant', 'attendance.read')
  ) AS g(role_key, perm) ON g.role_key = r.key
ON CONFLICT DO NOTHING;
