# MIO Doctors — Platform Architecture

Status: **Phase 2 (architecture) — for review before implementation.**
Sources: the three PDFs (Login as MR / Doctor / Receptionist), the existing Flutter
front end in `E:\Mio-pharma-app`, and the product decisions made so far
(doctor-owned receptionist access, dev-mode OTP, mock payments).

---

## 1. System overview

```
Flutter app (MR · Doctor · Receptionist)      React Admin Panel (Admin)
            │  HTTPS / JSON                             │
            └──────────────► Express REST API (/api/v1) ◄┘
                               │  routes → validators → controllers → services
                               ▼
                         MongoDB (Mongoose)
```

| Part | Tech | Folder |
|---|---|---|
| API | Node 24, Express 4, Mongoose 8, Zod, JWT, bcrypt, helmet, cors, express-rate-limit, pino | `backend/` |
| Admin panel | React 18 + Vite + TypeScript, React Router, TanStack Query, React Hook Form + Zod | `admin/` (phase 4) |
| Mobile app | Flutter 3.47 (existing) + `dio` + `flutter_secure_storage` | `lib/` |

Why Express 4 (not 5): stable ecosystem support for the security middleware
used here; nothing in the requirements needs Express 5.

---

## 2. Roles

| Role | How the account exists | Login |
|---|---|---|
| **MR** | Self-registers (mobile → OTP → MR Registration) | Mobile + OTP |
| **Doctor** | Self-registers (mobile → OTP → Doctor + Final Registration) | Mobile + OTP |
| **Receptionist** | Only after a **doctor** grants access (or approves a request) | Mobile + OTP (blocked until an active grant exists) |
| **Admin** | Seeded / created by another admin | Email + password (bcrypt) |

Role is always read from the server-side user record, never from the client.

---

## 3. Permission matrix

`✓` allowed · `own` only own records · `grant:x` receptionist needs permission *x*
from **that appointment's doctor** · `—` denied.

| Capability | MR | Doctor | Receptionist | Admin |
|---|---|---|---|---|
| Own profile read/update | ✓ | ✓ | ✓ | ✓ |
| Delete own account | ✓ | ✓ | ✓ | — |
| Browse doctors (Master MCL) | ✓ | — | — | ✓ |
| My MCL add/remove | own | — | — | ✓ |
| Book appointment with a doctor | ✓ (as visitor) | own calendar | grant:book | ✓ |
| List appointments | own visits | own | grant:view (all granting doctors) | ✓ |
| Approve / reject pending visit | — | own | grant:reschedule* | ✓ |
| Reschedule | own (pending/approved) | own | grant:reschedule | ✓ |
| Cancel | own | own | grant:cancel | ✓ |
| Mark completed | — | own | grant:reschedule* | ✓ |
| Set availability (auto/manual/unavailable) | — | own | — | ✓ |
| Manage receptionist access | — | own grants | — | ✓ |
| Conferences: view / set participation | — | ✓ | — | manage |
| Birthday wishes: send | ✓ | — | — | ✓ |
| Birthday wishes: view received | — | own | — | ✓ |
| Reports (generate / download) | own scope | own scope | granted doctors | all |
| Subscription purchase | ✓ | lifetime free claim | — | manage plans |
| Help tickets | ✓ | ✓ | ✓ | manage |
| FAQs / Terms (read) | ✓ | ✓ | ✓ | manage |
| Users, audit logs, settings | — | — | — | ✓ |

\* Assumption: status changes other than cancel are grouped under `reschedule`
("manage schedule"). Documented in §12.

Receptionist permissions per grant: `view` (always on) · `book` · `reschedule` · `cancel`.
Grant status: `pending` · `active` · `inactive`.

---

## 4. Key user journeys

1. **Doctor onboarding:** role → splash → mobile → OTP → Doctor Registration → Final Registration → Lifetime Free subscription → Home.
2. **MR onboarding:** role → splash → mobile → OTP → MR Registration → Subscription → Payment (mock) → Home.
3. **Receptionist access:**
   - Doctor → Receptionist Access → *Add* (name, mobile, permissions) → grant `active` → receptionist can log in.
   - Receptionist → mobile → **Send Request** → no active grant → `pending` request routed to every doctor whose Final Registration lists this receptionist mobile (fallback: visible to admins) → doctor approves/rejects.
4. **MR booking:** Master MCL → My MCL → Book (date + slot) → appointment `pending` → doctor/receptionist approves → `approved` → visit → `completed`.
5. **Receptionist scheduling:** Home lists appointments of every granting doctor → filter doctor → book / reschedule / cancel within that doctor's permissions.
6. **Delete account:** confirmation screen → soft delete + anonymise PII + revoke tokens + revoke receptionist grants (as doctor or receptionist).

---

## 5. Data model (MongoDB)

All collections: `timestamps: true`. Soft delete where noted (`deletedAt`).
Monetary values in paise (integers).

| Collection | Key fields | Indexes |
|---|---|---|
| `users` | role, name, mobile, email (admin), passwordHash (admin), photoUrl, status (`active`/`inactive`/`deleted`), tokenVersion, lastLoginAt, deletedAt | unique mobile (partial: not deleted), unique email (partial), role+status |
| `doctorprofiles` | user, code (`DR#####`), qualification, gender, dob, dom, maritalStatus, specialty, religion, councilRegNo, hprId, practice{type, clinicName, preferredPlace, address, city, state, district, zone, pincode, hometown, locationType, territoryClass, gpsLink}, mrCall{days[], from, to, maxPerDay, companyTypes[]}, contacts{receptionistName, receptionistMobile, pharmacyName, pharmacistName, pharmacistMobile}, consultation{days[], from, to, fee, avgPatients}, referralMobile, social{}, availability (`auto`/`manual`/`unavailable`) | unique user, unique code, specialty, practice.city, contacts.receptionistMobile |
| `mrprofiles` | user, code (`MR#####`), qualification, gender, dob, maritalStatus, company{name, type, address}, employerStatus, lastWorkingDate, employeeCode, officialEmail, joiningDate, specialty, division, hq{name, class, city, district, state, zone}, referralMobile, social{} | unique user, unique code |
| `receptionistprofiles` | user, code (`RC#####`), qualification, gender, dob, maritalStatus, email, religion, practice{…} | unique user |
| `receptionistaccesses` | doctor, receptionist, status, permissions[], requestedAt, grantedBy, grantedAt, revokedAt | **unique (doctor, receptionist)**, receptionist+status |
| `otpcodes` | mobile, purpose, codeHash (HMAC-SHA256), attempts, expiresAt | mobile+purpose, **TTL on expiresAt** |
| `refreshtokens` | user, tokenHash, family, expiresAt, revokedAt, userAgent, ip | tokenHash unique, **TTL** |
| `appointments` | doctor, mr (optional), visitor{name, company, division}, startAt, endAt, slotLabel, status (`pending`/`approved`/`cancelled`/`completed`), purpose, note, createdBy{user, role}, cancel{by, role, reason, at}, history[{action, by, role, at, from, to}] | doctor+startAt, mr+startAt, **partial unique (doctor, startAt) where status ∈ {pending, approved}** → no double booking |
| `mclentries` | mr, doctor | unique (mr, doctor) |
| `conferences` | title, specialty, venue, city, startDate, endDate, logoUrl, status | startDate |
| `conferenceparticipations` | conference, doctor, status (`planning`/`registered`/`need_info`) | unique (conference, doctor) |
| `wishes` | fromUser (MR), toDoctor, message, readAt | toDoctor+createdAt |
| `notifications` | user, type, title, body, data{}, readAt | user+readAt+createdAt |
| `plans` | code, name, role, period (`monthly`/`yearly`/`lifetime`), pricePaise, mrpPaise, features[], active | unique code |
| `subscriptions` | user, plan, status (`active`/`expired`/`cancelled`), startAt, endAt, payment{provider:`mock`, orderId, amountPaise, taxPaise, status, paidAt} | user+status |
| `helptickets` | user, category, message, status (`open`/`in_progress`/`resolved`), adminNote | status+createdAt |
| `faqs` | question, answer, audience[roles], order, active | order |
| `settings` | key, value (terms of service, terms of agreement, support email/WhatsApp, report types, company types, specialties…) | unique key |
| `auditlogs` | actor{user, role}, action, module, entityType, entityId, before, after, ip, userAgent | createdAt, entityType+entityId, actor.user |

Not created: **Patient** — none of the PDFs has patient screens or data (the app
schedules *MR visits* with doctors). Can be added later if the scope changes.

Reports are computed with aggregation pipelines over `appointments` (no report
collection); downloads are generated as CSV on demand.

---

## 6. API design

Base: `/api/v1`. JSON only. Consistent envelope:

```json
{ "success": true, "data": { }, "meta": { "page": 1, "limit": 20, "total": 134 } }
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "…", "details": [ ] } }
```

Status codes: 200/201/204 · 400 validation · 401 unauthenticated · 403 forbidden ·
404 not found · 409 conflict (e.g. slot taken) · 422 business rule · 429 rate limited · 500.

Lists: `?page=&limit=&sort=&q=` + resource filters, server-side only.

| Module | Endpoints (abridged) |
|---|---|
| Auth | `POST /auth/otp/request` {mobile, role} · `POST /auth/otp/verify` {mobile, role, otp} → tokens · `POST /auth/refresh` · `POST /auth/logout` · `POST /auth/admin/login` |
| Me | `GET /me` · `PATCH /me` · `DELETE /me` (delete account) |
| Registration | `PUT /doctors/me/profile` · `PUT /doctors/me/final` · `PUT /mrs/me/profile` · `PUT /receptionists/me/profile` · `POST /uploads/photo` |
| Doctors | `GET /doctors` (Master MCL: q, specialty, place, city) · `GET /doctors/:id` · `PATCH /doctors/me/availability` · `GET /doctors/:id/slots?date=` |
| MCL (MR) | `GET /mrs/me/mcl` · `PUT /mrs/me/mcl/:doctorId` · `DELETE /mrs/me/mcl/:doctorId` · `GET /doctors` returns `inMcl` |
| Receptionist access (doctor) | `GET /doctors/me/receptionists` · `POST /doctors/me/receptionists` · `PATCH /doctors/me/receptionists/:id` {status, permissions} · `DELETE /doctors/me/receptionists/:id` |
| Receptionist | `POST /auth/receptionist/request` {mobile} → `granted` / `pending` / `blocked` · `GET /receptionists/me/doctors` |
| Appointments | `GET /appointments?doctorId=&status=&from=&to=` · `POST /appointments` · `GET /appointments/:id` · `POST /appointments/:id/approve` · `/reject` · `/reschedule` {startAt} · `/cancel` {reason} · `/complete` |
| Conferences | `GET /conferences?when=&specialty=` (doctor: `myStatus` + `meta.summary`) · `GET /conferences/:id` · `PUT/DELETE /conferences/:id/participation` {status: planning/registered/more_info} · admin `POST /conferences` · `PATCH /conferences/:id` |
| Birthdays & wishes | MR: `GET /birthdays?range=all\|week\|month` · `GET /birthdays/:doctorId/wishes` · `POST /birthdays/:doctorId/wishes` {message} · `DELETE /wishes/:id` (own) — doctor: `GET /wishes/received` · `POST /wishes/:id/hide` · `/unhide` |
| Notifications | `GET /notifications?unread=` (`meta.unread`) · `GET /notifications/unread-count` · `POST /notifications/:id/read` · `POST /notifications/read-all` |
| Reports | `GET /reports/filters` · `GET /reports/summary` · `GET /reports/:type?from=&to=&company=&doctorId=&mrId=&specialty=&city=&format=json\|csv` |
| Subscriptions | `GET /plans` (own role; admin `PUT /plans` upsert) · `POST /subscriptions/checkout` {planCode, method} → server-priced order · `POST /subscriptions/orders/:id/confirm` (provider payload; mock: `{simulate}`) · `GET /subscriptions/me` · `POST /subscriptions/claim-free` {planCode} · `/me` includes `subscription` |
| Support | `GET /support` (topics + contacts; admin `PUT`) · `POST/GET /help-tickets` · `GET /help-tickets/:id` · `POST /help-tickets/:id/replies` · admin `PATCH /help-tickets/:id` {status} · public `GET /faqs?role=` (admin POST/PATCH/DELETE) · public `GET /content/:key` (admin `PUT`, versioned) · `PATCH /me/settings` {notifications, language} |
| Admin | `GET /admin/dashboard` · `GET /admin/users?role=&status=&q=` · `GET /admin/users/:id` · `PATCH /admin/users/:id/status` · `GET/PATCH /admin/receptionist-access` · `GET /admin/plans` · `GET /admin/orders` · `GET /admin/subscriptions` · `GET /admin/faqs` · `GET /admin/settings/support` · `GET /admin/audit-logs` — plus the admin verbs on shared routes (`/appointments`, `/conferences`, `/plans`, `/help-tickets`, `/faqs`, `/content`, `/support`) |

---

## 7. Authentication & authorization

- **OTP:** 4 digits (per PDF), HMAC-SHA256 hashed with a server pepper, 5-minute
  expiry, max 5 attempts, resend after 45 s (matches the app timer), rate limited
  per mobile and per IP. `OTP_DEV_MODE=true` returns the code in the response
  (never in production). SMS goes through an `SmsProvider` interface; a real
  provider is added later without touching auth logic.
- **Tokens:** access JWT (15 min; `sub`, `role`, `tv` = tokenVersion) + refresh
  token (random 256-bit, stored hashed, 30 days, **rotated on every use**, reuse of
  a rotated token revokes the whole family). Logout revokes the refresh token;
  delete account / admin deactivation bumps `tokenVersion` so all access tokens die.
- **Middleware chain:** `authenticate` (verify JWT, load user, check status +
  tokenVersion) → `requireRole(...)` → resource guard in the service
  (`assertCanAccessAppointment(user, appointment, permission)`), which checks the
  receptionist grant **at request time** so deactivation is immediate.
- **Admin:** email + bcrypt (cost 12) password, separate login route, same token model.

---

## 8. Security

helmet · strict CORS allow-list from env · `express-rate-limit` (auth: tight,
API: moderate) · request size limits · Zod validation on every body/query/param
(unknown keys stripped → no mass assignment) · `express-mongo-sanitize` against
operator injection · pino logger with redaction of `authorization`, `otp`,
`password`, `mobile` · no stack traces in responses outside development ·
secrets only from `.env` (`.env.example` committed, `.env` git-ignored) ·
uploads: image MIME + size (2 MB, per PDF) checks, random file names.

---

## 9. Appointment rules (server-enforced)

- Slot must be in the future, inside the doctor's configured MR call days/hours,
  and the doctor must not be `unavailable`.
- One active appointment per doctor per slot — enforced by the partial unique
  index (race-safe), surfaced as `409 SLOT_TAKEN`.
- Daily cap = doctor's `mrCall.maxPerDay`.
- Transitions: `pending → approved | cancelled`, `approved → completed | cancelled`,
  reschedule allowed from `pending | approved` (returns to `approved` when done by
  doctor/receptionist, `pending` when done by the MR). Everything else → `422`.
- Every transition appends to `history` and writes an audit log.

---

## 10. Audit trail

`AuditService.record({actor, action, module, entityType, entityId, before, after, req})`
called from services for: receptionist grant/approve/deactivate/permissions/remove,
appointment create/approve/reject/reschedule/cancel/complete, profile updates,
account deletion, admin user/plan/settings changes, admin logins. Readable only by
admins (`/admin/audit-logs`, filterable, paginated). PII in `before/after` is limited
to changed fields.

---

## 11. Project structure

```
backend/
  src/
    config/        env (validated with Zod), db, logger
    middlewares/   authenticate, requireRole, validate, rateLimit, error, notFound
    modules/
      auth/        routes · controller · service · validators · otp.service · token.service · sms.provider
      users/ doctors/ mrs/ receptionists/ access/ appointments/ mcl/
      conferences/ wishes/ notifications/ reports/ subscriptions/ support/ admin/ audit/
        each: *.model.js · *.service.js · *.controller.js · *.routes.js · *.validators.js
    utils/         ApiError, asyncHandler, response, pagination, codes
    app.js         express app (no listen) → testable
    server.js      listen + graceful shutdown
  scripts/         seed.js (plans, FAQs, settings, admin, demo data)
  tests/           Jest + Supertest + mongodb-memory-server
  .env.example
```

Flutter: `lib/core/network/` (dio client, auth interceptor with refresh,
`ApiException`), `lib/data/repositories/` (one per module), existing screens
switched from `SampleData` to repositories with loading / error / empty states.

---

## 12. Assumptions & open points

1. **Receptionist request routing:** a pending request goes to doctors whose Final
   Registration lists that receptionist mobile; otherwise admins can route it.
2. **Status-change permission:** approve/reject/complete by a receptionist uses the
   `reschedule` permission (no separate permission exists in any design).
3. **Patients:** not modelled — no PDF screen uses them.
4. **Reports:** the PDFs show report titles and filters only; contents are defined
   here as appointment/visit aggregates per the titles, to be confirmed. Scope is
   enforced server-side (MR = own visits, doctor = own diary, receptionist = granted
   doctors, admin = all); default range is 30 days back to 30 days ahead, max 366
   days, max 2000 rows; CSV cells are quoted and formula-prefixed cells neutralised.
8. **Birthdays:** MRs see all active doctors' upcoming birthdays (day/month + age as
   in the design). Wishes are allowed from 30 days before to 7 days after the day,
   max 3 per MR per doctor per birthday; doctors can hide wishes.
9. **Notifications:** stored per user (90-day TTL), created on appointment changes
   (to the other party only), wishes, receptionist access and published
   conferences (doctors of the matching specialty). Push delivery (FCM) later.
10. **Payments:** prices are GST-inclusive and always taken from the plan on the
    server (the design's ₹164 + ₹36 split is shown as the correct 18% GST split
    ₹169.49 + ₹30.51). Renewals add to remaining time; confirm is idempotent and
    atomic. Only the mock provider exists; it is refused in production. A real
    gateway implements `PaymentProvider.createOrder/verifyPayment` (signature check).
11. **Subscription gating:** subscriptions are recorded and shown, but features are
    not yet blocked without one — needs a product decision.
13. **Admin RBAC:** admin-panel users are `role: admin` with an `adminRole` (section
    permissions, checked server-side per request via `adminCan()`); Super Admin only for
    `/admin/staff` and `/admin/roles`. Temporary passwords force a change before any
    other admin call. Help desk requests carry `assignedTo` (bulk assign supported).
    Admins can pre-register doctors/MRs/receptionists (`POST /admin/users`).
15. **Doctor CSV import:** `POST /admin/users/import/doctors?commit=false|true` (text/csv, 2 MB, 1,000 rows) — preview then commit, per-row errors, duplicates checked in file and DB; template at `GET /admin/users/import/doctors/template` and `docs/samples/doctors_import_template.csv`.
16. **Location-based banners:** `locations` (country → state → city, aliases, status) and
    `banners` (title, description, image keys, showText, redirect none/internal/external,
    targeting all/state/city/multiple + location ids, status draft/active/inactive,
    start/end local days, priority 1 = highest). *Scheduled* and *Expired* are derived from
    the dates, never stored. Doctor feed `GET /doctors/me/banners` resolves the doctor's saved
    `practice.state` / `practice.city` (district as fallback) to location ids by name/alias —
    a city implies its state; ambiguous or unknown names match nothing — then one indexed
    query returns live banners for those ids plus global ones. Order: city-specific → state
    → global, then priority, then newest. The app cannot pass a location. Admin:
    `/admin/banners` (CRUD, `PATCH /:id/status`, `GET /options`), `/admin/locations` (CRUD,
    delete only when unused), `POST /admin/uploads/images?purpose=banner` (raw JPG/PNG/WEBP,
    ≤2 MB, ≥720×300, ratio 1.6–3.2, type sniffed from bytes). Files live in `UPLOADS_DIR`,
    served at `/uploads/…`; the DB stores keys only, URLs come from `PUBLIC_BASE_URL`.
    Section permission: `banners`. Migrations: `npm run migrate` / `migrate:down`.
14. **Exports:** reports download as `.xlsx` (exceljs; text cells, never formulas) or CSV.
12. **App Settings:** notification/language preferences are stored per user; the
    notification switch will control push delivery once FCM exists, and the app
    UI is English-only until translations are provided.
5. **Payments:** mock provider; Razorpay (or other) added later behind `PaymentProvider`.
6. **SMS:** dev-mode OTP; provider added later behind `SmsProvider`.
7. **Delete account:** soft delete + anonymisation (keeps appointment history
   consistent for the other party), tokens revoked.

---

## 13. Phases

| Phase | Scope | Done when |
|---|---|---|
| **1** ✅ | API foundation, auth (OTP/JWT/refresh/logout), users, doctor/MR/receptionist profiles & registration, receptionist access, appointments, delete account, audit core; Flutter integration for these | API tests green; app logs in against the API for all three roles, receptionist multi-doctor flow + cancel works end to end |
| **2** ✅ | MCL, conferences, wishes/birthdays, notifications, reports | API + app wired, tests green |
| **3** ✅ | Plans, subscriptions (mock pay), help tickets, FAQs, terms/settings | API + app wired |
| **4** ✅ | React admin panel: dashboard, users, doctors, MRs, receptionists & access, appointments, conferences, plans/subscriptions, tickets, FAQs, settings, audit logs | build + lint + typecheck clean, flows verified in browser |
