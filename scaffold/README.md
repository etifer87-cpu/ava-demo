# TMS scaffold

**Runs today:** the app shell (layout, brand tokens, capability-filtered navigation, sign in and
out, the route guard), `/api/health`, `/api/subjects`, and three real screens read from the
database — `/subjects` (filterable roster), `/subjects/[id]` (KPI tiles, competency radar, trend
sparklines, record list) and `/records` (all sources, with source counts). The migrations, the
analytics library, the QMS rules engine, the inference seam and the chart components run and are
covered by their own docs.

**Is a stub:** every other route — sessions and grading, templates and the builder, analytics
dashboards, QMS, DMS, planning, admin. A stub is a valid page that names the doc specifying it and
renders no fake data. `app/ROUTES.md` lists every route with its capability and its state, and
`scripts/smoke-screens.mjs` fetches exactly that list. `scripts/verify.mjs` — the deploy gate suite
specified by `docs/15_DEPLOYMENT.md` §9 — runs as `npm run verify` and as the last step of
`npm run reset`.

---

## Quickstart

Prerequisites: Node 22.12+ (`.nvmrc`), Docker with Compose, and nothing else. No global CLI, no
package registry beyond npm.

```bash
cp .env.example .env          # then fill it in; chmod 600 .env
docker compose -f deploy/compose.yml up -d db      # PostgreSQL 17
npm install
npm run migrate               # forward-only, one transaction per file
npm run config:load           # config/analytics.yaml into analytics_config, BEFORE any seed
npm run seed:framework        # the competency framework: competencies + observable behaviours
npm run seed:templates        # example session templates
npm run seed:synthetic        # synthetic people and records - obviously synthetic, DEMO-0001 style
npm run verify                # the gate suite: every assertion named, non-zero exit on any failure
npm run dev                   # http://127.0.0.1:3100
```

Then, in another shell:

```bash
curl -s http://127.0.0.1:3100/api/health | head -40
npm run smoke                 # fetches every route and every subject page; no sampling
```

`.env` needs, at minimum: `DATABASE_URL`, `SESSION_SECRET` (48+ random bytes), `APP_ENV`,
`APP_BASE_URL`. Everything else has a working default. Leave `LLM_BASE_URL` empty to run in
degraded mode: every figure, chart, table and export still renders and only generated prose is
absent. That is a supported, tested state, and `/api/health` reports it as `inference.mode
= "degraded"` with `ok` still true.

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Development server on :3100 (fixed — see ../docs/01_ISOLATION.md) |
| `npm run build` | Production build (`output: standalone`) |
| `npm run start` | Serves the build |
| `npm run migrate` | Applies pending migrations in numeric order, checksummed |
| `npm run config:load` | Loads `config/analytics.yaml` into `analytics_config` and records the version. Run it after `migrate` and before every seed |
| `npm run seed:framework` | Seeds the competency framework and verifies its counts |
| `npm run seed:templates` | Seeds example session templates and their elements |
| `npm run seed:synthetic` | Seeds a synthetic population and synthetic records |
| `npm run verify` | The gate suite of `docs/15_DEPLOYMENT.md` §9: schema, config, framework, templates, data integrity, analytics and access. One named assertion per row, non-zero exit on any failure. Run it on a freshly migrated and reseeded environment, before traffic |
| `npm run reset` | `scripts/reset-to-seed.mjs`: migrate, load config, seed framework, templates and synthetic data, in that order. It drops nothing — deletion is soft everywhere and enforced by trigger, so a true reset is a NEW DATABASE. Never run against a database that holds real records |
| `npm run smoke` | Fetches every route and every subject page and asserts each rendered |
| `npm run test` | Unit tests for the deterministic analytics core |
| `npm run typecheck` | `tsc --noEmit` |

## Layout

| Path | Holds |
|---|---|
| `app/` | Routes. `(training)` is a route group: it does not appear in the URL, so its pages are `/subjects`, `/records`, `/sessions` |
| `app/ROUTES.md` | Every route, its gating capability and its state |
| `proxy.ts` | The route-level auth filter. Named `proxy.ts` per Next.js 16; it was `middleware.ts` before |
| `lib/` | All logic. Route handlers export handlers and configuration only |
| `lib/db.ts` | The only module that opens a connection |
| `lib/access.ts` | The authorisation boundary: capabilities, scopes, the table read ACL |
| `lib/config.ts` | The only reader of `config/*.yaml` |
| `lib/analytics/` | The deterministic core: pure, no clock, no thresholds, no model output |
| `components/ui/` | The shared screen furniture. Server components unless the file says why not |
| `components/charts/` | Hand-written SVG. Same components render on screen and in the PDF |
| `config/` | `brand.yaml` (the whole brandable surface), `analytics.yaml`, `inference.yaml`, `ingest.yaml` |
| `db/migrations/` | Forward-only `NNNN_name.sql`. Number ranges are assigned in `_KIT_CONTRACT.md` |
| `deploy/` | Compose files, one per environment, and the initdb bootstrap |
| `automation/` | Optional workflow skeletons. Never a dependency |

## Where to look when X breaks

| Symptom | Look at |
|---|---|
| `DATABASE_URL is not set` | `.env` is not being read. `npm run dev` reads `.env` from this directory; the container reads it from compose |
| Every page redirects to `/login` | `SESSION_SECRET` missing or under 32 characters. `proxy.ts` treats a verification failure as "not signed in" so the app is still reachable |
| Sign-in always fails with correct credentials | The user's `password_hash` is not a bcrypt hash pgcrypto can read, or the account is locked (`users.locked_until`). Login verifies with `crypt()` inside Postgres |
| `/api/health` returns 503 with `framework.seeded: false` | Migrations ran, seeds did not. Run `npm run seed:framework` |
| A page raises `analytics_config key not found` | `analytics_config` was never loaded. Run `scripts/load-analytics-config.mjs`. `grade_num()` reads `grade_scale.valid_pattern` from that table |
| Charts render but every mark is grey | The competency rows carry no `colour`, or the chart was given competencies that do not match the grades' `competency_id`. Colours come from the database, never from the component |
| A chart is blank in the PDF but fine on screen | Something in the render path is reading a CSS custom property. The renderer receives no stylesheet: resolve colours in `chart-tokens.ts` and pass them as props |
| A screen is empty for one role and full for another | Expected. `lib/access.ts` scopes before serialisation. Check the role's grants and scopes, then `visiblePersonIds` |
| A list shows fewer rows than a count above it | The count and the list are not using the same scope or the same filters. Both must come from the same `where` clause |
| The record list shows nothing after an import | `source` is being used as a filter somewhere. It is a grouping. `/records` reads every source by default |
| `npm run smoke` reports "forbidden marker: data-error-boundary" | The page returned 200 and rendered the error boundary. The real failure is in the server log, keyed by the digest printed on the page |
| `npm run smoke` reports "missing shell marker" | The page did not render inside `app/layout.tsx`. Usually an exception before the shell, or a redirect to a route outside it |
| A chart throws `chart id prop is required` | Every chart takes a required `id` that namespaces its SVG element ids. Pass something stable and unique on the page — the subject id, the competency id, the metric key |
| Two charts on one page share a gradient or a title id | Two of them were given the same `id` prop. The components no longer mint their own: that is what makes the browser output and the PDF output diffable |
| A seed or a view raises `analytics_config key ... is not loaded` | `npm run config:load` has not run, or a key was added to a view without being added to `config/analytics.yaml`. The loader scans `db/migrations` and `scripts` for every key their readers name and refuses to load a file that lacks one |

## Conventions that are not negotiable

1. Every handler calls `requireSession()` then `requireCapability()` or `requireOnPerson()` before
   it reads anything. `proxy.ts` is a filter, not a boundary.
2. A UI element the role lacks the capability for is not rendered. Not disabled, not greyed.
3. Scope filtering happens on the server, before serialisation.
4. A filter over many ids is one array parameter, never a list interpolated into a URL or a
   statement.
5. `runtime = 'nodejs'` on every route touching cookies, the filesystem or the renderer service.
6. No threshold, band boundary, colour or product name inline in code. `config/*.yaml`, always.
7. Where the scaffold and `docs/` disagree, the docs are right and the scaffold gets fixed.
