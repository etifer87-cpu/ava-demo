# TMS Kit — authoring contract (internal)

Every file in this kit is written against this contract. Read it before writing anything.
It is internal scaffolding for the authors of the kit; a reader replicating the app reads
`README.md` and `docs/00_REPLICATION_RUNBOOK.md` instead.

## 1. What this kit is

A vendor-neutral, operator-agnostic blueprint **and** runnable scaffold for a competency-based
Training Management System (TMS): ETR + QMS + DMS + Integration, with analysis, graphs, form
templates and a template builder. It is written so that a fresh Cowork session or a Claude Code
session can rebuild the whole platform from this folder alone.

Two halves, and the split is strict:

- `docs/` — the blueprint. Specs, schemas, formulas, decisions, failure catalogue. Prose + SQL +
  JSON. This is the authority.
- `scaffold/` — the runnable starting point. Real files: migrations, config, seed data, library
  modules, route stubs, scripts, compose. Where scaffold and docs disagree, docs win and the
  scaffold gets fixed.

## 2. Hard rules

1. **No operator identity anywhere.** Never write the name of any airline, its subsidiary, its
   LMS vendor, its crew-scheduling vendor, its authority, its domains or its server names. Write
   "the operator", "the LMS", "the crew-scheduling system", "the authority", "the BI tool".
2. **No real people and no real records.** No pilot names, employee ids, licence numbers, dates of
   real events, or grade values taken from a real record. All example data is synthetic and
   obviously so (`DEMO-0001`, `Alex Rivera`).
3. **No secrets.** Env var NAMES only, always. `.env.example` carries empty values and comments.
4. **The competency framework is ICAO/EASA, id-keyed.** Nine competencies
   `KNO PRO COM FPA FPM LTW PSD SAW WLM`, 73 observable behaviours keyed `OB <c>.<n>`.
   The legacy in-house 9-skill vocabulary appears **nowhere** — not in a column name, not in a
   comment, not in a mapping table. `docs/03_COMPETENCY_FRAMEWORK.md` is the single source.
5. **Nothing keys on a competency NAME.** Grades reference `competency_id`; selections reference
   `observable_behaviour_id`. A name is a display string that can be edited without a migration.
   This is the single most important structural difference from the system this kit is distilled
   from, where name-string matching cost a 14-table, 180k-row rename.
6. **Nothing keys on a row surrogate id that an editor can destroy.** Template elements carry a
   stable author-assigned `element_key`; answers reference `element_key`, never the row's `id`.
7. **No threshold, band boundary or weight inline in code.** Everything lives in `scaffold/config/*.yaml`
   with a version bump, and is read at runtime.
8. **The deterministic core computes; the model narrates.** No figure in a report or a chart may
   originate in an LLM. Every number comes from SQL. Narration is checked against the computed
   figure set before it is stored.

## 3. Naming and vocabulary

| Concept | Use | Never |
|---|---|---|
| the person being trained | **subject** in schema/API, **trainee** in UI copy | pilot-specific slang |
| the person assessing | **assessor** in schema, **instructor** in UI copy | examiner-only wording |
| a graded training event | **session** | "check", "ride" |
| the stored, signed output of a session | **record** (table `records`) | "ETR document" |
| the form definition | **template** (`session_templates`) | "program" |
| one element of a template | **element** (`template_elements`) | "segment" |
| the aircraft/type-class | **asset_class** | fleet-specific type codes as enums |
| the org sub-unit (AOC, brand, base) | **org_unit** | operator-specific codes |

Codes are lowercase snake in SQL, camelCase in TypeScript, SCREAMING_SNAKE for env vars.
Tables plural, columns singular, timestamps `*_at`, booleans `is_*`/`has_*`.

## 4. Stack (fixed for the scaffold)

- Next.js 16, App Router, TypeScript, React server components by default.
- PostgreSQL 17 reached with **direct `pg`**, from server code only. No REST-over-Postgres layer:
  it is what produced the URL-length, row-cap and schema-cache failure modes catalogued in
  `docs/16_TRAPS.md`. A REST-over-Postgres variant is documented, not scaffolded.
- Plain `.sql` migrations run by `scripts/migrate.mjs`, forward-only, numbered `NNNN_name.sql`.
  The runner must listen for `notice` events or every `RAISE NOTICE` is silently dropped.
- Charts: hand-written SVG components, no charting dependency, identical output in browser and in
  the PDF renderer.
- PDF: HTML string -> headless Chromium service. One template module renders both the on-screen
  preview and the PDF; they can never diverge.
- LLM: one seam, `LLM_BASE_URL` + `LLM_MODEL_FAST` + `LLM_MODEL_DEEP`, OpenAI-compatible messages
  API. Degraded mode (no inference configured) is a supported, tested state.
- Automation (ingestion, batch analysis) is optional and behind the same seam; workflow skeletons
  in `scaffold/automation/` are a convenience, never a dependency.

## 5. Migration number ranges (do not collide)

| Range | Owner |
|---|---|
| 0001–0019 | core platform: extensions, org, people, auth, audit, config |
| 0020–0039 | ETR: templates, elements, sessions, grades, records |
| 0040–0059 | competency framework + seed catalogue |
| 0060–0079 | QMS: qualification types, versions, grants, approvals, attestations |
| 0080–0099 | DMS: documents, folders, versions, retention |
| 0100–0119 | analytics: functions and views |
| 0120–0139 | integration: external refs, sync state, API keys, dispatch |
| 0140–0159 | cross-cutting fixes: forward-only corrections to objects owned by an earlier range |

The 0140–0159 range exists because migrations are forward-only and an applied file is never edited:
its checksum is recorded, and the runner treats an edited-after-apply file as a hard error. A defect
in an object created by an earlier range is therefore corrected by a new file HERE, which redefines
that object with `CREATE OR REPLACE` and changes nothing else. A file in this range **states which
range owns the object it touches, what was wrong, and what protects the fix**, and it names where
the regression that protects it is asserted. It never creates a table: a new table belongs to its
module's range. An assertion inside such a file is only possible when the object is callable at
migrate time — anything reading `analytics_config` is not, because the config load runs after the
migrations by design, so its regression belongs in `scripts/verify.mjs`.

## 6. Document conventions in `docs/`

- Every doc opens with a one-line purpose, a `Status:` line (`spec` / `scaffolded` / `planned`),
  and a version `vX.Y` + date.
- SQL in docs is copy-paste runnable and matches the scaffold byte for byte where both exist.
- Every doc that describes a mechanism ends with a **Traps** section, and every trap also appears
  in `docs/16_TRAPS.md`. A trap is written as: what happens, why it happens, what to do instead.
- Cross-reference by filename, never by page or heading number.
- No emoji. Tables over prose for anything enumerable. No filler.

## 7. Scaffold conventions

- Every file is real and syntactically valid. A stub is a valid module that returns a typed empty
  result and carries a `TODO(kit):` comment naming the doc section that specifies it.
- `scaffold/README.md` states in its first ten lines: what runs today, what is a stub.
- No file may exceed what a reader can hold: split at ~400 lines.
- Route handlers export handlers and config only; all logic lives in `lib/`.

## 8. Definition of done for the kit

A reader with this folder and no other context can: stand the database up, seed the ICAO framework
and the synthetic population, run the app, see populated dashboards and charts, open the template
builder, author and publish a template, fill and sign a record against it, and generate a report —
without ever learning which operator this was distilled from.

## 9. Canonical table names (binding on every author)

Authors writing migrations, views, docs or seeds use exactly these names. Anything not listed is
owned by the module author, who adds it here in the same change.

**Core (0001–0019)** — `org_units` · `asset_classes` · `people` · `users` · `roles` ·
`user_roles` · `capabilities` · `role_capabilities` · `audit_log` · `config_versions` ·
`app_settings`

Plus `schema_migrations`, which `scripts/migrate.mjs` creates rather than a migration, and the shared
trigger functions of `0002`: `set_updated_at()`, `deny_mutation()`, `deny_hard_delete()`.

`people` is the roster: `id · external_id (the operator's own person id, unique) · full_name ·
position · org_unit_id · asset_class_id · instructor_role · is_active · joined_on · watch_list ·
concern_override`. `users` is login only, and `users.is_active` is deliberately separate from
`people.is_active` — leaving the organisation and losing a login are different events.

**ETR (0020–0039)** — `session_templates` · `session_template_versions` · `template_elements` ·
`template_competencies` · `element_library` · `sessions` · `session_subjects` · `element_grades` ·
`competency_grades` · `competency_grade_obs` · `records` · `record_tasks` ·
`record_competencies` · `line_sectors` · `analysis_runs` · `template_kinds`

`template_kinds` (added by `0032`) is the operator-editable catalogue of session template kinds;
`session_templates.template_kind` references it rather than carrying a CHECK, because `docs/04_ETR.md`
§4 defines that vocabulary as configuration. Function: `deny_published_template_change()`, the
trigger that makes a published version immutable.

Load-bearing columns: `template_elements.element_key TEXT NOT NULL` (stable, author-assigned,
unique within a template version) and `template_elements.external_ref TEXT` (the syllabus item
number — an import mapping key, never an identity). `element_grades.element_key` references the
key, not the row id. `element_grades.attempt INT NOT NULL DEFAULT 1` — a repeat is a row, and every
attempt is its own grade event. Grade columns are `TEXT`.

`records` is the frozen, signed output: one row per subject per session, plus a `snapshot JSONB`
holding everything the report needs so a record renders correctly after its template is retired.
Ingested and in-app records land in the **same** table with `source IN ('app','import','ingest')`;
any read surface that queries only one source reports zeros for the other.

**Framework (0040–0059)** — `competency_frameworks` · `competencies` · `observable_behaviours`

Functions: `sync_ob_framework()`, which keeps `observable_behaviours.framework_id` consistent with its
parent competency, and `framework_seed_verify(uuid)`, the assertion the seeder calls after loading.

**QMS (0060–0079)** — `qual_types` · `qual_type_versions` · `qualifications` · `qual_approvals` ·
`attestations` · `qms_events`

**DMS (0080–0099)** — `doc_folders` · `documents` · `document_versions` · `document_access` ·
`retention_rules`

Function: `dms_assert_status_count()`.

**Analytics (0100–0119)** — table `analytics_config` · functions `analytics_require()`,
`analytics_number()`, `analytics_int()`, `analytics_text()`, `analytics_json()`, `grade_num()`,
`grade_is_below_standard()`, `grade_is_critical()` · `av_*` views. Views are `CREATE OR REPLACE`,
never tables, and are numbered in dependency order.

`analytics_config` is the only table in this range. It holds `scaffold/config/analytics.yaml`
flattened to one row per dotted key, loaded by `scripts/load-analytics-config.mjs`, and it is what
lets rule 7 hold in SQL: the readers above raise on a missing key rather than defaulting, because a
default in SQL is a hardcoded threshold. Nothing in the application writes to it.

**Integration (0120–0139)** — `external_refs` · `sync_runs` · `api_keys` · `webhook_deliveries` ·
`dispatch_rules` · `dispatch_notices`

**Cross-cutting fixes (0140–0159)** — no tables. `0140_grade_num_literal_safe.sql` redefines
`grade_num()`, owned by the analytics range, so that a LITERAL argument is safe: with the `::INT`
inside the `CASE` arm the body inlines and the planner constant-folds the cast before the guard
runs, so `grade_num('NR')` raised while the same value from a column returned NULL. The cast now
sits on the `CASE`, which cannot be folded because the condition reads config through a `STABLE`
call. `grade_is_below_standard()` and `grade_is_critical()` raised for that reason and only that
reason; both are left as they are and asserted rather than restated.

Every graded or evidence-bearing row carries `framework_id` where a competency is involved,
`created_at`, and — where a human acted — `created_by`. Deletion is soft everywhere:
`deleted_at TIMESTAMPTZ`, plus an `audit_log` row. Nothing in this platform hard-deletes a record,
a document or a person.
