-- Phase 2: leads, pipeline, follow-ups, communication logs, templates, segments.

CREATE TABLE lead_sources (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  name            text NOT NULL,
  is_active       boolean NOT NULL DEFAULT true,
  sort            int NOT NULL DEFAULT 0,
  UNIQUE (organization_id, name)
);

CREATE TABLE leads (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES organizations(id),
  branch_id             uuid NOT NULL REFERENCES branches(id),
  full_name             text NOT NULL,
  phone                 text,
  email                 text,
  gender                text CHECK (gender IN ('male', 'female', 'other')),
  source_id             uuid REFERENCES lead_sources(id),
  referred_by_member_id uuid REFERENCES members(id),
  interested_plan_id    uuid REFERENCES membership_plans(id),
  interested_service    text,
  budget                numeric(12,2),
  goal                  text,
  stage                 text NOT NULL DEFAULT 'new'
                        CHECK (stage IN ('new', 'contacted', 'interested', 'trial_booked', 'trial_completed', 'negotiation', 'won', 'lost')),
  -- Ordering within a pipeline column; fractional so drops never renumber the column.
  position              double precision NOT NULL DEFAULT 0,
  expected_value        numeric(12,2),
  trial_at              timestamptz,
  lost_reason           text,
  assigned_to           uuid REFERENCES users(id),
  last_contacted_at     timestamptz,
  converted_member_id   uuid REFERENCES members(id),
  converted_at          timestamptz,
  notes                 text,
  created_by            uuid REFERENCES users(id),
  stage_changed_at      timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (phone IS NOT NULL OR email IS NOT NULL),
  CHECK (stage <> 'won' OR converted_member_id IS NOT NULL),
  CHECK (stage <> 'lost' OR lost_reason IS NOT NULL)
);
CREATE INDEX leads_pipeline_idx ON leads (organization_id, branch_id, stage, position);
CREATE INDEX leads_assigned_idx ON leads (assigned_to);
CREATE INDEX leads_phone_idx ON leads (organization_id, phone);
CREATE INDEX leads_name_trgm ON leads USING gin (full_name gin_trgm_ops);

CREATE TABLE lead_stage_history (
  id         bigserial PRIMARY KEY,
  lead_id    uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  from_stage text,
  to_stage   text NOT NULL,
  changed_by uuid REFERENCES users(id),
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lead_stage_history_lead_idx ON lead_stage_history (lead_id, changed_at);

-- A follow-up belongs to exactly one lead or one member.
CREATE TABLE follow_ups (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  branch_id       uuid NOT NULL REFERENCES branches(id),
  lead_id         uuid REFERENCES leads(id) ON DELETE CASCADE,
  member_id       uuid REFERENCES members(id) ON DELETE CASCADE,
  type            text NOT NULL CHECK (type IN ('call', 'whatsapp', 'sms', 'email', 'in_person', 'other')),
  purpose         text NOT NULL DEFAULT 'general' CHECK (purpose IN ('general', 'sales', 'trial', 'renewal', 'payment', 'reactivation', 'feedback')),
  due_at          timestamptz NOT NULL,
  assigned_to     uuid REFERENCES users(id),
  notes           text,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'cancelled')),
  outcome         text CHECK (outcome IN ('connected', 'no_answer', 'interested', 'not_interested', 'callback', 'converted', 'renewed', 'paid', 'other')),
  outcome_notes   text,
  completed_at    timestamptz,
  completed_by    uuid REFERENCES users(id),
  auto_generated  boolean NOT NULL DEFAULT false,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((lead_id IS NULL) <> (member_id IS NULL))
);
CREATE INDEX follow_ups_due_idx ON follow_ups (organization_id, status, due_at);
CREATE INDEX follow_ups_assignee_idx ON follow_ups (assigned_to, status, due_at);
CREATE INDEX follow_ups_lead_idx ON follow_ups (lead_id);
CREATE INDEX follow_ups_member_idx ON follow_ups (member_id);

CREATE TABLE message_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  key             text NOT NULL,
  name            text NOT NULL,
  channel         text NOT NULL CHECK (channel IN ('whatsapp', 'sms', 'email', 'any')),
  audience        text NOT NULL DEFAULT 'any' CHECK (audience IN ('lead', 'member', 'any')),
  subject         text,
  body            text NOT NULL,
  is_active       boolean NOT NULL DEFAULT true,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, key)
);

-- Every touchpoint with a lead or member. Phase 2 records staff-initiated
-- contact; provider integrations later write here too (status/provider).
CREATE TABLE communication_logs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  branch_id       uuid NOT NULL REFERENCES branches(id),
  lead_id         uuid REFERENCES leads(id) ON DELETE CASCADE,
  member_id       uuid REFERENCES members(id) ON DELETE CASCADE,
  channel         text NOT NULL CHECK (channel IN ('call', 'whatsapp', 'sms', 'email', 'in_person', 'note')),
  direction       text NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound', 'inbound', 'internal')),
  template_key    text,
  subject         text,
  body            text,
  outcome         text,
  follow_up_id    uuid REFERENCES follow_ups(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'logged' CHECK (status IN ('logged', 'queued', 'sent', 'delivered', 'failed')),
  provider        text,
  logged_by       uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((lead_id IS NULL) <> (member_id IS NULL))
);
CREATE INDEX communication_logs_org_idx ON communication_logs (organization_id, created_at DESC);
CREATE INDEX communication_logs_lead_idx ON communication_logs (lead_id, created_at DESC);
CREATE INDEX communication_logs_member_idx ON communication_logs (member_id, created_at DESC);

CREATE TABLE segments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  name            text NOT NULL,
  description     text,
  rules           jsonb NOT NULL DEFAULT '{}',
  is_system       boolean NOT NULL DEFAULT false,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

-- Permissions for the new modules, granted to the default roles that need them.
INSERT INTO permissions (key, module, description) VALUES
  ('leads.read', 'Leads', 'View leads and the sales pipeline'),
  ('leads.write', 'Leads', 'Create, edit, move and convert leads'),
  ('followups.manage', 'Leads', 'Create and complete follow-ups'),
  ('communications.log', 'Communication', 'Contact members/leads and log communication'),
  ('templates.manage', 'Communication', 'Edit message templates'),
  ('segments.manage', 'Members', 'Create and edit member segments')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key
  FROM roles r
  JOIN (VALUES
    ('super_admin', 'leads.read'), ('super_admin', 'leads.write'), ('super_admin', 'followups.manage'),
    ('super_admin', 'communications.log'), ('super_admin', 'templates.manage'), ('super_admin', 'segments.manage'),
    ('branch_manager', 'leads.read'), ('branch_manager', 'leads.write'), ('branch_manager', 'followups.manage'),
    ('branch_manager', 'communications.log'), ('branch_manager', 'templates.manage'), ('branch_manager', 'segments.manage'),
    ('front_desk', 'leads.read'), ('front_desk', 'leads.write'), ('front_desk', 'followups.manage'), ('front_desk', 'communications.log'),
    ('sales', 'leads.read'), ('sales', 'leads.write'), ('sales', 'followups.manage'), ('sales', 'communications.log'), ('sales', 'segments.manage'),
    ('trainer', 'followups.manage'), ('trainer', 'communications.log'),
    ('nutritionist', 'followups.manage'), ('nutritionist', 'communications.log'),
    ('accountant', 'communications.log')
  ) AS g(role_key, perm) ON g.role_key = r.key
  JOIN permissions p ON p.key = g.perm
ON CONFLICT DO NOTHING;
