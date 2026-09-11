# Kit defects — the replication trial log

This instance is the TMS Kit's first replication from the kit alone. Every question a session had to
ask, every step of `kit-docs/00_REPLICATION_RUNBOOK.md` that did not work as written, and every place
the scaffold and the docs disagree is a defect **in the kit**, not in this project. Log it here in
the moment; the kit's maintainers fold it back.

Format, newest first:

```
## YYYY-MM-DD · <doc or file> · <one line>
What was expected · what happened · what was done here · what the kit should change.
```

---

_(empty — nothing replicated yet)_

## 2026-09-08 · scaffold/ · no Dockerfile ships with the kit
Expected: `docs/15_DEPLOYMENT.md` and `deploy/compose.yml` assume an image `APP_IMAGE` built from the scaffold · Found: no `Dockerfile` anywhere in `scaffold/` · Done here: a Dockerfile will be written in Phase 4 against `docs/15` · Kit should: ship `scaffold/Dockerfile` (multi-stage, Node 22, `APP_RELEASE` build arg) and reference it in `deploy/README.md`.

## 2026-09-08 · scripts/*.mjs · node scripts do not load `.env`
Expected: `README.md` §Quickstart implies `npm run migrate` works after `cp .env.example .env` · Found: every script reads `process.env` directly; only `next dev` loads `.env`, so `migrate`/`reset`/`verify` fail with "DATABASE_URL is not set" on a workstation · Done here: `package.json` scripts prefixed with `node --env-file=.env` (Node ≥ 20.6) · Kit should: do the same, or document `export $(cat .env)` per shell.

## 2026-09-08 · .env.example · one `DATABASE_URL` / `PDF_URL` for two contexts
Expected: a single `.env` serves both `next dev` on the host and the app container · Found: the container needs `@db:5432` and `http://pdf:3000`, the host needs `@localhost:<DB_PORT>` and `http://localhost:<PDF_PORT>`; nothing says so · Done here: host values in the PC `.env`, container values in the server `.env` (one `.env` per host anyway) · Kit should: state this in `.env.example` §4 and §7.

## 2026-09-08 · _KIT_CONTRACT.md:68 · names a specific REST-over-Postgres product
Expected: the kit's neutrality claim ("no LMS or vendor") · Found: one product name survives in the contract · Done here: reworded · Kit should: add the term to its own scan.

## 2026-09-08 · deploy/initdb/00_bootstrap.sql · schema-owner role name is hard-coded
Expected: `DB_MIGRATION_ROLE` in `.env.example` names the role · Found: the SQL hard-codes `tms_owner` regardless · Done here: renamed to `ava_owner` in the SQL and set `POSTGRES_USER=ava_owner` so the bootstrap's CREATE ROLE is a no-op and the same role owns and migrates · Kit should: either template the role name or drop `DB_MIGRATION_ROLE` from `.env.example`.

## 2026-09-08 · deploy/compose.yml · optional profiled services carry `:?` required variables
Expected: `docker compose up -d db pdf` works with only the db/pdf variables set (README quickstart) · Found: Compose interpolates every service at parse time, so `AUTOMATION_IMAGE:?` and `INFERENCE_IMAGE:?` abort the command even though neither profile is enabled · Done here: both defaulted to a clearly-named placeholder; `AUTOMATION_ENCRYPTION_KEY` likewise · Kit should: do the same, or move the optional services to a separate overlay.

## 2026-09-08 · README.md / deploy/README.md · `.env` is not where Compose looks for it
Expected: `.env` in `scaffold/` serves both `npm run …` and `docker compose -f deploy/compose.yml` · Found: Compose resolves `.env` relative to the first compose file's directory (`deploy/`), so every variable is missing · Done here: every compose invocation carries `--env-file .env` from `scaffold/` · Kit should: state it in the quickstart, or add `--project-directory .` to the documented commands.

## 2026-09-08 · next.config.mjs · `eslint` key rejected by Next 16
Expected: clean `next dev` · Found: "eslint configuration in next.config.mjs is no longer supported" · Done here: key removed · Kit should: remove it.

## 2026-09-08 · deploy/compose.yml · the base file cannot start db/pdf alone on a workstation
Expected: runbook Phase 1 says `docker compose -f scaffold/deploy/compose.yml up -d db` · Found: the `app` service's `${APP_IMAGE:?…}` guard aborts interpolation for every service, so the documented command can never work without an overlay — and the overlays require a built image the workstation does not have · Done here: `deploy/compose.dev.yml`, a standalone db + pdf file with the same project/network/container names, used only on the PC · Kit should: ship the same, and point Phase 1 of the runbook at it. The guard on the base file is right and stays.

## 2026-09-08 · scripts/seed-framework.mjs:37, scripts/build-framework-seed.py:26 · blueprint folder name is hard-coded
Expected: the runbook lets the kit be copied "from this folder alone" into any layout · Found: both scripts resolve `<kit>/docs/03_COMPETENCY_FRAMEWORK.md` by literal name, so a replica that keeps its own `docs/` (as this one does — the blueprint lives in `kit-docs/`) fails at seed 3/6 · Done here: `KIT_DOCS_DIR` env var, default `kit-docs` · Kit should: read the folder from one place (env or a `kit.json`), default `docs`.

## 2026-09-08 · runbook Phase 3 / scripts · no way to sign in to a freshly seeded instance
Expected: runbook Phase 3 says "Sign in, open the subject list" · Found: every seeded login carries the deliberate never-matching hash `!` and the kit ships no tool to set a password, so Phase 3 cannot be executed as written · Done here: `scripts/set-password.mjs` (`npm run password -- <username>`), hidden prompt, bcrypt computed in Postgres like the login route · Kit should: ship the same and name it in the runbook. Seeded staff logins are `demo.platform_admin`, `demo.training_manager`, `demo.assessment_manager`, `demo.records_officer`, `demo.qms_admin`, `demo.compliance_verifier`, `demo.planner`.

## 2026-09-08 · scripts/smoke-screens.mjs, .env.example §6 · the `x-internal-token` bypass is documented but not implemented
Expected: `.env.example` says the header "is checked before any route logic runs" and the smoke sends it · Found: neither `proxy.ts` nor `requireSession()` reads it, so `/api/subjects` returns 401 and the smoke aborts on every fresh install · Done here: the smoke signs in as a real user (`SMOKE_USER` / `SMOKE_PASSWORD`, local `.env` only) and carries the session cookie; no bypass added · Kit should: either implement the header in `proxy.ts` + `requireSession()` with a constant-time compare, or drop it from `.env.example` and do what this replica does.

## 2026-09-08 · scripts/load-analytics-config.mjs · policy.yaml is only recorded by the synthetic seeder
Expected: `verify --group config` asserts "the recorded policy version is the file on disk" on any environment built by the documented path · Found: the `policy` row in `config_versions` is written by `seed-synthetic.mjs` alone, so an instance without a synthetic population can never pass that assertion, and a policy edit on a live instance is invisible to the gate until the population is regenerated · Done here: `config:load` records the policy version too (same `recordConfigVersion`) · Kit should: do the same — policy is configuration, not seed data.

## 2026-09-08 · template_kinds catalogue · no loader from policy.yaml
Expected: policy.yaml §1 says "Adding a kind is a row here and a row there, never a migration" · Found: the table is only ever written by migration 0032; nothing syncs it from the file, so the only way to add a kind IS a migration · Done here: `0141_template_kinds_operator.sql` (ebt_recurrent, type_rating; OPC / LPC relabel) · Kit should: either sync the catalogue in `config:load` (with the same is_active-never-DELETE rule) or correct the comment.

## 2026-09-08 · scripts/synthetic/population.mjs · org units and asset classes are only written by the synthetic generator
Expected: the operator context (bases, fleets, devices) exists on any instance, populated or not · Found: `org_units` and `asset_classes` are inserted only inside the synthetic population step, and the lists live under `policy.yaml → synthetic:` · Done here: `scripts/seed-operator.mjs` (`npm run seed:operator`), run in `reset:clean` before the first user; lists still read from `synthetic:` to avoid a policy schema change · Kit should: move the two lists to a top-level `operator:` section and seed them in `config:load` or a dedicated step.

## 2026-09-10 · tsconfig.json + 8 source files · `npm run typecheck` has never passed on the kit
Expected: the runbook's `typecheck` script is a gate · Found: 109 errors in kit files alone - the vitest test file has no test-runner types in `tsconfig` (86 errors), and `noUncheckedIndexedAccess: true` is set but eight files index arrays/regex groups without a guard (charts, db, inference, provenance, qms conditions/engine/plain-english) · Done here: `types: ["node", "vitest/globals"]` added; every indexed access guarded (no behaviour change: the guards return the same null/empty the surrounding code already handles) · Kit should: run its own typecheck in the gate suite; a typecheck that is never green is a check that has never failed.

## 2026-09-11 · vitest · `npm test` has never run a suite
Expected: `npm test` runs `lib/analytics/__tests__/screening-index.test.ts`, which is written against `describe / it / expect` as globals · Found: no `vitest.config.*` exists, so globals are off at runtime and the suite fails on its first line with "describe is not defined" — the types were added to tsconfig (defect 16) but the runtime was never told · Done here: `vitest.config.ts` with `globals: true` and the `@/` alias · Kit should: ship the file; a test command that has never run is the same defect as a typecheck that has never passed.

## 2026-09-11 · lib/analytics/screening-index.ts, its test · the critical grade could score
Expected: docs/06 §7 - a grade of 1 "drives the flag and never enters the arithmetic" · Found: once the suite actually ran (defect 17), the leniency adjustment clamped an awarded 1 up to `clamp_min` = 2, which carries -5 points, so a critical grade DID move the score; and the test fixture wrapped its dates inside one year, so a series longer than twelve events no longer sorted in index order and the window test read events it believed discarded · Done here: the critical grade bypasses adjustment at full weight; fixture dates roll into the next year past twelve · Kit should: take both; the code fix changes screening scores for any subject with a grade 1 and a qualifying assessor, and that is the correct direction.
