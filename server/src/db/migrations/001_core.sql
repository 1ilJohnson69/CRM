CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Tenancy -------------------------------------------------------------------

CREATE TABLE organizations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  legal_name    text,
  gstin         text,
  currency      text NOT NULL DEFAULT 'INR',
  timezone      text NOT NULL DEFAULT 'Asia/Kolkata',
  invoice_prefix text NOT NULL DEFAULT 'INV',
  expiring_soon_days int NOT NULL DEFAULT 7,
  renewal_reminder_days int[] NOT NULL DEFAULT '{30,15,7,3,1,0}',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE branches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  name            text NOT NULL,
  code            text NOT NULL,
  address         text,
  phone           text,
  email           text,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

-- Identity & access ---------------------------------------------------------

CREATE TABLE permissions (
  key         text PRIMARY KEY,
  module      text NOT NULL,
  description text NOT NULL
);

CREATE TABLE roles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  key             text NOT NULL,
  name            text NOT NULL,
  description     text,
  all_branches    boolean NOT NULL DEFAULT false,
  is_system       boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, key)
);

CREATE TABLE role_permissions (
  role_id        uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_key)
);

-- One canonical identity for staff and members. The CRM and the Member App
-- authenticate against this same table.
CREATE TABLE users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations(id),
  kind                 text NOT NULL CHECK (kind IN ('staff', 'member')),
  role_id              uuid REFERENCES roles(id),
  full_name            text NOT NULL,
  email                text,
  phone                text,
  password_hash        text,
  must_change_password boolean NOT NULL DEFAULT true,
  is_active            boolean NOT NULL DEFAULT true,
  avatar_url           text,
  last_login_at        timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (kind = 'member' OR role_id IS NOT NULL)
);
CREATE UNIQUE INDEX users_org_email_uq ON users (organization_id, lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX users_org_phone_uq ON users (organization_id, phone) WHERE phone IS NOT NULL;
CREATE INDEX users_name_trgm ON users USING gin (full_name gin_trgm_ops);

CREATE TABLE staff_branches (
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, branch_id)
);

CREATE TABLE employees (
  user_id      uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  designation  text,
  joining_date date,
  salary       numeric(12,2),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash text NOT NULL UNIQUE,
  client             text NOT NULL DEFAULT 'crm' CHECK (client IN ('crm', 'app')),
  user_agent         text,
  ip                 text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- Members -------------------------------------------------------------------

CREATE TABLE members (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  organization_id         uuid NOT NULL REFERENCES organizations(id),
  branch_id               uuid NOT NULL REFERENCES branches(id),
  member_code             text NOT NULL,
  date_of_birth           date,
  gender                  text CHECK (gender IN ('male', 'female', 'other')),
  address                 text,
  emergency_contact_name  text,
  emergency_contact_phone text,
  join_date               date NOT NULL DEFAULT current_date,
  source                  text,
  notes                   text,
  assigned_staff_id       uuid REFERENCES users(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, member_code)
);
CREATE INDEX members_branch_idx ON members (branch_id);

CREATE TABLE counters (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  key             text NOT NULL,
  value           bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (organization_id, key)
);

-- Plans & memberships -------------------------------------------------------

CREATE TABLE membership_plans (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  name                text NOT NULL,
  description         text,
  duration_unit       text NOT NULL CHECK (duration_unit IN ('day', 'month')),
  duration_value      int NOT NULL CHECK (duration_value > 0),
  price               numeric(12,2) NOT NULL CHECK (price >= 0),
  tax_rate            numeric(5,2) NOT NULL DEFAULT 0,
  benefits            text[] NOT NULL DEFAULT '{}',
  class_access        boolean NOT NULL DEFAULT false,
  pt_access           boolean NOT NULL DEFAULT false,
  facility_access     text[] NOT NULL DEFAULT '{gym}',
  freeze_days_allowed int NOT NULL DEFAULT 0,
  guest_passes        int NOT NULL DEFAULT 0,
  max_discount_pct    numeric(5,2) NOT NULL DEFAULT 0,
  all_branches        boolean NOT NULL DEFAULT true,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plan_branches (
  plan_id   uuid NOT NULL REFERENCES membership_plans(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  PRIMARY KEY (plan_id, branch_id)
);

CREATE TABLE memberships (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        uuid NOT NULL REFERENCES organizations(id),
  member_id              uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  plan_id                uuid NOT NULL REFERENCES membership_plans(id),
  branch_id              uuid NOT NULL REFERENCES branches(id),
  kind                   text NOT NULL CHECK (kind IN ('new', 'renewal', 'upgrade', 'downgrade', 'transfer')),
  -- Stored lifecycle state. Time-derived states (expiring soon / expired) are
  -- computed by effective_membership_status() so they never go stale.
  status                 text NOT NULL CHECK (status IN ('pending', 'active', 'frozen', 'cancelled')),
  start_date             date NOT NULL,
  end_date               date NOT NULL,
  frozen_until           date,
  freeze_days_used       int NOT NULL DEFAULT 0,
  price                  numeric(12,2) NOT NULL,
  discount               numeric(12,2) NOT NULL DEFAULT 0,
  previous_membership_id uuid REFERENCES memberships(id),
  cancelled_at           timestamptz,
  cancel_reason          text,
  created_by             uuid REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);
CREATE INDEX memberships_member_idx ON memberships (member_id, end_date DESC);
CREATE INDEX memberships_end_idx ON memberships (organization_id, end_date);

CREATE TABLE membership_freezes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  membership_id uuid NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  start_date    date NOT NULL,
  end_date      date NOT NULL,
  ended_early_on date,
  reason        text,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION effective_membership_status(
  p_status text, p_end date, p_frozen_until date, p_soon_days int
) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_status IN ('cancelled', 'pending') THEN p_status
    WHEN p_status = 'frozen' AND p_frozen_until >= current_date THEN 'frozen'
    WHEN p_end < current_date THEN 'expired'
    WHEN p_end <= current_date + p_soon_days THEN 'expiring_soon'
    ELSE 'active'
  END
$$;

-- Billing -------------------------------------------------------------------

CREATE TABLE invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  branch_id       uuid NOT NULL REFERENCES branches(id),
  member_id       uuid NOT NULL REFERENCES members(id),
  invoice_number  text NOT NULL,
  issue_date      date NOT NULL DEFAULT current_date,
  due_date        date,
  subtotal        numeric(12,2) NOT NULL,
  discount        numeric(12,2) NOT NULL DEFAULT 0,
  tax             numeric(12,2) NOT NULL DEFAULT 0,
  total           numeric(12,2) NOT NULL,
  amount_paid     numeric(12,2) NOT NULL DEFAULT 0,
  status          text NOT NULL CHECK (status IN ('pending', 'partially_paid', 'paid', 'refunded', 'void')),
  notes           text,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, invoice_number),
  CHECK (amount_paid <= total)
);
CREATE INDEX invoices_member_idx ON invoices (member_id);
CREATE INDEX invoices_status_idx ON invoices (organization_id, status);

CREATE TABLE invoice_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id    uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  item_type     text NOT NULL CHECK (item_type IN ('membership', 'pt', 'class', 'event', 'product', 'other')),
  description   text NOT NULL,
  membership_id uuid REFERENCES memberships(id),
  quantity      int NOT NULL DEFAULT 1,
  unit_price    numeric(12,2) NOT NULL,
  discount      numeric(12,2) NOT NULL DEFAULT 0,
  tax_rate      numeric(5,2) NOT NULL DEFAULT 0,
  tax           numeric(12,2) NOT NULL DEFAULT 0,
  amount        numeric(12,2) NOT NULL
);
CREATE INDEX invoice_items_invoice_idx ON invoice_items (invoice_id);

CREATE TABLE payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  branch_id       uuid NOT NULL REFERENCES branches(id),
  member_id       uuid NOT NULL REFERENCES members(id),
  invoice_id      uuid NOT NULL REFERENCES invoices(id),
  receipt_number  text NOT NULL,
  amount          numeric(12,2) NOT NULL CHECK (amount > 0),
  method          text NOT NULL CHECK (method IN ('cash', 'upi', 'card', 'bank_transfer', 'other')),
  reference       text,
  paid_at         timestamptz NOT NULL DEFAULT now(),
  collected_by    uuid REFERENCES users(id),
  notes           text,
  status          text NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded', 'voided')),
  void_reason     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, receipt_number),
  CHECK (method NOT IN ('upi', 'bank_transfer') OR reference IS NOT NULL)
);
CREATE INDEX payments_paid_at_idx ON payments (organization_id, paid_at DESC);
CREATE INDEX payments_member_idx ON payments (member_id);
CREATE INDEX payments_reference_idx ON payments (reference);

-- Audit & notifications -----------------------------------------------------

CREATE TABLE audit_logs (
  id              bigserial PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  branch_id       uuid REFERENCES branches(id),
  actor_id        uuid REFERENCES users(id),
  action          text NOT NULL,
  entity_type     text NOT NULL,
  entity_id       uuid,
  summary         text NOT NULL,
  before          jsonb,
  after           jsonb,
  ip              text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_org_idx ON audit_logs (organization_id, created_at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id);

CREATE TABLE notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  branch_id       uuid REFERENCES branches(id),
  recipient_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  audience        text NOT NULL DEFAULT 'staff' CHECK (audience IN ('staff', 'member')),
  type            text NOT NULL,
  priority        text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
  title           text NOT NULL,
  body            text,
  entity_type     text,
  entity_id       uuid,
  read_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_recipient_idx ON notifications (organization_id, audience, created_at DESC);

-- Read state for broadcast (recipient_id IS NULL) staff notifications.
CREATE TABLE notification_reads (
  notification_id uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, user_id)
);
