# 01 · Architecture

Purpose: the shape of the whole platform in one read — what the pieces are, why they are separate,
and which decisions are load-bearing.
Status: spec + scaffolded
Version: v1.0 · 2026-08-26

---

## 1. One application, four modules

```
                        ┌──────────────────────────────────────────┐
                        │            one Next.js app               │
   people ──────────────▶  /training   /qms   /dms   /admin  /api  │
                        └───────┬──────────────────────────────────┘
                                │ server-only data access (pg)
                        ┌───────▼──────────────────────────────────┐
                        │        PostgreSQL 17 (one database)      │
                        │  core · ETR · framework · QMS · DMS ·    │
                        │  integration · av_* analytics views      │
                        └───────┬─────────────┬────────────────────┘
                                │             │
                    ┌───────────▼───┐   ┌─────▼──────────┐
                    │ PDF renderer  │   │ inference seam │  (degraded mode is normal)
                    └───────────────┘   └────────────────┘
                                              │
                              optional automation runner (ingest, batch analysis)
```

| Module | Owns | Doc |
|---|---|---|
| **ETR** | sessions, grades, signatures, records, record reports | `04` |
| **QMS** | qualification definitions, evaluation, approvals, attestations, expiry | `08` |
| **DMS** | documents, folders, versions, review, retention | `09` |
| **Integration** | external feeds, outward API, mobile sync, dispatch | `10` |

They are modules, not products: one codebase, one database, one auth model, one audit log. What
separates them is capability gating (`docs/12`) and table ownership, not deployment.

The **competency framework** (`03`) sits under all four and belongs to none of them. The
**analytics layer** (`06`, `07`) sits above all four and writes nothing.

## 2. The eight decisions that shape everything

1. **The framework is data.** Competencies and observable behaviours live in tables with ids.
   Grades reference ids. A rename is an UPDATE, a new framework is an INSERT, and two frameworks
   coexist because every graded row carries `framework_id`.
2. **Templates are versioned and elements have stable keys.** A published version never changes;
   editing clones. Answers key on `element_key`, which no editor regenerates.
3. **The record is frozen.** At signature, the platform writes a snapshot containing everything the
   report needs. A record renders correctly a decade later, after its template is retired and its
   author has left.
4. **Both record paths land in one table.** In-app sessions and imported records are the same rows
   with a different `source`. Every aggregate unions them or it silently reports zeros.
5. **The deterministic core computes; the model narrates.** Every figure comes from SQL. Generated
   prose is checked against the computed figure set before it is stored, and inference being
   unavailable is a supported state, not an outage.
6. **Thresholds are configuration.** Bands, weights, windows and minimum samples live in versioned
   YAML read at runtime. Retuning is a config change and a re-run, never a redeploy.
7. **Nothing is deleted.** Soft delete plus an append-only audit log, everywhere, including files.
8. **Capability, not role, gates behaviour** — checked on the server for every route, with the UI
   omitting rather than disabling what the viewer cannot do.

## 3. Stack, and why

| Layer | Choice | Why this one |
|---|---|---|
| app | Next.js 16 App Router, TypeScript, server components by default | one deployable, server-side data access by default, no separate API tier to keep in sync |
| database | PostgreSQL 17, reached with `pg` from server code only | the analytics layer is SQL; a database that can express window functions and CTEs is the product's engine, not its storage |
| data access | direct SQL in `lib/`, no REST-over-Postgres layer | the generated-REST path produced URL-length limits on id lists, silent row caps, a schema cache to remember to reload, and a statement timeout that could not be raised from inside a function. All four are catalogued in `docs/16_TRAPS.md` |
| migrations | plain numbered `.sql`, forward-only, one concern per file | reviewable, replayable, and readable by an agent that has never seen the codebase |
| charts | hand-written SVG components, no charting dependency | identical output in the browser and in the PDF renderer, no client-only runtime, colours read from the framework |
| PDF | HTML string → headless Chromium service | one template function renders both preview and PDF, so they cannot diverge |
| inference | one seam, OpenAI-compatible, `LLM_BASE_URL` + model tiers | swap provider, self-host, or run degraded, without touching a call site |
| automation | optional runner for ingest and batch analysis | convenient for document pipelines; never a dependency of the product |

## 4. Request path

```
browser → route guard (session cookie, role) → server component / route handler
        → capability resolver (server-only, per capability + per table)
        → lib/* (pure logic, thresholds injected from config)
        → pg pool (parameterised SQL, av_* views for anything aggregate)
        → audit log on every mutation
```

Rules that hold at every layer: route handlers export handlers and config only, all logic lives in
`lib/`; nothing client-side ever holds a capability decision that matters; every mutation writes an
audit row; any read that could return more than a page paginates explicitly.

## 5. Environments

Two stacks from one compose file plus per-environment overlays, each reading **its own image
variable**. One shared image tag for stage and production is not a shortcut, it is an outage waiting
for the first divergent deploy: a bare `up -d` on production silently moves it onto whatever stage
last built. The overlay files and the probe that proves the split are in `docs/15_DEPLOYMENT.md`.

Release ordering is decided per package, not by habit: if a migration changes what a view returns and
the new image depends on it, migrate first; if the new image reads something the old schema does not
have, deploy after. Ask which direction is harmless and take that one.

## 6. What is deliberately absent

- **No multi-tenant partitioning.** One deployment serves one operator. Multi-tenancy would push a
  tenant id through every table, view and index for a benefit no operator in this domain asked for.
- **No per-user permission overrides.** Capabilities attach to roles. Overrides are the mechanism by
  which an access model stops being auditable.
- **No hard delete, anywhere.** Including for people.
- **No inline threshold, anywhere.** Including "obvious" ones.
- **No competency name as a key, anywhere.** Including in prompts and config.

## 7. Reading order for a new session

1. `README.md` — what this kit is.
2. `docs/00_REPLICATION_RUNBOOK.md` — the ordered path from empty folder to running app.
3. this file — the shape.
4. `docs/03_COMPETENCY_FRAMEWORK.md` — the vocabulary everything else uses.
5. `docs/02_DATA_MODEL.md` — the schema.
6. the module doc for whatever you are building.
7. `docs/16_TRAPS.md` — before you debug anything.
