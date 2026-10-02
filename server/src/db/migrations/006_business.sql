-- Phase 5: POS, inventory, expenses, employees, loyalty and referrals.

-- Suppliers & products --------------------------------------------------------

CREATE TABLE suppliers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  name            text NOT NULL,
  contact_name    text,
  phone           text,
  email           text,
  gstin           text,
  notes           text,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE TABLE products (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  sku                 text NOT NULL,
  barcode             text,
  name                text NOT NULL,
  category            text NOT NULL CHECK (category IN ('supplements', 'merchandise', 'food_beverage', 'accessories', 'services')),
  brand               text,
  description         text,
  cost_price          numeric(12,2) NOT NULL DEFAULT 0 CHECK (cost_price >= 0),
  selling_price       numeric(12,2) NOT NULL CHECK (selling_price >= 0),
  tax_rate            numeric(5,2) NOT NULL DEFAULT 0 CHECK (tax_rate >= 0 AND tax_rate <= 40),
  -- Services (towel hire, locker, smoothie made to order…) are sold but not stocked.
  track_stock         boolean NOT NULL DEFAULT true,
  low_stock_threshold int NOT NULL DEFAULT 5 CHECK (low_stock_threshold >= 0),
  supplier_id         uuid REFERENCES suppliers(id),
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, sku)
);
CREATE UNIQUE INDEX products_barcode_uq ON products (organization_id, barcode) WHERE barcode IS NOT NULL;
CREATE INDEX products_name_trgm ON products USING gin (name gin_trgm_ops);

-- Current stock per branch. Only ever changed together with a ledger row.
CREATE TABLE product_stock (
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  branch_id  uuid NOT NULL REFERENCES branches(id),
  quantity   int NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  low_notified_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, branch_id)
);

-- Billing: walk-in sales, product lines, refunds, loyalty redemption ----------

ALTER TABLE invoices ALTER COLUMN member_id DROP NOT NULL;
ALTER TABLE invoices
  ADD COLUMN customer_name   text,
  ADD COLUMN customer_phone  text,
  ADD COLUMN source          text NOT NULL DEFAULT 'crm' CHECK (source IN ('crm', 'pos', 'app')),
  ADD COLUMN points_redeemed int NOT NULL DEFAULT 0 CHECK (points_redeemed >= 0),
  ADD COLUMN points_discount numeric(12,2) NOT NULL DEFAULT 0 CHECK (points_discount >= 0),
  ADD COLUMN amount_refunded numeric(12,2) NOT NULL DEFAULT 0 CHECK (amount_refunded >= 0),
  ADD CONSTRAINT invoices_customer_chk CHECK (member_id IS NOT NULL OR customer_name IS NOT NULL),
  ADD CONSTRAINT invoices_refund_chk CHECK (amount_refunded <= amount_paid);
CREATE INDEX invoices_source_idx ON invoices (organization_id, source, created_at DESC);

ALTER TABLE payments ALTER COLUMN member_id DROP NOT NULL;

ALTER TABLE invoice_items
  ADD COLUMN product_id   uuid REFERENCES products(id),
  ADD COLUMN unit_cost    numeric(12,2),
  ADD COLUMN returned_qty int NOT NULL DEFAULT 0 CHECK (returned_qty >= 0),
  ADD CONSTRAINT invoice_items_returned_chk CHECK (returned_qty <= quantity);
CREATE INDEX invoice_items_product_idx ON invoice_items (product_id) WHERE product_id IS NOT NULL;

CREATE TABLE refunds (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  branch_id       uuid NOT NULL REFERENCES branches(id),
  invoice_id      uuid NOT NULL REFERENCES invoices(id),
  member_id       uuid REFERENCES members(id),
  refund_number   text NOT NULL,
  amount          numeric(12,2) NOT NULL CHECK (amount > 0),
  method          text NOT NULL CHECK (method IN ('cash', 'upi', 'card', 'bank_transfer', 'other')),
  reference       text,
  reason          text NOT NULL,
  items           jsonb NOT NULL DEFAULT '[]',
  restocked       boolean NOT NULL DEFAULT false,
  refunded_by     uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, refund_number)
);
CREATE INDEX refunds_created_idx ON refunds (organization_id, created_at DESC);

-- Stock ledger ----------------------------------------------------------------

CREATE TABLE inventory_transactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  branch_id       uuid NOT NULL REFERENCES branches(id),
  product_id      uuid NOT NULL REFERENCES products(id),
  type            text NOT NULL CHECK (type IN ('stock_in', 'stock_out', 'adjustment', 'damaged', 'sold', 'returned', 'transfer_in', 'transfer_out')),
  quantity        int NOT NULL CHECK (quantity <> 0),   -- signed change
  balance_after   int NOT NULL CHECK (balance_after >= 0),
  unit_cost       numeric(12,2),
  supplier_id     uuid REFERENCES suppliers(id),
  invoice_id      uuid REFERENCES invoices(id),
  refund_id       uuid REFERENCES refunds(id),
  expense_id      uuid,
  transfer_branch_id uuid REFERENCES branches(id),
  reason          text,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inventory_tx_product_idx ON inventory_transactions (product_id, created_at DESC);
CREATE INDEX inventory_tx_org_idx ON inventory_transactions (organization_id, created_at DESC);

-- Expenses --------------------------------------------------------------------

CREATE TABLE expense_categories (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  key             text NOT NULL,
  name            text NOT NULL,
  is_system       boolean NOT NULL DEFAULT false,
  is_active       boolean NOT NULL DEFAULT true,
  sort            int NOT NULL DEFAULT 0,
  UNIQUE (organization_id, key)
);

INSERT INTO expense_categories (organization_id, key, name, is_system, sort)
SELECT o.id, c.key, c.name, true, c.sort
  FROM organizations o
  CROSS JOIN (VALUES ('rent', 'Rent', 1), ('utilities', 'Utilities', 2), ('salaries', 'Salaries', 3), ('maintenance', 'Maintenance', 4),
                     ('marketing', 'Marketing', 5), ('equipment', 'Equipment', 6), ('inventory', 'Inventory', 7), ('other', 'Other', 8)) AS c(key, name, sort)
ON CONFLICT DO NOTHING;

CREATE TABLE expenses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  branch_id       uuid NOT NULL REFERENCES branches(id),
  category_id     uuid NOT NULL REFERENCES expense_categories(id),
  expense_number  text NOT NULL,
  amount          numeric(12,2) NOT NULL CHECK (amount > 0),
  expense_date    date NOT NULL DEFAULT current_date,
  vendor          text,
  supplier_id     uuid REFERENCES suppliers(id),
  employee_id     uuid REFERENCES users(id),
  salary_month    date,
  method          text NOT NULL CHECK (method IN ('cash', 'upi', 'card', 'bank_transfer', 'other')),
  reference       text,
  description     text,
  receipt_key     text UNIQUE,
  receipt_type    text CHECK (receipt_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  receipt_size    int,
  status          text NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded', 'voided')),
  void_reason     text,
  recorded_by     uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, expense_number),
  CHECK (salary_month IS NULL OR employee_id IS NOT NULL)
);
CREATE INDEX expenses_date_idx ON expenses (organization_id, expense_date DESC);
-- One salary payout per employee per month (voided ones don't count).
CREATE UNIQUE INDEX expenses_salary_uq ON expenses (employee_id, salary_month) WHERE salary_month IS NOT NULL AND status = 'recorded';

ALTER TABLE inventory_transactions ADD CONSTRAINT inventory_tx_expense_fk FOREIGN KEY (expense_id) REFERENCES expenses(id);

-- Employees -------------------------------------------------------------------

ALTER TABLE employees
  ADD COLUMN salary_type     text NOT NULL DEFAULT 'monthly' CHECK (salary_type IN ('monthly', 'hourly', 'per_session')),
  ADD COLUMN commission_pct  numeric(5,2) CHECK (commission_pct >= 0 AND commission_pct <= 100),
  ADD COLUMN emergency_contact text,
  ADD COLUMN address         text,
  ADD COLUMN notes           text;

-- Loyalty -----------------------------------------------------------------------

ALTER TABLE organizations ADD COLUMN loyalty_settings jsonb NOT NULL DEFAULT '{
  "enabled": true,
  "pointsPer100": 1,
  "renewalPoints": 200,
  "referralPoints": 500,
  "refereePoints": 200,
  "milestones": [{"visits": 25, "points": 100}, {"visits": 50, "points": 250}, {"visits": 100, "points": 500}, {"visits": 250, "points": 1000}],
  "pointValue": 0.5,
  "minRedeem": 100,
  "maxRedeemPct": 20,
  "autoRewardReferrals": true
}';

CREATE TABLE loyalty_transactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  member_id       uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  branch_id       uuid REFERENCES branches(id),
  reason          text NOT NULL CHECK (reason IN ('purchase', 'renewal', 'referral', 'referral_welcome', 'attendance_milestone', 'event', 'challenge', 'manual', 'redemption', 'reversal')),
  points          int NOT NULL CHECK (points <> 0),
  -- What earned / consumed the points; with reason it makes awards idempotent.
  source_key      text,
  description     text NOT NULL,
  invoice_id      uuid REFERENCES invoices(id),
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX loyalty_tx_member_idx ON loyalty_transactions (member_id, created_at DESC);
CREATE UNIQUE INDEX loyalty_tx_source_uq ON loyalty_transactions (member_id, reason, source_key) WHERE source_key IS NOT NULL;

CREATE VIEW member_loyalty AS
SELECT m.id AS member_id,
       COALESCE(sum(t.points), 0)::int AS balance,
       COALESCE(sum(t.points) FILTER (WHERE t.points > 0 AND t.reason <> 'reversal'), 0)::int AS earned,
       COALESCE(-sum(t.points) FILTER (WHERE t.reason = 'redemption'), 0)::int AS redeemed,
       max(t.created_at) AS last_activity_at
  FROM members m
  LEFT JOIN loyalty_transactions t ON t.member_id = m.id
 GROUP BY m.id;

-- Referrals ---------------------------------------------------------------------

ALTER TABLE members
  ADD COLUMN referral_code text NOT NULL DEFAULT upper(substr(md5(gen_random_uuid()::text), 1, 7)),
  ADD COLUMN referred_by_member_id uuid REFERENCES members(id);
CREATE UNIQUE INDEX members_referral_code_uq ON members (organization_id, referral_code);

CREATE TABLE referrals (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  branch_id           uuid NOT NULL REFERENCES branches(id),
  referrer_member_id  uuid NOT NULL REFERENCES members(id),
  referred_name       text NOT NULL,
  referred_phone      text,
  lead_id             uuid UNIQUE REFERENCES leads(id) ON DELETE SET NULL,
  referred_member_id  uuid UNIQUE REFERENCES members(id),
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'joined', 'verified', 'rewarded', 'rejected')),
  source              text NOT NULL DEFAULT 'crm' CHECK (source IN ('crm', 'app', 'lead', 'member')),
  joined_at           timestamptz,
  verified_at         timestamptz,
  rewarded_at         timestamptz,
  reward_points       int,
  referee_points      int,
  rejected_reason     text,
  created_by          uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (referred_member_id IS NULL OR referred_member_id <> referrer_member_id)
);
CREATE INDEX referrals_referrer_idx ON referrals (referrer_member_id);
CREATE INDEX referrals_status_idx ON referrals (organization_id, status);

-- Existing referred leads become tracked referrals.
INSERT INTO referrals (organization_id, branch_id, referrer_member_id, referred_name, referred_phone, lead_id, referred_member_id, status, source, joined_at, created_at)
SELECT l.organization_id, l.branch_id, l.referred_by_member_id, l.full_name, l.phone, l.id,
       CASE WHEN l.converted_member_id <> l.referred_by_member_id THEN l.converted_member_id END,
       CASE WHEN l.converted_member_id IS NOT NULL AND l.converted_member_id <> l.referred_by_member_id THEN 'joined'
            WHEN l.stage = 'lost' THEN 'rejected' ELSE 'pending' END,
       'lead', l.converted_at, l.created_at
  FROM leads l
 WHERE l.referred_by_member_id IS NOT NULL
ON CONFLICT DO NOTHING;
UPDATE members m SET referred_by_member_id = r.referrer_member_id
  FROM referrals r WHERE r.referred_member_id = m.id AND m.referred_by_member_id IS NULL;

-- Permissions -------------------------------------------------------------------

INSERT INTO permissions (key, module, description) VALUES
  ('pos.sell', 'Sales', 'Sell products and services at the point of sale'),
  ('pos.refund', 'Sales', 'Refund sales and return items'),
  ('inventory.read', 'Inventory', 'View products, stock levels and stock movements'),
  ('inventory.manage', 'Inventory', 'Edit products and suppliers, receive and adjust stock'),
  ('expenses.read', 'Finance', 'View expenses and profit & loss'),
  ('expenses.manage', 'Finance', 'Record and void expenses'),
  ('staff.salary', 'Administration', 'View salaries and record salary payouts'),
  ('loyalty.manage', 'Engagement', 'Award or adjust loyalty points and edit loyalty rules'),
  ('referrals.manage', 'Engagement', 'Record, verify and reward referrals')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, g.perm
  FROM roles r
  JOIN (VALUES
    ('super_admin', 'pos.sell'), ('super_admin', 'pos.refund'), ('super_admin', 'inventory.read'), ('super_admin', 'inventory.manage'),
    ('super_admin', 'expenses.read'), ('super_admin', 'expenses.manage'), ('super_admin', 'staff.salary'), ('super_admin', 'loyalty.manage'), ('super_admin', 'referrals.manage'),
    ('branch_manager', 'pos.sell'), ('branch_manager', 'pos.refund'), ('branch_manager', 'inventory.read'), ('branch_manager', 'inventory.manage'),
    ('branch_manager', 'expenses.read'), ('branch_manager', 'expenses.manage'), ('branch_manager', 'staff.salary'), ('branch_manager', 'loyalty.manage'), ('branch_manager', 'referrals.manage'),
    ('front_desk', 'pos.sell'), ('front_desk', 'inventory.read'), ('front_desk', 'referrals.manage'),
    ('sales', 'pos.sell'), ('sales', 'referrals.manage'),
    ('accountant', 'pos.refund'), ('accountant', 'inventory.read'), ('accountant', 'expenses.read'), ('accountant', 'expenses.manage'), ('accountant', 'staff.salary')
  ) AS g(role_key, perm) ON g.role_key = r.key
ON CONFLICT DO NOTHING;
