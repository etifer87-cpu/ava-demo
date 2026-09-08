# 14 · Seed and synthetic data

Purpose: what makes a fresh install renderable, and the rules that keep it honest.
Status: spec + scaffolded (`scaffold/db/seed/*`, `scaffold/scripts/seed-*.mjs`, `scaffold/config/policy.yaml`)
Version: v1.0 · 2026-08-26

The seed layer turns an empty database into a working system: the assessment vocabulary, four
authored forms, a population to render, and enough variety that every surface in the platform has
something to show. It is the difference between a repository and a demonstration.

---

## 1. What the seed layer is for

| Layer | File | What it produces |
|---|---|---|
| framework | `scaffold/db/seed/competency_framework.json` | 9 competencies, 73 observable behaviours |
| templates | `scaffold/db/seed/templates/*.json` | four published starter forms |
| policy | `scaffold/config/policy.yaml` | vocabularies, grading policy, retention, the synthetic profile |
| population | `scaffold/scripts/seed-synthetic.mjs` | org, roster, sessions, grades, records, sectors, analysis runs |

Three things it is NOT. It is not a fixture library for unit tests — those own their own data. It
is not a migration — re-seeding after a wording change must never require a new migration number.
And it is not a demonstration dataset chosen to look good: a seed that only shows the healthy half
of every metric hides exactly the half an operator needs to trust.

## 2. The rule: no real person and no real record, ever

**No real data of any kind enters this kit.** Not a pilot name, not an employee id, not a licence
number, not a real date of a real event, not a grade taken from a real record, not a route, not a
registration, not an operator's syllabus item text.

| Concern | Rule |
|---|---|
| names | combined from two invented lists in `policy.yaml`; obviously synthetic |
| person ids | `DEMO-0001` upward, prefix from `synthetic.person_id_prefix` |
| org units and asset classes | neutral labels (`Demo Division A`, `TYPE-A`, `SIM-A`) |
| flights and aerodromes | `DEMO123`, `DEMO-AD-A`; never a real designator |
| task names | generic training items ("Rejected take-off", "Engine failure after V1", "Non-precision approach"), never lifted from an operator's syllabus |
| syllabus numbers | `SYN-` prefixed placeholders in `external_ref` |
| credentials | `users.password_hash` is a single `!`, a string no hashing scheme produces and no password matches. There is no secret anywhere in the seed layer |
| authorities and vendors | named nowhere; the framework's provenance is recorded as `docs/03_COMPETENCY_FRAMEWORK.md`, not as a publishing body |

If a value in the seed layer starts to look like it came from a roster, it is a defect.

## 3. The ordered path

`scaffold/scripts/reset-to-seed.mjs` runs all of it. **The order is load-bearing:**

| # | Step | Why here |
|---|---|---|
| 1 | `migrate.mjs` | creates `analytics_config`, without which nothing can read a threshold |
| 2 | `load-analytics-config.mjs` | fills it — AFTER migrate, BEFORE anything that reads a threshold |
| 3 | `seed-framework.mjs` | the vocabulary every later row references by id |
| 4 | `seed-templates.mjs` | a session must name the template version it was graded against |
| 5 | `seed-synthetic.mjs` | reads thresholds, templates and the framework; writes the population |

Step 2 is the one that is easy to move and expensive to move. Every band boundary the generator
shapes its distribution against is read from `analytics_config`; a generator that ran first would
read nothing. The kit's answer is that the readers RAISE rather than default —
`analytics_number()` in SQL, `readAnalyticsConfig()` in the seed scripts — so the wrong order is a
loud failure rather than a population shaped to boundaries nobody chose.

`load-analytics-config.mjs` is owned by the analytics layer and named by migration
`0100_analytics_config.sql`. `reset-to-seed.mjs` refuses to continue without it and prints its
contract.

**A true reset is a new database.** Nothing in this platform hard-deletes: `people`, `sessions` and
`records` carry a trigger that refuses DELETE. The synthetic generator therefore refuses to run
into a database that already contains a synthetic population, rather than pretending to clean up.

## 4. The framework seed is GENERATED, never typed

`scaffold/db/seed/competency_framework.json` is produced by
`scaffold/scripts/build-framework-seed.py`, which parses `docs/03_COMPETENCY_FRAMEWORK.md`.

Retyping 73 observable behaviours into JSON introduces drift nobody can see: one "aeroplane"
spelled "airplane", one "Situation" spelled "Situational", and the seed no longer matches the
document that governs it. Byte-matching is assertion 4 of `docs/03` §6, so the JSON is parsed out
of the document and never hand-edited.

`seed-framework.mjs` then re-parses `docs/03` INDEPENDENTLY, in JavaScript, and compares every OB
text to the JSON. Two implementations disagreeing is a failure; one implementation agreeing with
itself is not a check. It also asserts the counts `7,7,10,6,7,11,9,7,9 = 73`, code shape,
uniqueness, colour contrast, and finally calls `framework_seed_verify()` so the database asserts
the same facts a third time and rolls back the transaction if any of them is false.

Changing wording is: edit `docs/03`, re-run the generator, re-run the seeder. Ids are never
re-minted, because every grade in the database points at them.

## 5. The starter templates

Four, per `docs/05` §6, plus one generated by the synthetic layer (see §9). Each is authored
against the element catalogue of `docs/05` §2, references competencies by CODE, and carries no
operator content.

`seed-templates.mjs` validates through `scripts/lib/template-rules.mjs` — the same function the
builder's publish action uses. Two copies of the publish rules drift, and the drift shows up as
seeded data the UI cannot open. If the seeder accepts something the builder would reject, the
seeder is wrong.

Publishing order inside the seeder matters too: a version is inserted as a DRAFT, filled, and only
then published, because migration 0021 blocks every write to the children of a published version.
A published version is immutable, so re-running the seeder reports the existing version and moves
on rather than editing it.

## 6. How the generator is parameterised

| Flag | Default | Meaning |
|---|---|---|
| `--seed <text>` | `synthetic.default_seed` | the pseudo-random seed; same seed, same population |
| `--subjects <n>` | `synthetic.default_subjects` (40) | roster size; refuses a value too small to carry every required profile |
| `--months <n>` | `synthetic.default_months` (24) | MINIMUM window; extended automatically, see below |
| `--as-of <date>` | today | the end of the window |
| `--no-commit` | off | generate, assert, print, roll back |
| `--allow-existing` | off | escape hatch; the guard exists for a reason |

Everything else — org units, asset classes, name lists, volumes, shares, the assessor count, the
analysis-run mix — is `synthetic:` in `scaffold/config/policy.yaml`, not a literal in the script.

**Determinism.** Given the same `--seed`, the same `--as-of` and an empty database, the generator
produces byte-identical data. Nothing calls `Math.random()`, `Date.now()` or `crypto.randomUUID()`;
every draw comes from a NAMED stream of the seeded generator, so adding a draw in one place does
not shift every later value; and every id comes from the database's own `gen_random_uuid()`,
because a generated id would make two runs differ in the one column everything joins on. `--as-of`
is part of the contract precisely because a window measured from "today" is a different window
tomorrow.

**The window is extended, never truncated.** `--months 24` is a floor. The generator reads
`program_indicator.scopes[*].base_from` and `control_chart.estimation_start` from the loaded
config and extends the window back to cover the earliest of them. A generator that honoured
`--months` literally would leave every configured base window empty, and every base-relative band
would silently fail to occur.

## 7. Band coverage, and how it is asserted

**The requirement: every band of every metric in `scaffold/config/analytics.yaml` must occur in
the seeded population — including the alert half and the insufficient-data state.** A band that
never occurs has never been seen to work.

The mechanism is two-sided:

- **Profiles produce the bands.** Each subject carries a profile and each assessor a trait, listed
  in `scripts/synthetic/population.mjs` with the band each exists to create: an unrecovered
  critical grade, a critical grade cleared by a clean run, a clean run broken by a grade 2, a
  subject with two valid grades, a subject with no records at all, a lenient assessor, a severe
  one, an assessor who awards one grade to everything, an assessor with no login. A period
  difficulty schedule in `scripts/synthetic/events.mjs` places the indicator excursions AFTER the
  configured base windows, because a base window containing its own excursions estimates its
  standard deviation from them and then never alerts.
- **`scripts/synthetic/coverage.mjs` asserts they did.** It recomputes the bands FROM THE GENERATED
  DATA — screening index with its recency weights and clean-run rule, the indicator with its
  pooled base rate, per-period standard deviation, target and sigma alerts, concern, flagged
  records, trend, cohort sample sizes, assessor spread and adjusted leniency delta — and prints a
  table of every band with whether it occurred. **A missing required band fails the run and
  nothing is committed.**

Computing the bands from the output rather than from the profiles that were requested is
deliberate. A check asserted over a population the generator never produces can never fire, and an
assertion that always passes is indistinguishable from no assertion at all.

Two metric families are NOT covered by this layer, listed with their reasons in
`policy.yaml` under `synthetic.not_covered` and printed on every run:

| Not covered | Why |
|---|---|
| `currency.statuses` | qualification holdings are QMS-owned (migrations 0060–0069); the QMS seed exercises VALID, WARNING, DUE, PLANNED, EXPIRED, MISSING, SUSPENDED, INACTIVE |
| `data_quality.report_duplicates` | duplicate `(record_id, element_key, instance_no, attempt)` rows cannot be inserted — migrations 0029 and 0034 carry a UNIQUE constraint on exactly that tuple. The metric is exercised by an import fixture, not by the generator |

An honest gap is cheaper than a coverage claim that is not true.

## 8. Replacing the synthetic population with a real one

The synthetic population is scaffolding, and it is removed by NOT creating it, never by deleting
it afterwards.

1. Stand up a database and run `reset-to-seed.mjs` **without** step 5: run `migrate.mjs`,
   `load-analytics-config.mjs`, `seed-framework.mjs`, `seed-templates.mjs` and stop.
2. Replace the four starter templates with the operator's own. Import them through the
   parse-then-commit path of `docs/05` §8 — one endpoint parses and returns a draft without
   writing, the author reviews it, a second endpoint commits.
3. Import the roster and the historical records through `docs/04` §8. Every rule there applies:
   the template version must exist before the import; elements map by `external_ref` or by title
   and unmatched elements are DROPPED, so the pre-flight mapping check is mandatory; dedup on
   `(subject_id, record_date, template_name)` lives in the database, not in a progress file;
   dates are day-first and parsed explicitly; sparse source data stays sparse.
4. Verify before sign-off: record count, element-grade count, OB count, remark count, comment
   count and grade distribution each match the extract audit exactly.

A database that has held the synthetic population should not later hold real records. The demo
population is committed in one transaction and is trivially rebuilt; a fresh database is cheaper
than any story about which `DEMO-` rows were cleaned up.

## 9. Deviations from the prose, and why

| Deviation | Reason |
|---|---|
| the generator publishes a fifth template, `SYN-LINE-CHK` | `analytics.yaml` configures an indicator scope over `line_check` and the four starter templates cover no such kind. Without it that entire scope has no population and every band inside it silently fails to occur. It is published through the SAME publish rules — there is no second door into `session_templates` |
| template `effective_from` is the seed run date | publish rule 5 requires a date not in the past. Sessions are backdated freely and independently: backdating a publish does not retroactively re-grade or re-render anything |
| the seed definitions name an element's type `catalogue_type` | an authoring-file field name, and since migration 0033 a synonym for `element_type`: the seeder writes the value straight into that column with no translation |
| the generator writes no field-element answers and no repeatable-group instances | migration 0034 added `element_grades.value_text` / `value_num` / `value_date` and `instance_no`, so the shape exists; the generator does not yet exercise it. Every row it writes carries `instance_no = 1` and names it in the upsert's conflict target |
| the generator writes no `template_competencies.allowed_ob_ids` | migration 0035 added the column and the seed templates leave it empty, which means "every OB of this competency" — the widest and least surprising default for a starter form |

### Four deviations that were closed

Earlier revisions of this kit worked around a schema narrower than the specs. Migrations 0032–0035
widened it and the workarounds are gone; they are recorded here because a reader who saw the old
seed files will look for them.

| Was | Now |
|---|---|
| `policy.yaml` mapped each template kind to a coarse `db_kind`, because migration 0020 constrained `session_templates.template_kind` to six families while `docs/04` §4 defines twelve process kinds | migration 0032 replaced that CHECK with the operator-editable `template_kinds` catalogue. `policy.yaml` carries one level, `analytics.yaml`'s `program_indicator.scopes` select on process kinds, and the seeder writes the kind the author chose |
| catalogue types `setup`, `event_option`, `field`, `computed` and `group` were stored as their nearest legal `element_type` with `content.catalogue_type` carrying the real one | migration 0033 widened the CHECK to the eight types of `docs/05` §2. The type is stored in the column it belongs in and `content.catalogue_type` is no longer written |
| `template_competencies` had no `allowed_ob_ids` column, so no seed template could narrow an OB pick-list | migration 0035 added it. Empty still means every OB, resolved from the framework at read time |
| `element_grades` had no `value_text` / `value_num` / `value_date` and no `instance_no`, so `docs/05` §4's field answers and repeatable groups had nowhere to go | migration 0034 added all four, to `element_grades` and to its frozen copy `record_tasks`, and moved `instance_no` into the uniqueness constraint on both |

## 10. Traps

- **Seeded data must match what the application writes, byte for byte in shape.** Same tables,
  same columns, same key shapes, same attempt semantics, same snapshot structure. A seed that
  takes a shortcut — one row per element instead of one row per attempt, a keyed map in
  `records.snapshot` instead of an array of objects — produces a database the tests pass against
  and the application never creates. The tests then test a fiction, and the first real record
  breaks them.
- **A check asserted over a population the generator never produces can never fire.** Coverage is
  computed from the generated rows, not from the profiles that were asked for. An assertion that
  cannot fail is not an assertion.
- **A demonstration population reaches only the healthy half of every metric.** Grade 1 has to be
  placed deliberately; so does a suppressed period, a subject with no records at all, an assessor
  below the banding minimum, and a cohort side too small to compare. None of them occur by
  accident, and each of them is a surface that ships broken if it is never rendered.
- **Excursions inside the base window disable the alerts they were meant to demonstrate.** The
  base estimates its own standard deviation; put the excursion in the base and the alert limits
  widen to contain it. Every excursion in the difficulty schedule sits after `base_to`.
- **A hole in the base window is not neutral.** A base period that falls below
  `suppression.min_n_rate` is suppressed and drops out, and `base_periods_observed` then disagrees
  with the `base_periods` the configuration asserts on every base row. Events are spread evenly
  across the window rather than sampled randomly, so no month is accidentally empty.
- **`--months` is a floor, not a window.** Honouring it literally leaves every configured base
  window empty. Extend to cover the earliest configured base, and print that you did.
- **Repeat eligibility decided per element gives every subject a repeat.** Over a two-year window
  a per-element roll reaches almost everyone, which is not the minority any operator would
  recognise. It is decided once per subject.
- **Both source homes or neither.** `records.source` is `app` and `import` in the same table. A
  generator that produced one source could not reproduce the defect the column exists to prevent —
  a read surface that queries one home and reports zeros for the other, silently.
- **The seeder's validation and the builder's validation must be one function.** Two copies drift,
  and the drift shows up as data the UI cannot open. `scripts/lib/template-rules.mjs` is the one
  copy; when the builder route lands it imports that module rather than re-implementing the list.
- **A seed that writes a competency by name is the failure the framework tables exist to prevent.**
  Seeds reference competencies and observable behaviours by CODE and resolve them to ids at seed
  time. No name is stored anywhere outside `competencies.name` and `observable_behaviours.text`.
- **An assessor drawn per event owns whole periods.** An independent draw gives each assessor the
  right share and the wrong distribution, and at these denominators one assessor owning a period
  moves its rate further than any difficulty offset the schedule applies. The roster is dealt as a
  rotation across the window, in one lane per period grain, so every period carries a proportional
  mix. See `docs/16_TRAPS.md` 4.14.
- **A monthly calendar cannot express a quarter.** A scope measured by quarter needs its own
  calendar, laid out in whole quarters after the base and carrying the VOLUME as well as the grade
  offset: three months of alternating offsets average out inside one quarter, and a suppression
  band is a statement about n that nothing was controlling. See `docs/16_TRAPS.md` 4.15.
- **An excursion at offset zero is a coin flip.** The target sits a relative fraction below the
  base rate, so a period left at the base rate is above target only in expectation. Every period
  meant to be above target is depressed until it is unambiguously above target.
- **A branch that keys on a family name stops running when the family is deleted.** Supervised-line
  records wrote zero sectors for exactly this reason. Branch on the policy property of the kind.
  See `docs/16_TRAPS.md` 1.12.
- **A seed that does not `ANALYZE` leaves the planner with no statistics.** Every table was empty
  when the planner last looked, so it estimates one row for each and chooses plans that
  re-evaluate whole subqueries per outer row; the analytics views then take minutes and the
  analytics layer gets blamed. The generator runs `ANALYZE` after its commit. See
  `docs/16_TRAPS.md` 11.18.
- **A default in a seed script is a hardcoded threshold.** Every boundary the generator uses is
  read from `analytics_config` and raises when absent. The temptation to write `?? 30` next to a
  minimum sample is the whole trap, in one line.
