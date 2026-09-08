# 00 · Replication runbook

Purpose: the ordered path from this folder to a running, populated platform — written for a fresh
Cowork session or a Claude Code session with no prior context.
Status: spec
Version: v1.0 · 2026-08-26

Read this before anything else except `README.md`. Every step names what to do, what proves it
worked, and what to read when it does not.

---

## Phase 0 — orient (20 minutes, no code)

1. Read `README.md`, then `docs/01_ARCHITECTURE.md`, then `docs/03_COMPETENCY_FRAMEWORK.md`.
2. Skim `docs/16_TRAPS.md`. Do not read it thoroughly yet; read it again the first time something
   behaves strangely, and it will save a day.
3. Decide three things and write them down in your own `DECISIONS.md`:
   - **the operator context** — who this instance is for, and what their org units and asset classes
     are (`config/policy.yaml`);
   - **the framework** — the shipped ICAO catalogue as-is, or with a local tenth competency
     (`docs/03` §7);
   - **the scope of phase 1** — ETR only is the honest starting point. QMS, DMS and Integration are
     specified so they can follow, not so they can be built at once.

Do not start with the module you find most interesting. Start with the schema.

## Phase 1 — the database stands up

```
cp scaffold/.env.example scaffold/.env      # fill in local values, no secrets in the repo
docker compose -f scaffold/deploy/compose.yml up -d db
npm --prefix scaffold install
npm --prefix scaffold run migrate
```

**Proof:** every migration reports applied, `schema_migrations` lists them in order, and
`\dt` shows the core, ETR and framework tables. `docs/02_DATA_MODEL.md` is the reference.

**If it fails:** a migration that errors is a migration to fix, never one to skip. Forward-only means
the fix is a new file, not an edit to an applied one.

## Phase 2 — the vocabulary and the data

```
npm --prefix scaffold run seed:config      # thresholds first: everything else reads them
npm --prefix scaffold run seed:framework   # 9 competencies, 73 observable behaviours
npm --prefix scaffold run seed:templates   # four starter templates, published as version 1
npm --prefix scaffold run seed:synthetic   # a synthetic population, deterministic from a seed
```

The order is load-bearing. Config before anything that reads a threshold, framework before anything
that references a competency, templates before anything that grades against one. A seeder that runs
out of order does not fail — it quietly uses defaults, and every number after that is wrong in a way
no test notices. See `docs/14_SEED_AND_SYNTHETIC_DATA.md`.

**Proof:** the framework seeder asserts 7,7,10,6,7,11,9,7,9 = 73 and fails loudly otherwise; the
synthetic generator prints a coverage table showing that every band of every metric occurred,
including the alert half and the insufficient-data state. A band that never occurs has never been
seen to work.

## Phase 3 — the app runs

```
npm --prefix scaffold run dev
```

**Proof:** `/api/health` reports the environment, database reachability, the framework competency
count, the subject count and the inference mode. Sign in, open the subject list, open one subject
profile: KPI tiles, a competency radar with a spoke per competency in the database, trend
sparklines, a record list. Then `npm --prefix scaffold run smoke` — it fetches every route and every
subject page and asserts each one rendered a known marker. A 200 is not proof of a rendered page.

**If a subject page 500s:** it will be one page, or all of them but one. A query written correctly
for the first row and fatally for every other row is the single most expensive defect class in this
domain, and no amount of SQL review finds it — only fetching every page does.

## Phase 4 — build the module you decided on

Work one vertical slice at a time, and finish each slice: schema → library function → route →
screen → smoke check → doc update. Do not build four half-modules.

For ETR, the order that works: template builder (`docs/05`) → session create and grade (`docs/04`
§5) → signature and freeze (§2, §6) → record report (§7) → import (§8) → analytics (`docs/06`,
`docs/07`) → the analysis narrative (`docs/11`).

Every slice ends with the same four questions: does it write an audit row, does it soft delete, does
it read its thresholds from config, and does it work for a viewer whose role lacks the capability?

## Phase 5 — make it defensible

Before anyone is graded on this instance:

1. **Roles and capabilities** configured per `docs/12`, with the self-view exclusions in place.
2. **Governance** per `docs/17_GOVERNANCE.md`: audit coverage, signature semantics, retention rules,
   and the answer to "show me every change to this person's record" as a query, not a story.
3. **Backups with a proven restore.** A backup nobody has restored is a hope. Restore into a scratch
   database and count rows.
4. **Two environments with separate image variables** (`docs/15`), and the probe that proves a stage
   deploy cannot move production.
5. **The verification suite run against a freshly migrated, freshly seeded environment**, as a gate.
   Never add an escape hatch for data that predates a check: that is how a permanently red baseline
   becomes something both sides read past.

## Phase 6 — swap the synthetic population for real data

Only now, and only through `docs/04` §8. The import rules are not bureaucracy: template before
records, mapping verified before load, dedup in the database rather than a progress file, dates
parsed day-first, counts reconciled against the source before sign-off. Import into a scratch
environment first and diff the counts.

Once real records exist, the synthetic population is deleted from that environment and never
re-seeded into it.

---

## What "done" means for a replication

A reader with this folder and no other context can stand the database up, seed the framework and a
synthetic population, run the app, see populated dashboards and charts, author and publish a
template, fill and sign a record against it, generate its report — and never learn which operator
this kit was distilled from.

## The five rules that survive every deviation

1. Ids, never names — for competencies, behaviours and template elements.
2. The deterministic core computes every figure; the model only narrates.
3. Thresholds live in config, versioned, read at runtime.
4. Nothing is deleted; everything is audited.
5. A check that has never failed has never been tested.
