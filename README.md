# Forge — Gym Management CRM

The admin operating system for a gym. The CRM and the Member App share **one
backend, one database and one identity per person**. Staff record payments
collected at the desk (cash / UPI / card / bank transfer), and everything that
depends on that payment (invoice, membership status, expiry, revenue, the
member's app) updates in the same database transaction.

```
                 PostgreSQL
                     │
          server/  (Express + TypeScript)
   auth · RBAC · members · memberships · billing · dashboard · audit
          ┌──────────┴──────────┐
     web/ (Admin CRM)      /api/me (Member App)
```

## Status: Phases 1–6 (Core, CRM, Gym operations, Fitness, Business, Advanced) — complete

| Module | Backend | CRM UI |
|---|---|---|
| Authentication (email/phone + password, rotating refresh tokens, sessions) | ✅ | ✅ |
| Users, configurable roles & permissions, branch scoping | ✅ | ✅ |
| Branches (multi-branch from day one) | ✅ | ✅ |
| Members (single canonical identity, app credentials) | ✅ | ✅ |
| Membership plans | ✅ | ✅ |
| Memberships: sell, renew, upgrade/downgrade with pro-rated credit, freeze/unfreeze, extend, cancel | ✅ | ✅ |
| Payments (manual collection, partial payments, void) | ✅ | ✅ |
| Invoices (GST, PDF, print, ad-hoc charges) | ✅ | ✅ |
| Dashboard (KPIs, revenue by service, membership health, renewals needing attention, activity, team) | ✅ | ✅ |
| Audit log (before/after on payments and membership changes) | ✅ | ✅ |
| Notification centre + renewal reminder job | ✅ | ✅ |
| Global search (name, phone, email, member ID, invoice no., UPI/bank ref) | ✅ | ✅ |
| Member App API (`/api/me`) with backend-decided feature access | ✅ | — (app is a separate client) |
| Access-control check (`/api/access/check`) | ✅ | — |

### Phase 2 — CRM

| Module | What it does |
|---|---|
| Leads | Capture with duplicate detection (open leads and existing members by phone/email), sources, referrals, interested plan, budget, goal, owner |
| Pipeline | Kanban board (New → Contacted → Interested → Trial booked → Trial done → Negotiation → Won / Lost) with drag and drop, list view, stage history |
| Conversion | Won = convert: creates the member (or links an existing one), optionally sells the first plan and records payment, in one transaction |
| Follow-ups | For leads or members; overdue / today / upcoming; complete with outcome and schedule the next one |
| Automation | Every new lead gets a first call within the hour; booking a trial schedules a post-trial call; renewal follow-ups are created 7 days before expiry; each staff member gets a daily follow-up digest |
| Communication | Contact composer with templates rendered per person → opens WhatsApp / SMS / email / call on the staff member's device and logs it; full activity log; logging contact moves a new lead to Contacted |
| Segments | Typed rule builder (status, plan, expiry window, lapsed window, lifetime value, dues, PT, classes, referrals, no-contact days, gender, source, age, birthdays) with live counts, CSV export and "Open in Members" |
| Dashboard | New-leads KPI with 90-day conversion, sales pipeline with funnel and top sources, "My follow-ups" |

### Phase 3 — Gym operations

| Module | What it does |
|---|---|
| Front desk | Scan member QR / type member ID or phone → instant allow/deny with reason (expired, frozen, unpaid, wrong branch), auto check-in, manager override with reason (audited), and one-click collect / renew / book class / book PT / sell PT |
| Attendance | Every entry attempt including denials; de-duplicated repeat scans; check-out; live "in the gym now"; daily trend, weekday×hour heatmap, peak hour, inactive members; staff clock-in/out |
| Member app QR | `GET /me/checkin-code` issues a 2-minute signed code the desk scans |
| Classes | Class types, recurring schedules that generate sessions 3 weeks ahead, capacity with automatic waitlist promotion, eligibility (active plan with class access, home branch), session cancellation that notifies members, roster attendance |
| Appointments | PT, assessments, nutrition, trials, consultations; day (per staff) / week / month calendar; click a slot to book; conflict checks against other appointments, classes taught and working hours |
| Personal training | Package catalog; selling a package raises the invoice (same billing/activation rules as memberships); sessions used are derived from completed / no-show appointments; trainer profiles and weekly availability |
| Pipeline link | Booking a trial for a lead moves it to Trial booked; completing it moves it to Trial completed |
| Automation | Sessions generated daily; finished classes closed; members with no visit in 14 days get a win-back follow-up; members are reminded 24h before classes and appointments |
| Segments | New rules: no visit in N days, visits in the last 30 days |

### Phase 4 — Fitness

| Module | What it does |
|---|---|
| Exercise library | Organisation-wide exercises with category, muscles, equipment, cues and an optional demo link; usage count per exercise |
| Workout plans | Templates built once, then copied to a member and tailored. Days with exercises (sets, reps, weight, rest, notes) and reordering. One active plan per member: assigning a new one completes the previous plan. Adherence is logged sessions against prescribed days |
| Workout logs | Members log sessions in the app (`POST /me/workout-logs`); trainers can log on their behalf. Each entry records duration, RPE and notes |
| Nutrition plans | Calorie, macro and water targets, meals with foods and macros, do and avoid lists, restrictions. Live totals against targets and the energy split (4/4/9 kcal per gram) |
| Assessments | Weight, body fat, muscle, BMI (generated column), circumferences, resting HR, BP and fitness tests. Height carries forward. BMR uses Mifflin–St Jeor. Corrections are audited. Recording one completes the linked assessment appointment |
| Progress | Tiles show the change since the first assessment, judged against the member's goal; there are trend charts with a target line, and an assessment history |
| Progress photos | JPEG, PNG or WebP only, checked by magic bytes, 6 MB maximum. Stored outside the web root (`UPLOAD_DIR`) and served only through authorised routes to the member and staff in their branch |
| Member profile | Fitness, Workout and Nutrition tabs (`?tab=` deep links). A fitness profile records goal, level, diet, injuries and the assigned trainer and nutritionist |
| Automation | The trainer is notified 3 days before a member's plan ends, once per plan. Members are notified when their plan is assigned or updated. Members with no assessment within the gym's re-test interval (`assessment_interval_days`, default 60) appear in the "due" list |

### Phase 5 — Business

| Module | What it does |
|---|---|
| POS | Product grid with barcode/SKU scan-to-add, members or walk-in customers, live stock per branch, split payments (up to 3 tenders), cash change, member "on account" balances, loyalty redemption, printable receipt. A sale is a normal invoice + payments, so revenue, receipts, the member's purchase history and the member app all update |
| Returns | Return product lines from a sale (from the till or the invoice): refund is the units' share of what was actually paid (after GST and points), optional restock, purchase points reversed, member notified. Dashboard revenue and P&L are net of refunds |
| Inventory | Products (SKU, barcode, category, cost/price, GST, supplier, low-stock alert), stock per branch, suppliers. Every change goes through one ledger: received, sold, returned, counted, damaged, stock out, transfers between branches. Stock can't go negative; staff are alerted the first time an item falls to its threshold. Receiving stock can book the purchase as an Inventory expense in the same step. Insights: category margin, best sellers, slow movers |
| Expenses | Configurable categories (Rent, Utilities, Salaries, Maintenance, Marketing, Equipment, Inventory, Other + custom), vendor, method/reference, branch, receipt upload (JPEG/PNG/WebP/PDF, magic-byte checked, private storage), void with reason. Cash-basis profit & loss by month with category breakdown and shop gross margin |
| Employees | Profile page per employee: role, branches, HR details, monthly performance computed from what they already do (collections, new sales, renewals, shop sales, leads won, follow-ups, PT sessions, classes, attendees, assessments, shifts and hours) with 6-month trends; team performance table. Salary details and payouts need `staff.salary`; a payout is a Salaries expense tied to the employee and month (one per month) |
| Loyalty | Configurable rules: points per ₹100 paid, renewal bonus, referral rewards, visit milestones, events and challenges (manual awards), point value, minimum and max-% redemption. Points are an append-only ledger, idempotent per source, reversed when a payment is voided or refunded |
| Referrals | Member A refers B (CRM, lead form or member app) → B becomes a lead in the pipeline → B converts → verified on B's first fully paid membership → reward points to A and a welcome bonus to B (automatic or manual). Each member has a referral code; top referrers and conversion are tracked |
| Member app | `/me/loyalty` (balance, value, next milestone, rules, history), `/me/referrals` (code, friends' progress — no contact details), refer a friend |

### Phase 6 — Advanced

| Module | What it does |
|---|---|
| Events | Workshops, competitions, seminars, fitness challenges and special events per branch. Draft → publish (optionally announced in the member app) → registration with capacity and an automatic waitlist (promoted when someone cancels) → attendance → close. Paid events raise an `event` invoice (GST-inclusive price, optional member price) so revenue, receipts and outstanding balances follow normal billing; guests are billed as walk-in customers. Attendance awards loyalty points; cancelling an event notifies registrants, voids unpaid invoices and lists paid ones to refund. Members browse, register and cancel in the app |
| Marketing | Campaigns (membership promotion, renewal, referral, festival offer, birthday, reactivation, lead nurture) to a ready-made audience (expiring, expired, inactive, high-value, new, PT, class…), any saved segment, or leads by stage, per branch, on WhatsApp / SMS / email / app push. Live reach preview per channel, placeholders and offer codes, send now / schedule / stop. Results are measured, not assumed: a recipient converts when they pay (members) or join (leads) within the attribution window; influenced revenue and per-recipient outcomes are shown |
| Communication integrations | One outbox for staff, campaign and automation messages. App push is delivered in-app instantly; WhatsApp/SMS/email go through an HTTPS gateway per channel configured only in the server environment (`MESSAGING_<CHANNEL>_URL/_TOKEN/_PROVIDER`) with retries, or — with no gateway — wait in a manual queue where staff open the pre-filled WhatsApp/SMS/email and tick it off. Promotional messages respect each member's or lead's opt-out (CRM toggle and app preference) and the organisation's quiet hours |
| Automation engine | Configurable rules: trigger (membership expiring / expired, member inactive, birthday, payment overdue, new member, lead not contacted, event upcoming) + parameters → actions (app notification, templated message, follow-up for the assigned staff, staff alert, loyalty points). Runs hourly; an occurrence key makes every firing idempotent. Built-in rules replace the earlier hard-coded jobs (renewal reminders, renewal and lapsed calls, win-back, overdue chase, welcome, first-week check-in, lead speed-to-contact, birthday, event reminder); each can be edited, switched off, previewed, run now, and has a per-firing history. Custom rules can be added |
| Reports | Revenue (trend, by service, method, employee, branch, refunds), Membership (active, new, renewals, lapsed, frozen, cancelled, renewal rate, plan mix), Sales (funnel, sources with conversion and revenue, salespeople, follow-up timeliness), Attendance (trend, peak-hour heatmap, class fill and show-up rates, visit frequency, inactive members), Financial (net revenue, expenses, profit, outstanding by age, refunds). Any range up to two years, buckets by day/week/month, previous-period comparison, CSV export for every table (formula-injection safe) |
| Multi-branch | Every report, campaign, event and automation is branch-scoped by the same rules as the rest of the CRM; revenue by branch compares locations side by side |
| Audit log | Filters by record type, person and date range, field-by-field before/after diff, CSV export (itself audited). Events, campaigns, automations, consent and messaging settings are all audited |

## Run it locally

Requirements: Node 20+, PostgreSQL 14+.

```bash
createdb forge_crm                       # or point DATABASE_URL elsewhere
cp server/.env.example server/.env       # set JWT_SECRET for anything non-local
npm run setup                            # installs server/ and web/
npm run db:seed                          # migrates + loads demo data (safe to re-run: only fills missing modules)
npm run dev:server                       # API on :4000 (runs migrations on boot)
npm run dev:web                          # CRM on :5173 (proxies /api)
```

Demo staff logins (password `Forge@2026`): `admin@forge.fit` (Super Admin),
`meera@forge.fit` (Branch Manager), `sneha@forge.fit` (Front Desk),
`accounts@forge.fit` (Accountant), `rohan@forge.fit` (Trainer). Seeded members can sign in to the Member
App API with their phone/email and `Member@2026`.

## Key design decisions

- **One identity.** `users` holds staff and members (`kind`); `members` is the
  member profile hanging off that user. The CRM and the Member App never keep
  separate member records.
- **Status is computed, not stored stale.** Memberships store lifecycle state
  (`pending / active / frozen / cancelled`). "Expiring soon" and "expired" are
  derived by `effective_membership_status()` and the `member_current_membership`
  view, so the dashboard, CRM, Member App and access control all agree.
- **Payments are atomic.** `recordPayment` locks the invoice, records the
  payment, updates the balance and status, activates pending memberships,
  writes the audit log and member notifications, all in one transaction.
  UPI and bank transfers require a reference number.
- **Activation rule.** A membership goes live as soon as *any* amount is
  collected against its invoice; the remainder shows as outstanding. Voiding
  every payment on an invoice returns its membership to "payment pending".
- **Permissions live in the database.** The permission catalog is in
  `server/src/lib/permissions.ts`; role assignments are edited in Roles &
  Permissions and enforced by every API route. Staff can't grant roles with
  more access than their own.
- **Branch scoping.** Every query is filtered to the caller's branches. The
  CRM's branch selector sends `X-Branch-Id`, which can narrow but never widen
  access.

## API overview

All routes are under `/api`. Errors are `{ error: { code, message, details? } }`,
lists are `{ data, pagination }`.

```
POST /auth/login {identifier, password, client: crm|app}   POST /auth/refresh   POST /auth/logout
GET  /auth/me                                               POST /auth/change-password

GET/POST /members      GET/PATCH /members/:id      GET /members/:id/memberships|activity
POST /members/:id/credentials                     PATCH /members/:id/app-access

GET/POST /plans        PUT /plans/:id
GET/POST /memberships  POST /memberships/:id/freeze|unfreeze|extend|cancel

GET/POST /payments     POST /payments/:id/void
GET/POST /invoices     GET /invoices/:id      GET /invoices/:id/pdf

GET /dashboard/summary|revenue?days=|membership-health|attention|activity|staff
GET /leads/board   GET/POST /leads   GET/PATCH /leads/:id   POST /leads/:id/move|convert|reopen
GET /leads/sources|duplicates
GET/POST /follow-ups   GET /follow-ups/summary   POST /follow-ups/:id/complete|cancel   PATCH /follow-ups/:id
GET/POST /communications   GET /communications/stats
GET/POST /templates   PUT /templates/:id   GET /templates/compose?leadId|memberId&templateKey
GET/POST /segments   PUT/DELETE /segments/:id   POST /segments/preview   GET /segments/:id/members|export
GET /dashboard/pipeline|today

POST /attendance/check-in   POST /attendance/:id/check-out   GET /attendance|live|analytics|lookup
GET /attendance/staff   POST /attendance/staff/clock
GET/POST /classes/types|schedules   PUT /classes/types/:id|schedules/:id
GET/POST /classes/sessions   GET/PATCH /classes/sessions/:id   POST /classes/sessions/:id/cancel|bookings
POST /classes/bookings/:id/cancel|attendance
GET/POST /appointments   PATCH /appointments/:id   POST /appointments/:id/complete|cancel   GET /appointments/staff|availability
GET/POST /pt/packages   PUT /pt/packages/:id   GET/POST /pt/member-packages   PATCH /pt/member-packages/:id   POST /pt/member-packages/:id/cancel
GET /pt/trainers   PUT /pt/trainers/:id

GET/POST /fitness/exercises   PUT /fitness/exercises/:id   GET /fitness/overview?mine
GET/POST /fitness/workout-plans|nutrition-plans   GET/PUT /fitness/{kind}-plans/:id
POST /fitness/{kind}-plans/:id/assign|save-as-template|status   POST /fitness/workout-plans/:id/logs
GET /fitness/members/:id/summary   PUT /fitness/members/:id/profile
GET/POST /fitness/assessments   PUT /fitness/assessments/:id
POST /fitness/members/:id/photos?angle=  (raw image body)   GET/DELETE /fitness/photos/:id

GET /pos/catalog   POST /pos/sales   GET /pos/sales|summary   POST /pos/sales/:id/refund
GET/POST /inventory/products   GET/PUT /inventory/products/:id   GET/POST /inventory/movements
GET /inventory/summary   GET/POST /inventory/suppliers   PUT /inventory/suppliers/:id
GET/POST /expenses   POST /expenses/:id/void   GET/POST /expenses/:id/receipt (raw body)
GET/POST /expenses/categories   PUT /expenses/categories/:id   GET /expenses/pnl?months=
GET /employees/performance?month=   GET /employees/:id   PUT /employees/:id/hr   POST /employees/:id/salary
GET/PUT /loyalty/settings   GET /loyalty/summary|transactions   GET /loyalty/members/:id   POST /loyalty/award
GET/POST /referrals   GET /referrals/summary   POST /referrals/:id/verify|reward|reject

GET/POST /events   GET /events/summary   GET/PUT /events/:id   POST /events/:id/publish|cancel|complete
POST /events/:id/registrations   POST /events/registrations/:id/cancel|attendance
GET/POST /campaigns   GET /campaigns/meta|summary   POST /campaigns/preview   GET/PUT /campaigns/:id
POST /campaigns/:id/send|schedule|cancel|duplicate
GET /messaging/integrations   PUT /messaging/settings   POST /messaging/test   POST /messaging/consent
GET /messaging/outbox   POST /messaging/outbox/mark-sent|discard|retry
GET/POST /automations   GET /automations/meta   PUT/DELETE /automations/:id   POST /automations/:id/preview|run   GET /automations/:id/runs
GET /reports/revenue|membership|sales|attendance|financial?from&to[&format=csv&table=]
GET /admin/audit-logs?search&entityType&action&actorId&from&to[&format=csv]   GET /admin/audit-logs/facets

GET /search?q=         GET /notifications      POST /notifications/read
GET /access/check?code=

GET/POST/PUT /admin/branches|staff|roles      GET /admin/permissions
GET/PUT /admin/organization                   GET /admin/audit-logs

# Member App
GET /me   GET /me/memberships|payments|invoices|notifications|attendance|classes|pt|appointments|checkin-code
GET /me/invoices/:id/pdf   POST /me/classes/:sessionId/book   POST /me/bookings/:id/cancel
GET /me/workout|nutrition|progress   POST /me/workout-logs   POST /me/photos   GET /me/photos/:id
GET /me/loyalty   GET/POST /me/referrals
GET /me/events   POST /me/events/:id/register   POST /me/events/registrations/:id/cancel   PUT /me/preferences
```

## Layout

```
server/src/
  db/migrations/   SQL schema (001_core, 002_views, 003_crm, 004_ops)
  db/seed.ts       deterministic demo data (~14 months of history)
  lib/             auth, RBAC catalog, audit, errors, helpers
  modules/         auth, members, memberships, billing, dashboard, admin, common, crm (leads, engagement, segments), ops (attendance, classes, appointments + PT), app (/me)
  jobs/            renewal reminders, follow-up and operations automation
web/src/
  styles/          design tokens (dark + light) and component styles
  components/      UI primitives, charts, app shell
  features/        dashboard, members, memberships, billing, crm, ops, admin, auth
```
