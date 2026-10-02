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

## Status: Phase 1 (Core) and Phase 2 (CRM) — complete

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

Phases 3–6 (attendance, classes, PT, fitness, POS, inventory, marketing…)
appear in the sidebar marked `P3`–`P6` so the full product map is visible.
They are not wired to fake data.

Sending through a provider (WhatsApp Business API, SMS gateway, email) is
not connected yet: staff send from their own device and the CRM keeps the
record. `communication_logs` already has `status`/`provider` columns for that.

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
`accounts@forge.fit` (Accountant). Seeded members can sign in to the Member
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
GET /dashboard/pipeline

GET /search?q=         GET /notifications      POST /notifications/read
GET /access/check?code=

GET/POST/PUT /admin/branches|staff|roles      GET /admin/permissions
GET/PUT /admin/organization                   GET /admin/audit-logs

# Member App
GET /me   GET /me/memberships|payments|invoices|notifications   GET /me/invoices/:id/pdf
```

## Layout

```
server/src/
  db/migrations/   SQL schema (001_core, 002_views, 003_crm)
  db/seed.ts       deterministic demo data (~14 months of history)
  lib/             auth, RBAC catalog, audit, errors, helpers
  modules/         auth, members, memberships, billing, dashboard, admin, common, crm (leads, engagement, segments), app (/me)
  jobs/            renewal reminders, follow-up automation
web/src/
  styles/          design tokens (dark + light) and component styles
  components/      UI primitives, charts, app shell
  features/        dashboard, members, memberships, billing, crm, admin, auth
```
