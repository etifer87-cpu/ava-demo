# Repository notes for /thermos

Facts about **this** repository that the reviewers need. The rubric files stay generic; this file
is the one to edit when the repo changes.

> **Provenance.** Written 2026-09-17 from this repository only: `CLAUDE.md`, `scaffold/CLAUDE.md`,
> `docs/01_ISOLATION.md`, `docs/02_DEPLOY_PATH.md`, `docs/07_PRODUCTION_GAPS.md`,
> `kit-docs/16_TRAPS.md`, `scaffold/package.json`, and the headers of `scripts/verify.mjs`,
> `scripts/smoke-screens.mjs` and `scripts/neutrality-scan.mjs`. Paths marked *(unconfirmed)* must
> be checked with `Grep` before a finding relies on them. Correct this file by visible amendment.

The binding rules are in `CLAUDE.md` (root) and `scaffold/CLAUDE.md`. This file does not repeat
them. npm scripts run from `scaffold/`.

---

## 1. Things that must change together

| # | Set | Members | Notes |
|---|---|---|---|
| A1 | Routes | the route file under `scaffold/app/` · `scaffold/app/ROUTES.md` · the route list in `scaffold/scripts/smoke-screens.mjs` | The smoke script's header says so: adding a route is three edits in one commit. A route in the router and not in the smoke list is a route nothing checks. |
| A2 | Capabilities | `requireCapability()` / `requireOnPerson()` in the handler · the Gate column of `ROUTES.md` · `lib/access.ts` (incl. `TABLE_READ_ACL`) and `lib/permissions.ts` · `kit-docs/12_ROLES_AND_PERMISSIONS.md` | A new capability or a changed gate that is not in all of them. Fleet binding flows through `boundFleets()` / `visiblePersonIds()`. |
| A3 | Thresholds and config | `scaffold/config/*.yaml` · `scripts/load-analytics-config.mjs` · the code that reads the value | A literal in code where config exists is a finding. The config loader's checksum chain lets a stored figure name the configuration it was computed under *(unconfirmed: read the loader)*. |
| A4 | Environment variables | the code that reads `process.env.X` · `scaffold/.env.example` · the env snippet in `docs/02_DEPLOY_PATH.md` · `scaffold/deploy/compose*.yml` | Names only, never values. A variable required and read nowhere is a finding. |
| A5 | Brand | `scaffold/config/brand.yaml` only (`docs/05_BRAND.md`) | Any colour literal, font name or product name in a component. |
| A6 | Schema | a new `scaffold/db/migrations/NNNN_*.sql` · the matching group in `scaffold/scripts/verify/*.mjs` · the data-model doc if the kit specifies it · `docs/KIT_DEFECTS.md` when the kit was wrong | **Existing migrations are closed** — an edit to one is a finding. |
| A7 | Signed record | `lib/program/record-html.ts` · `lib/program/record-pdf.ts` / `lib/pdf.ts` · `lib/program/signing.ts` · the content-hash migration (`0153_subject_content_hash.sql`) · the sign / finalise / pdf routes | What is hashed must be exactly what is rendered and signed. A field added to one and not the others is a finding. |
| A8 | Narrative | `lib/analytics/subject-narrative.ts` · `lib/analytics/subject-figures.ts` · `lib/provenance.ts` · `lib/inference.ts` · `docs/08_AI_NARRATIVE.md` | A figure in narrative text that the figure set does not carry. `docs/08` is known to be stale (brain TODO) — not a new finding. |
| A9 | Demo script | the screens a change touches · `docs/03_DEMO_SCRIPT.md` | `docs/03` is closed to agents. A change that breaks a scripted step is a finding for the author. |
| A10 | Isolation | `docs/01_ISOLATION.md` · `scaffold/deploy/compose*.yml` · `scaffold/.env.example` · the `dev` / `start` ports in `scaffold/package.json` | Names and ports are fixed: project `ava` (server `-p ava-prod`), containers `ava-*`, app 3100, db 5433, pdf 3101, cookie `ava_session`. |
| A11 | Stated gaps | `docs/07_PRODUCTION_GAPS.md` | A known gap is not a new finding unless the diff widens it. A new gap the diff creates belongs there. |

---

## 2. Commands a reviewer must never run

| Command | Why |
|---|---|
| `npm run migrate`, `reset`, `reset:clean`, any `seed:*`, `publish:programs`, `analytics:refresh` | Change the database. `reset` is the kit's reset and replaces the instance with the kit's sample data. |
| `npm run gen:programs`, `gen:roster`, `gen:history` | Generate files and plans the reseed consumes. |
| `npm run user`, `npm run password` | Create accounts / set passwords. |
| `npm run verify`, `verify:clean` | A gate for a freshly migrated and reseeded environment, not a review tool. It needs the database. |
| `npm run smoke` | Signs in as a real user against a running app. |
| `npm run dev`, `start`, `build` | Start servers or write build output. |
| `npm run diag:*` and `scripts/diag-*.mjs` | Talk to the database. |
| any `docker` / `docker compose` command, `psql`, anything in `docs/02_DEPLOY_PATH.md` | Touch running stacks or the database. |
| Reading `.env`, `scaffold/.env*` (except `.env.example`), or the file named by `NEUTRALITY_WORDLIST` | Secrets, and a list whose contents must not be repeated anywhere. |
| Any `git` command that changes state | `checkout`, `switch`, `stash`, `reset`, `commit`, `tag`, `add`, `clean`, `restore`, `merge`, `push`, `pull`, `fetch`. |

## 3. Safe checks

- `git diff`, `git log`, `git show`, `git blame`, `git ls-files`, `git grep`.
- `Grep` / `Read` / `Glob`.
- `npm run typecheck` (`tsc --noEmit`; it may update the git-ignored `tsconfig.tsbuildinfo`).
- `npm run test` (vitest over `lib/**/*.test.ts` and `scripts/**/*.test.mjs`) — **only after**
  grepping the test files for `lib/db`, `pg` or `DATABASE_URL`. If any test opens a database
  connection, do not run the suite; say so under "Not checked".
- `npm run scan` — the neutrality gate. It reads its word list through the environment and prints
  only the file that hit. Report a hit by file name only.

## 4. Known deploy risk to check whenever ports or compose change

`docs/01_ISOLATION.md` fixes the app at **3100 on cvx-hel1** too. Another project's application on
that server has also been recorded at `127.0.0.1:3100`. Until someone confirms which process owns
3100 on the server (`ss -ltnp`), any diff touching ports, compose or the tunnel ingress is a High
finding if it assumes 3100 is free there.

## 5. Reporting conventions

- `scaffold/CLAUDE.md` §5: state what was changed, run, verified and not verified; name anything
  wrong in another author's file rather than fixing it.
- A finding from reading code is labelled *predicted*, not *observed*.
- A claim states the search behind it (paths and patterns).
- No names of other operators, systems or hosts in review output — it may end up in this repo.
