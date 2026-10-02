-- Phase 6: events, marketing campaigns, messaging integrations, automation engine.

-- Events --------------------------------------------------------------------------

CREATE TABLE events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id),
  branch_id          uuid NOT NULL REFERENCES branches(id),
  title              text NOT NULL,
  type               text NOT NULL CHECK (type IN ('workshop', 'competition', 'seminar', 'challenge', 'special')),
  description        text,
  starts_at          timestamptz NOT NULL,
  ends_at            timestamptz NOT NULL,
  location           text,
  capacity           int CHECK (capacity IS NULL OR capacity > 0),
  price              numeric(12,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  member_price       numeric(12,2) CHECK (member_price IS NULL OR member_price >= 0),
  tax_rate           numeric(5,2) NOT NULL DEFAULT 18 CHECK (tax_rate >= 0 AND tax_rate <= 40),
  allow_guests       boolean NOT NULL DEFAULT true,
  registration_closes_at timestamptz,
  attendance_points  int NOT NULL DEFAULT 0 CHECK (attendance_points >= 0),
  host_id            uuid REFERENCES users(id),
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'cancelled', 'completed')),
  cancel_reason      text,
  reminder_sent_at   timestamptz,
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX events_time_idx ON events (organization_id, starts_at);

CREATE TABLE event_registrations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  event_id        uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  member_id       uuid REFERENCES members(id) ON DELETE CASCADE,
  guest_name      text,
  guest_phone     text,
  status          text NOT NULL CHECK (status IN ('registered', 'waitlisted', 'cancelled', 'attended', 'no_show')),
  invoice_id      uuid REFERENCES invoices(id),
  source          text NOT NULL DEFAULT 'crm' CHECK (source IN ('crm', 'app')),
  registered_by   uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  cancelled_at    timestamptz,
  attended_at     timestamptz,
  promoted_at     timestamptz,
  CHECK (member_id IS NOT NULL OR guest_name IS NOT NULL)
);
CREATE UNIQUE INDEX event_registrations_member_uq ON event_registrations (event_id, member_id) WHERE member_id IS NOT NULL AND status <> 'cancelled';
CREATE INDEX event_registrations_event_idx ON event_registrations (event_id, created_at);
ALTER TABLE invoice_items ADD COLUMN event_registration_id uuid REFERENCES event_registrations(id);

-- Messaging: one outbox for every channel ----------------------------------------

ALTER TABLE communication_logs DROP CONSTRAINT communication_logs_channel_check;
ALTER TABLE communication_logs ADD CONSTRAINT communication_logs_channel_check
  CHECK (channel IN ('call', 'whatsapp', 'sms', 'email', 'push', 'in_person', 'note'));
ALTER TABLE communication_logs
  ADD COLUMN recipient     text,
  ADD COLUMN campaign_id   uuid,
  ADD COLUMN automation_rule_id uuid,
  ADD COLUMN promotional   boolean NOT NULL DEFAULT false,
  ADD COLUMN attempts      int NOT NULL DEFAULT 0,
  ADD COLUMN error         text,
  ADD COLUMN external_id   text,
  ADD COLUMN sent_at       timestamptz;
CREATE INDEX communication_logs_outbox_idx ON communication_logs (status, created_at) WHERE status = 'queued';

ALTER TABLE message_templates DROP CONSTRAINT message_templates_channel_check;
ALTER TABLE message_templates ADD CONSTRAINT message_templates_channel_check CHECK (channel IN ('whatsapp', 'sms', 'email', 'push', 'any'));

-- Consent for promotional messages; service messages (receipts, reminders) still go out.
ALTER TABLE members ADD COLUMN marketing_opt_out boolean NOT NULL DEFAULT false;
ALTER TABLE leads ADD COLUMN marketing_opt_out boolean NOT NULL DEFAULT false;

ALTER TABLE organizations ADD COLUMN messaging_settings jsonb NOT NULL DEFAULT '{"quietStart": 21, "quietEnd": 8, "senderName": null}';

-- Marketing -------------------------------------------------------------------------

CREATE TABLE campaigns (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  name             text NOT NULL,
  type             text NOT NULL CHECK (type IN ('membership_promotion', 'renewal', 'referral', 'festival_offer', 'birthday', 'reactivation', 'lead')),
  -- {kind: 'segment', segmentId} | {kind: 'preset', key} | {kind: 'leads', stages, sourceIds}
  audience         jsonb NOT NULL,
  branch_ids       uuid[] NOT NULL,
  channels         text[] NOT NULL CHECK (channels <@ ARRAY['whatsapp', 'sms', 'email', 'push']::text[] AND cardinality(channels) > 0),
  subject          text,
  body             text NOT NULL,
  offer_code       text,
  offer_valid_until date,
  attribution_days int NOT NULL DEFAULT 14 CHECK (attribution_days BETWEEN 1 AND 90),
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'cancelled')),
  scheduled_at     timestamptz,
  sent_at          timestamptz,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX campaigns_org_idx ON campaigns (organization_id, created_at DESC);

CREATE TABLE campaign_recipients (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id    uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  member_id      uuid REFERENCES members(id) ON DELETE CASCADE,
  lead_id        uuid REFERENCES leads(id) ON DELETE CASCADE,
  channel        text NOT NULL,
  status         text NOT NULL CHECK (status IN ('queued', 'sent', 'delivered', 'failed', 'skipped')),
  skip_reason    text,
  communication_log_id uuid REFERENCES communication_logs(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((member_id IS NULL) <> (lead_id IS NULL))
);
CREATE INDEX campaign_recipients_campaign_idx ON campaign_recipients (campaign_id);
CREATE INDEX campaign_recipients_member_idx ON campaign_recipients (member_id);
ALTER TABLE communication_logs ADD CONSTRAINT communication_logs_campaign_fk FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL;

-- Automation engine -----------------------------------------------------------------

CREATE TABLE automation_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  key             text NOT NULL,
  name            text NOT NULL,
  description     text,
  trigger         text NOT NULL CHECK (trigger IN ('membership_expiring', 'membership_expired', 'member_inactive', 'birthday', 'payment_overdue', 'member_joined', 'lead_uncontacted', 'event_upcoming')),
  params          jsonb NOT NULL DEFAULT '{}',
  actions         jsonb NOT NULL DEFAULT '[]',
  promotional     boolean NOT NULL DEFAULT false,
  enabled         boolean NOT NULL DEFAULT true,
  is_system       boolean NOT NULL DEFAULT false,
  last_run_at     timestamptz,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, key)
);
ALTER TABLE communication_logs ADD CONSTRAINT communication_logs_rule_fk FOREIGN KEY (automation_rule_id) REFERENCES automation_rules(id) ON DELETE SET NULL;

-- One row per rule firing for one subject; the unique key makes runs idempotent.
CREATE TABLE automation_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id         uuid NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  branch_id       uuid REFERENCES branches(id),
  member_id       uuid REFERENCES members(id) ON DELETE CASCADE,
  lead_id         uuid REFERENCES leads(id) ON DELETE CASCADE,
  occurrence_key  text NOT NULL,
  results         jsonb NOT NULL DEFAULT '[]',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_id, occurrence_key)
);
CREATE INDEX automation_runs_rule_idx ON automation_runs (rule_id, created_at DESC);

-- Permissions -----------------------------------------------------------------------

INSERT INTO permissions (key, module, description) VALUES
  ('events.read', 'Events', 'View events and participant lists'),
  ('events.manage', 'Events', 'Create events, register participants and mark attendance'),
  ('marketing.read', 'Marketing', 'View campaigns and their results'),
  ('marketing.manage', 'Marketing', 'Create, schedule and send campaigns'),
  ('automations.manage', 'Administration', 'Edit automation rules and messaging integrations')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, g.perm
  FROM roles r
  JOIN (VALUES
    ('super_admin', 'events.read'), ('super_admin', 'events.manage'), ('super_admin', 'marketing.read'), ('super_admin', 'marketing.manage'), ('super_admin', 'automations.manage'),
    ('branch_manager', 'events.read'), ('branch_manager', 'events.manage'), ('branch_manager', 'marketing.read'), ('branch_manager', 'marketing.manage'),
    ('front_desk', 'events.read'), ('front_desk', 'events.manage'),
    ('sales', 'events.read'), ('sales', 'marketing.read'), ('sales', 'marketing.manage'),
    ('trainer', 'events.read'), ('trainer', 'events.manage'),
    ('nutritionist', 'events.read'),
    ('accountant', 'events.read'), ('accountant', 'marketing.read')
  ) AS g(role_key, perm) ON g.role_key = r.key
ON CONFLICT DO NOTHING;
