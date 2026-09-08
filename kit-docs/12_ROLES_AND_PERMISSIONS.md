# 12 · Roles and permissions

Purpose: the capability model — who may do what, at what scope, and how that is enforced in three
independent layers so that no single mistake opens a door.
Status: spec + scaffolded (`scaffold/lib/permissions.ts`, `scaffold/lib/access.ts`, migrations 0007–0010, 0014)
Version: v1.0 · 2026-08-26

Related: `docs/02_DATA_MODEL.md` §3.7–3.8 (tables), `docs/16_TRAPS.md`.

---

## 1. The model in one paragraph

A **user** holds one or more **roles**, optionally scoped to an **org unit**. Each role grants a set
of **capabilities**, each at a **scope**. A capability is a dotted key such as
`training.templates.configure`; it is a row in `capabilities`, so adding a permission is an `INSERT`
and never a schema change or a deployment. The server resolves the effective capability set on
**every** request from the database — never from the cookie, never from the client, never from a
cache that outlives the request. The client receives a copy of that set for one purpose only:
deciding what to render.

There is no per-user override table in this range, and its absence is a decision rather than an
omission. Overrides are a real operational need and a real audit hazard: the ones granted
"temporarily" are still granted two years later. Until an override mechanism is specified with its
own expiry and its own review, the honest statement to an auditor is that permissions come from
roles, and every role grant is in `audit_log`.

---

## 2. Roles

Roles are **module-scoped**. Holding administrative rights in one module confers nothing in
another; a QMS admin cannot publish a training template, and a training manager cannot approve a
qualification. This is the single structural defence against the "admin means everything" drift
that every permission system acquires by its third year.

| Code | Role | Module | What it is for |
|---|---|---|---|
| `platform_admin` | Platform administrator | platform | Accounts, roles, settings, config versions, audit. **Not** a training or compliance authority: it can grant the capability to sign a record, and cannot sign one. |
| `training_manager` | Training manager | training | Owns the training programme: templates, the element library, programme-level analytics, the whole subject population. |
| `assessment_manager` | Assessment manager | training | Owns assessment quality: assessor analytics, calibration, remediation decisions, record amendment. |
| `examiner` | Examiner | training | Conducts and signs checks. Sees the subjects assessed, and the templates needed to run them. |
| `instructor` | Instructor | training | Conducts and grades training sessions. Sees the subjects actually taught. |
| `ground_instructor` | Ground instructor | training | As instructor, restricted to ground and classroom template kinds; no simulator or line records. |
| `qms_admin` | QMS administrator | qms | Qualification types, qualification records, certificate issue, the approval queue. |
| `compliance_verifier` | Compliance verifier | qms | Read-only across compliance evidence, plus attestation signing. Deliberately cannot edit what it verifies. |
| `planner` | Planner | planning | Builds and publishes schedules; reads qualification validity to plan against it; sees no grades. |
| `records_officer` | Records officer | dms | Custody of documents and records: import, filing, retention, export. Sees record metadata and documents, not analysis. |
| `trainee` | Trainee | training | Reads their own records, their own analysis, their own qualifications. Nothing else, at any scope. |

A person commonly holds several: an examiner is usually also an instructor, and a training manager
is often an examiner. The resolver is built for that (see §5).

---

## 3. Scopes

| Scope | Meaning | Resolved from |
|---|---|---|
| `own` | rows about the acting user's own `people` row | `users.person_id` |
| `assigned` | subjects the user actually assessed | `session_subjects` of `sessions` where the user is the assessor — one helper, `assignedPersonIds()`, never re-derived per call site |
| `team` | subjects sharing an org unit with the user's role grant | `user_roles.org_unit_id` |
| `org` | everything under the user's org unit, including child units | recursive walk of `org_units.parent_id` |
| `all` | the whole population | — |

Scopes are not ordered by an integer. `assigned` and `team` overlap without either containing the
other, and treating them as a ladder is how a user with two grants loses access to half of what
each grant gave them.

---

## 4. Capability catalogue

`is_scoped` marks a capability whose grant carries a scope; unscoped capabilities are all-or-nothing.
`is_overridable = false` marks a policy hard-gate that no future override mechanism may ever confer.

| Capability | Scoped | Overridable | What it permits |
|---|---|---|---|
| `platform.users.view` | no | yes | List and read user accounts |
| `platform.users.create` | no | yes | Create an account (create-only callers are forced to the lowest role server-side) |
| `platform.users.manage` | no | yes | Edit, deactivate, soft-delete an account. Requires re-authentication. |
| `platform.roles.assign` | no | yes | Grant and revoke role grants. A separate route from profile editing, always. |
| `platform.audit.view` | no | yes | Read `audit_log` |
| `platform.settings.manage` | no | yes | Edit `app_settings` |
| `platform.config.manage` | no | yes | Load and activate a `config_versions` row |
| `platform.tickets.triage` | no | yes | Support ticket queue |
| `people.view` | yes | yes | Read a roster row |
| `people.manage` | no | yes | Edit roster attributes, watch list, concern override |
| `training.templates.view` | no | yes | Read templates and their elements |
| `training.templates.configure` | no | yes | Author a draft template version |
| `training.templates.publish` | no | yes | Publish or retire a template version |
| `training.library.manage` | no | yes | Edit the element library |
| `training.sessions.view` | yes | yes | Read a session and its grades |
| `training.sessions.create` | no | yes | Open a session against a published template version |
| `training.sessions.grade` | yes | yes | Write element and competency grades |
| `training.sessions.sign` | yes | yes | Apply an assessor signature |
| `training.sessions.finalize` | yes | yes | Freeze a session into `records` |
| `training.sessions.unsign` | no | yes | Reverse a signature. Requires re-authentication. |
| `training.sessions.delete` | no | yes | Soft-delete a session. Requires re-authentication. |
| `training.records.view` | yes | yes | Read a frozen record |
| `training.records.import` | no | yes | Ingest external records |
| `training.records.amend` | no | yes | Set `outcome_override`, correct metadata. Never edits the original value. |
| `training.records.delete` | no | yes | Soft-delete a record. Requires re-authentication. |
| `training.analysis.view` | yes | yes | Read an analysis run |
| `training.analysis.run` | yes | yes | Request an analysis run |
| `training.analytics.programme.view` | no | yes | Programme, cohort and trend analytics |
| `training.analytics.assessor.view` | yes | yes | Assessor grading analytics. **See §7.** |
| `training.certificates.view` | no | **no** | View a completion certificate |
| `training.certificates.issue` | no | **no** | Issue a completion certificate |
| `qms.qualtypes.configure` | no | yes | Qualification type catalogue and validity windows |
| `qms.qualifications.view` | yes | yes | Read qualification validity |
| `qms.qualifications.manage` | no | yes | Create, supersede, override a qualification |
| `qms.approvals.decide` | no | yes | Approve or reject a submitted document |
| `qms.attestations.sign` | no | **no** | Sign a compliance attestation |
| `qms.events.view` | no | yes | Read the QMS event timeline |
| `dms.documents.view` | yes | yes | Read a stored document |
| `dms.documents.upload` | yes | yes | Upload into a subject's folder |
| `dms.documents.manage` | no | yes | File, supersede, soft-delete documents |
| `dms.retention.configure` | no | yes | Edit retention rules |
| `planning.schedule.view` | yes | yes | Read a schedule |
| `planning.schedule.edit` | no | yes | Draft a schedule |
| `planning.schedule.publish` | no | yes | Publish a schedule. Requires re-authentication. |
| `data.export` | yes | yes | Export the rows the caller can already see |
| `data.bulk_export` | no | yes | Whole-population export and reprocessing |
| `integration.api_keys.manage` | no | yes | Issue and revoke external API keys |

The catalogue is seeded by `0014_seed_roles_capabilities.sql`. A capability referenced by a route
guard but absent from `capabilities` is a deployment error and the seeder fails on it, rather than
the route silently denying everyone.

---

## 5. The role x capability matrix

Cell = the scope of the grant. `A` all · `g` org · `t` team · `a` assigned · `o` own · `-` no grant.
Role columns: **PA** platform_admin · **TM** training_manager · **AM** assessment_manager ·
**EX** examiner · **IN** instructor · **GI** ground_instructor · **QA** qms_admin ·
**CV** compliance_verifier · **PL** planner · **RO** records_officer · **TR** trainee.

| Capability | PA | TM | AM | EX | IN | GI | QA | CV | PL | RO | TR |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `platform.users.view` | A | A | - | - | - | - | - | - | - | - | - |
| `platform.users.create` | A | A | - | - | - | - | - | - | - | - | - |
| `platform.users.manage` | A | - | - | - | - | - | - | - | - | - | - |
| `platform.roles.assign` | A | - | - | - | - | - | - | - | - | - | - |
| `platform.audit.view` | A | - | - | - | - | - | - | A | - | - | - |
| `platform.settings.manage` | A | - | - | - | - | - | - | - | - | - | - |
| `platform.config.manage` | A | - | - | - | - | - | - | - | - | - | - |
| `platform.tickets.triage` | A | - | - | - | - | - | - | - | - | - | - |
| `people.view` | A | A | A | a | a | a | A | A | g | A | o |
| `people.manage` | A | A | - | - | - | - | - | - | - | - | - |
| `training.templates.view` | A | A | A | A | A | A | - | A | - | - | - |
| `training.templates.configure` | - | A | - | - | - | - | - | - | - | - | - |
| `training.templates.publish` | - | A | - | - | - | - | - | - | - | - | - |
| `training.library.manage` | - | A | - | - | - | - | - | - | - | - | - |
| `training.sessions.view` | - | A | A | a | a | a | - | A | - | A | o |
| `training.sessions.create` | - | A | A | A | A | A | - | - | - | - | - |
| `training.sessions.grade` | - | - | - | a | a | a | - | - | - | - | - |
| `training.sessions.sign` | - | - | - | a | a | a | - | - | - | - | - |
| `training.sessions.finalize` | - | A | A | a | a | a | - | - | - | - | - |
| `training.sessions.unsign` | - | A | A | - | - | - | - | - | - | - | - |
| `training.sessions.delete` | - | A | - | - | - | - | - | - | - | - | - |
| `training.records.view` | - | A | A | a | a | a | A | A | - | A | o |
| `training.records.import` | - | A | - | - | - | - | - | - | - | A | - |
| `training.records.amend` | - | - | A | - | - | - | - | - | - | - | - |
| `training.records.delete` | - | A | - | - | - | - | - | - | - | - | - |
| `training.analysis.view` | - | A | A | a | a | a | - | - | - | - | o |
| `training.analysis.run` | - | A | A | a | a | - | - | - | - | - | - |
| `training.analytics.programme.view` | - | A | A | - | - | - | - | A | - | - | - |
| `training.analytics.assessor.view` | - | A | A | - | - | - | - | - | - | - | - |
| `training.certificates.view` | - | - | - | - | - | - | A | A | - | - | - |
| `training.certificates.issue` | - | - | - | - | - | - | A | - | - | - | - |
| `qms.qualtypes.configure` | - | - | - | - | - | - | A | - | - | - | - |
| `qms.qualifications.view` | - | A | - | a | - | - | A | A | g | A | o |
| `qms.qualifications.manage` | - | - | - | - | - | - | A | - | - | - | - |
| `qms.approvals.decide` | - | - | - | - | - | - | A | - | - | - | - |
| `qms.attestations.sign` | - | - | - | - | - | - | - | A | - | - | - |
| `qms.events.view` | - | - | - | - | - | - | A | A | - | - | - |
| `dms.documents.view` | - | A | A | a | a | a | A | A | - | A | o |
| `dms.documents.upload` | - | A | - | a | a | a | A | - | - | A | o |
| `dms.documents.manage` | - | - | - | - | - | - | A | - | - | A | - |
| `dms.retention.configure` | A | - | - | - | - | - | A | - | - | - | - |
| `planning.schedule.view` | - | A | - | o | o | o | - | - | A | - | o |
| `planning.schedule.edit` | - | - | - | - | - | - | - | - | A | - | - |
| `planning.schedule.publish` | - | - | - | - | - | - | - | - | A | - | - |
| `data.export` | - | A | A | a | a | a | A | A | - | A | o |
| `data.bulk_export` | - | A | - | - | - | - | - | - | - | A | - |
| `integration.api_keys.manage` | A | - | - | - | - | - | - | - | - | - | - |

Three things in that matrix are deliberate and are the first things a reviewer asks about:

- **`platform_admin` cannot grade, sign, finalise, amend or issue.** It administers the system; it
  does not produce training evidence. Separating administration from evidence production is what
  makes the audit trail meaningful.
- **`compliance_verifier` is read-plus-attest.** It can see everything relevant and change nothing
  except its own attestation. A verifier who can edit the evidence is not verifying it.
- **`ground_instructor` differs from `instructor` only by template kind**, which is a row-level
  restriction, not a capability. It is enforced in the read ACL (§6c), because a capability cannot
  express "these template kinds only" without turning the catalogue into a policy engine.

---

## 6. Enforcement, in three layers

Each layer is independently sufficient to deny. None is sufficient to allow. A request that reaches
a mutation has been checked three times, by three different mechanisms, reading the same source.

### (a) Route guard — the edge

The App Router edge guard decodes the session cookie and matches the request path against a route
table that names the required capability for every path prefix. It has **no database access**, so
it resolves coarse role membership only and it never tries to resolve a scope. What it does is
bounce an unauthenticated or obviously-unentitled request before any handler runs, and redirect a
browser to a page the caller can actually see.

Rules:
- The public list is explicit and short: the login route, the auth API, the health check. Everything
  else is closed by default. A new route is denied until it is added to the table — the failure mode
  of "forgot to add it" must be a locked door, not an open one.
- Machine callers present a shared internal token header instead of a cookie, checked here.
- The guard must never be the only check on anything. It is a filter, not a boundary.

### (b) Server capability resolver — the boundary

`scaffold/lib/access.ts`, server-only. Every route handler, without exception, calls
`getSession()` then `requireCapability()` or `canOnRow()` before it touches data. It re-resolves the
capability set from `user_roles` + `role_capabilities` on each request. Nothing about authorisation
is read from the cookie, which carries a user id and a signature and nothing else.

The resolver attaches, per capability, a **set** of scopes — not the widest one. `canOnRow()`,
`visiblePersonIds()` and `authorizeTableRead()` union the member sets across all held scopes. A user
holding one capability at two non-overlapping scopes (an instructor who is also a team lead) loses
half their access under any implementation that collapses to a single "widest" scope, because
`assigned` and `team` do not contain one another.

Hard gates are applied last: a capability with `is_overridable = false` is granted only by a role in
the matrix above, and no future mechanism may add it.

### (c) Per-table read ACL — the data seam

There is one generic read endpoint for tabular data, and it is the most dangerous surface in the
platform. It reads a table only when:

1. the table name appears in `TABLE_READ_ACL`;
2. the caller holds the capability that entry names;
3. for a scoped entry, the result set is filtered on the server to the caller's visible
   `person_id` set before it is serialised.

A table not in the ACL returns 403 to **every** role, including platform administrators. `users` is
not in the ACL. A live 403 on `users` is the deployment canary: if it returns rows, an old bundle is
running, because a code change requires a rebuild and a served prebuilt bundle will happily keep
serving the old rules.

Row-level security in the database is intentionally not used: the application holds a single
connection role, and expressing `assigned` scope — which depends on a join through
`session_subjects` — as an RLS policy would put the hottest authorisation query in the planner's
hands on every read. Authorisation is application-layer, and the compensating control is that layer
(b) is unskippable and layer (c) closes the one generic seam.

### The rendering rule

**A UI element the role lacks is not rendered. It is not disabled, not hidden with CSS, not greyed
out.** A disabled button tells the user that the action exists, tells an attacker where to look, and
tempts the next developer to make it conditional in the handler instead of absent in the page. The
client fetches its capability set once per page from `/api/me/capabilities` and composes the page
from it.

That rendering decision is a **convenience, never a control**. Every server route re-checks. The
client-safe predicate module (`scaffold/lib/permissions.ts`) is pure, has no database access, and is
importable into a client component; the resolver (`scaffold/lib/access.ts`) is server-only and must
never be imported into a client component. A single accidental import of the resolver into a client
bundle ships the whole permission model, and the connection string with it.

---

## 7. Self-view exclusions

Some capabilities must not apply to the holder's own data. These are enforced in the resolver, not
in the UI, and they are exclusions rather than scopes — `assigned` and `team` both otherwise include
the holder.

| Rule | Applies to | Why |
|---|---|---|
| **An assessor may not view their own grading analytics.** `training.analytics.assessor.view` excludes the holder's own `person_id`, at every scope including `all`. | every role holding it | Grading analytics measure leniency, consistency and deviation from the cohort. An assessor who can watch their own leniency delta in real time will grade to the metric rather than to the standard, and the metric stops measuring anything. This is the reason the capability sits with training and assessment management and with nobody else. |
| **The assessor cohort benchmark excludes the assessor being viewed.** | the analytics layer | Otherwise every assessor is compared against a mean they are inside, which shrinks every deviation toward zero and hides exactly the outlier the report exists to find. The fleet-wide overview deliberately keeps the assessor in the cohort mean, because there the cohort *is* the population; the asymmetry is intentional and is stated on both screens. |
| **A subject may not run their own analysis.** `training.analysis.run` is never granted at `own`. | `trainee` | Analysis runs are a scheduled, auditable act with a config version attached, not a self-service refresh button. A subject reads the runs someone else requested. |
| **An assessor may not amend a record they signed.** `training.records.amend` sits with assessment management only, and the resolver additionally refuses when the caller is the record's `assessor_person_id`. | every role holding it | Correcting one's own signed evidence without a second party is the single finding that ends an audit badly. |
| **A subject's hidden record stays hidden from them.** `records.is_hidden_from_subject` is applied to `own`-scope reads before serialisation, and to the document stream route. | `trainee` | The visibility switch is set by the template author for a reason; a route that resolves the file by path and skips the flag re-opens it. |

The self-exclusion is applied in the resolver's `visiblePersonIds()` output, so a route that
correctly asks the resolver cannot get it wrong. A route that builds its own filter can, which is
why routes are not permitted to build their own filters.

---

## 8. Traps

**A widest-scope collapse silently removes access.** Resolving a capability to a single "highest"
scope is the intuitive implementation and it is wrong, because `assigned` and `team` are not
nested. Union the member sets. The symptom is a user who can see a subject on one page and not on
another, which reads as a caching bug for a long time.

**A disabled control is not a permission check.** If the control is rendered at all, someone will
eventually make the handler trust it. Do not render it.

**Importing the server resolver into a client component ships the model.** Keep the pure predicates
and the resolver in separate modules, with `import 'server-only'` at the top of the resolver. This
is the one boundary in the codebase worth a lint rule.

**A new route defaults to open unless the guard defaults to closed.** Write the route table as an
allow-list of prefixes with their capabilities, with a final deny. Every audit of this system starts
by asking for that list.

**Testing scoped access as an administrator proves nothing.** Test in a clean private window as the
target user. An administrator's cookie bleeds through every convenience path, and the resulting
"works for me" is how scoped bugs reach production.

**Certificate visibility must be a hard gate, not a grant.** The moment it is overridable, someone
grants it "temporarily" to solve an operational problem, and it is still granted two years later.
`is_overridable = false` is checked after every other rule, on every request.

**Role changes must be a separate route from profile edits.** A single form that saves profile
fields and roles together will, sooner or later, escalate someone's privileges because a stale
client resubmitted an old role array. Roles change through their own route, their own capability,
and their own audit action.
