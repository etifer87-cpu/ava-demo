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
