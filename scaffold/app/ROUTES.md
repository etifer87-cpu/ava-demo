# Route tree (App Router)

Purpose: every route that exists in `scaffold/app` today, what it is for, the capability that gates
it, and whether it is built or a stub.
Status: scaffolded
Version: v2.0 · 2026-08-26

Specified by `docs/12_ROLES_AND_PERMISSIONS.md` (gating) and `docs/02_DATA_MODEL.md` (shapes).

## How to read this

- **This table is the router.** It lists the routes that exist as files under `scaffold/app`, and
  nothing else. A route the docs specify but the scaffold does not carry is described in its module
  doc, not here, because a route tree that lists routes the router does not serve cannot be checked
  against anything.
- **URLs are flat.** `(training)` is a route group: the parentheses keep the segment out of the URL,
  so `app/(training)/subjects/page.tsx` serves `/subjects`, not `/training/subjects`. The group
  exists to keep the ETR pages together in the tree and to give them a shared layout later.
- **Gate** names the capability the server checks. `session` means "any authenticated user".
  `-` means public. A route with two capabilities needs both.
- **State**: `built` = the page reads real data and renders it · `stub` = a valid module rendering
  `components/ui/StubPage`, which names the route's capability and the doc that specifies it, and
  renders no fake data. A stub carries the finished route's real `data-testid`, so
  `scripts/smoke-screens.mjs` exercises it now and keeps exercising it after it is implemented.
- **Test id** is the marker `scripts/smoke-screens.mjs` asserts on. That script's route list and
  this table are the same list; when one changes the other changes in the same commit.
- Page routes are React server components. Anything reading cookies or the filesystem declares
  `export const runtime = 'nodejs'`, and every page here does.
- **Route handlers export handlers and config only.** All logic lives in `lib/`. A handler that
  contains a query is a handler that will be copied, and the copy will forget the scope filter.
- `proxy.ts` holds the public allow-list and it is the inverse of the `-` rows below: everything not
  public requires a session. A new public route is closed until it is added there, because "we
  forgot to add it" must fail as a locked door rather than as an open one.

---

## Public

| Route | File | Purpose | Gate | State | Test id |
|---|---|---|---|---|---|
| `/login` | `app/login/page.tsx` | Credential entry. A plain POST form; nothing sensitive reaches browser storage | - | built | `login-form` |
| `/api/auth/login` | `app/api/auth/login/route.ts` | POST credentials, issue the session cookie, write `auth.login.*` | - | built | - |
| `/api/health` | `app/api/health/route.ts` | Liveness, database ping, framework and inference state | - | built | - |

## Landing

| Route | File | Purpose | Gate | State | Test id |
|---|---|---|---|---|---|
| `/` | `app/page.tsx` | Module tiles, filtered by capability. A tile for a module the caller cannot enter is not rendered | session | built | `dashboard` |
| `/change-password` | `app/change-password/page.tsx` | Forced first-login and post-reset change | session | stub | `change-password` |
| `/api/auth/logout` | `app/api/auth/logout/route.ts` | POST, clear the cookie, write `auth.logout` | session | built | - |

## ETR — route group `(training)`, served at the root

| Route | File | Purpose | Gate | State | Test id |
|---|---|---|---|---|---|
| `/subjects` | `app/(training)/subjects/page.tsx` | Subject roster, filterable, with concern and watch-list state | `people.view` | built | `subject-list` |
| `/subjects/[id]` | `app/(training)/subjects/[id]/page.tsx` | Subject profile: KPI tiles, competency radar, trend sparklines, record list | `people.view` (row-checked) | built | `subject-profile` |
| `/subjects/[id]/records` | `app/(training)/subjects/[id]/records/page.tsx` | Record history for one subject, all sources, grouped by kind | `training.records.view` | stub | `subject-records` |
| `/subjects/[id]/competencies` | `app/(training)/subjects/[id]/competencies/page.tsx` | Per-competency profile and trend for one subject | `training.analysis.view` | stub | `subject-competencies` |
| `/subjects/[id]/analysis` | `app/(training)/subjects/[id]/analysis/page.tsx` | Analysis runs: figures, narrative, sources | `training.analysis.view` | stub | `subject-analysis` |
| `/sessions` | `app/(training)/sessions/page.tsx` | Sessions open, awaiting signature and finalised; the grading surface | `training.sessions.view` | stub | `session-list` |
| `/records` | `app/(training)/records/page.tsx` | Records across every source, with source counts. `source` is a grouping, never a filter | `training.records.view` | built | `record-list` |
| `/templates` | `app/(training)/templates/page.tsx` | Template list with version and status | `training.templates.view` | stub | `template-list` |
| `/templates/builder` | `app/(training)/templates/builder/page.tsx` | Element builder for a draft version | `training.templates.configure` | stub | `template-builder` |
| `/analytics` | `app/(training)/analytics/page.tsx` | Programme indicator and cohort overview | `training.analytics.programme.view` | stub | `analytics-overview` |
| `/analytics/competencies` | `app/(training)/analytics/competencies/page.tsx` | Per-competency distributions, keyed by `competency_id` | `training.analytics.programme.view` | stub | `competency-matrix` |
| `/analytics/trends` | `app/(training)/analytics/trends/page.tsx` | Trend small multiples over the configured window | `training.analytics.programme.view` | stub | `trend-charts` |
| `/api/subjects` | `app/api/subjects/route.ts` | Scope-filtered subject list. `scripts/smoke-screens.mjs` enumerates from it | `people.view` | built | - |

## `/qms` — qualifications

| Route | File | Purpose | Gate | State | Test id |
|---|---|---|---|---|---|
| `/qms/qualifications` | `app/qms/qualifications/page.tsx` | Validity dashboard: valid, warning, expired, missing | `qms.qualifications.view` | stub | `qualification-list` |
| `/qms/types` | `app/qms/types/page.tsx` | Qualification type catalogue, validity and warning windows | `qms.qualtypes.configure` | stub | `qualtype-list` |
| `/qms/approvals` | `app/qms/approvals/page.tsx` | Submitted-evidence approval queue | `qms.approvals.decide` | stub | `approval-list` |
| `/qms/certificates` | `app/qms/certificates/page.tsx` | Completion certificates. A hard-gated capability | `training.certificates.view` | stub | `certificate-list` |
| `/qms/attestations` | `app/qms/attestations/page.tsx` | Compliance attestations and their signatures | `qms.attestations.sign` | stub | `attestation-list` |
| `/qms/events` | `app/qms/events/page.tsx` | The QMS event timeline | `qms.events.view` | stub | `qms-event-list` |

## `/dms` — documents

| Route | File | Purpose | Gate | State | Test id |
|---|---|---|---|---|---|
| `/dms/documents` | `app/dms/documents/page.tsx` | Folder tree and recent filings | `dms.documents.view` | stub | `document-list` |
| `/dms/upload` | `app/dms/upload/page.tsx` | Staging upload; filing happens server-side | `dms.documents.upload` | stub | `document-upload` |
| `/dms/retention` | `app/dms/retention/page.tsx` | Retention rules and their review dates | `dms.retention.configure` | stub | `retention-rules` |

## `/planning`

| Route | File | Purpose | Gate | State | Test id |
|---|---|---|---|---|---|
| `/planning` | `app/planning/page.tsx` | Schedule overview | `planning.schedule.view` | stub | `planning-overview` |

## `/admin`

| Route | File | Purpose | Gate | State | Test id |
|---|---|---|---|---|---|
| `/admin` | `app/admin/page.tsx` | Administration hub: stats, roles grid with holders, doors to the working screens | `platform.users.view` | built | `admin-hub` |
| `/admin/users` | `app/admin/users/page.tsx` | Account directory with roles and fleet/base bindings | `platform.users.view` | built | `user-list` |
| `/admin/users/new` | `app/admin/users/new/page.tsx` | Create an account (+ roster row, + grants); temporary password shown once | `platform.users.create` | built | `user-new` |
| `/admin/users/[id]` | `app/admin/users/[id]/page.tsx` | One account: roster row, grants editor, reset/deactivate, audit trail | `platform.users.view` (actions re-check) | built | `user-detail` |
| `/admin/audit` | `app/admin/audit/page.tsx` | App Log: audit_log with prefix tabs, text/actor/date filters, paging | `platform.audit.view` | built | `audit-log` |
| `/admin/tickets` | `app/admin/tickets/page.tsx` | Tech Log queue: status tabs, filters | `platform.tickets.triage` | built | `ticket-list` |
| `/admin/tickets/[id]` | `app/admin/tickets/[id]/page.tsx` | One ticket: report, response form, timeline | `platform.tickets.triage` | built | `ticket-detail` |
| `/support/report` | `app/support/report/page.tsx` | Report a problem (tech-log intake) + the reporter's own tickets | `platform.tickets.create` | built | `support-report` |
| `/admin/people` | `app/admin/people/page.tsx` | Roster administration | `people.manage` | stub | `people-admin` |
| `/admin/roles` | `app/admin/roles/page.tsx` | Roles and permissions: the matrix from the database, a per-role editor (scope per capability), new role, label edit | `platform.roles.assign` | built | `role-matrix` |
| `/admin/config` | `app/admin/config/page.tsx` | Config versions: what is active, what a bump would change | `platform.config.manage` | stub | `config-admin` |
| `/admin/org` | `app/admin/org/page.tsx` | Org units and asset classes | `people.manage` | stub | `org-admin` |

## Not routes

`app/layout.tsx` (the shell, which stamps `data-app-shell="ready"`), `app/error.tsx`,
`app/not-found.tsx` and `app/globals.css` serve no URL of their own. `app/(training)` serves none
either: it is a group, and its parentheses are why.

## What the smoke script does not fetch, and why

| Route | Reason |
|---|---|
| `/api/auth/login` | POST only. A GET returns 405, which is correct behaviour and not a render |
| `/api/auth/logout` | POST only, and fetching it would end the session the run is using |
| `/api/subjects` | Fetched, but as the enumeration source rather than as a checked route |
| `/subjects/[id]` and its children | Fetched once per subject, for every subject, from that enumeration. The script does not sample |

## Conventions that are not negotiable

1. Every handler calls `requireSession()` then `requireCapability()` or `requireOnPerson()` before
   it reads anything. `proxy.ts` is a filter, not a boundary.
2. A UI element the role lacks the capability for is not rendered. Not disabled, not greyed out.
3. Scope filtering happens on the server before serialisation. A route never returns rows and
   expects the client to hide some.
4. A filter over many ids is a single array parameter, never a list interpolated into a URL or a
   statement.
5. No route paginates by raising the limit. Everything that can return more than a page pages.
6. `runtime = 'nodejs'` on every route touching cookies, the filesystem or the renderer service.
7. Adding a route means three edits in one commit: the file, this table, and the `ROUTES` list in
   `scripts/smoke-screens.mjs`.

## Administration API (POST only, form or JSON)

| Route | File | Purpose | Gate |
|---|---|---|---|
| `POST /api/admin/users` | `app/api/admin/users/route.ts` | Create account (+ roster row, + grants); password via one-time flash | `platform.users.create` (+ `platform.roles.assign`) |
| `POST /api/admin/users/[id]` | `app/api/admin/users/[id]/route.ts` | `_action`: update_person, reset_password, unlock, deactivate, reactivate, grant, revoke | per action |
| `POST /api/admin/roles` | `app/api/admin/roles/route.ts` | `_action`: create_role, update_role, set_grants; hard gates and operator_admin untouched | `platform.roles.assign` |
| `POST /api/admin/tickets/[id]` | `app/api/admin/tickets/[id]/route.ts` | Administrator response; appends events | `platform.tickets.triage` |
| `POST /api/tickets` | `app/api/tickets/route.ts` | File a ticket | `platform.tickets.create` |
