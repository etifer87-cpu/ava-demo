# 15 · Deployment

Purpose: the runbook. What runs, on what ports, how a release reaches an environment, how it is
proved, and how it is undone.
Status: spec + scaffolded (`scaffold/deploy/`, `scaffold/scripts/`)
Version: v1.0 · 2026-08-26

---

## 1. Environments

Three, and they are separate all the way down: separate database, separate data root, separate
secrets, separate image tag.

| Environment | Runs on | Purpose |
|---|---|---|
| `dev` | a workstation | edit and test; the only place code is written |
| `stage` | the server, or a second host | the release candidate; migrations are proved here first |
| `prod` | the server | live |

One direction of flow: **edit on dev, commit, deploy to stage, prove, deploy to prod.** Code is
never edited on a deployed host — the next deploy erases it and the fix is lost silently.
Environment files are never copied between hosts; each host owns its own `.env`, mode `600`,
root-owned, never in the repository.

---

## 2. The stack

`scaffold/deploy/compose.yml` is the base. Everything is bound to `127.0.0.1`; nothing is
published to a public interface. Public reach comes from the outbound tunnel (§3).

| Service | Image | Role | Host bind | Volumes | Healthcheck |
|---|---|---|---|---|---|
| `app` | `${APP_IMAGE}` | Next.js application, server-rendered; the only thing that talks to the database | `127.0.0.1:${APP_PORT}` -> 3000 | `${DATA_ROOT}:/data` (records, uploads, generated PDFs) | `GET /api/health` returns 200 and a JSON body naming the release |
| `db` | `postgres:17-alpine` | PostgreSQL 17, the system of record | `127.0.0.1:${DB_PORT}` -> 5432 | `db_data:/var/lib/postgresql/data`, `./initdb:/docker-entrypoint-initdb.d:ro` | `pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}` |
| `pdf` | `gotenberg/gotenberg:8` | headless Chromium HTML-to-PDF renderer; stateless | `127.0.0.1:${PDF_PORT}` -> 3000 | none | `GET /health` returns 200 |
| `automation` | `${AUTOMATION_IMAGE}` (no default; any orchestrator that can call HTTP, run code and read a mount) | *optional.* Runs the ingest and batch-analysis pipelines. Absent, the app still works; ingestion is then a manual import | `127.0.0.1:${AUTOMATION_PORT}` -> 5678 | `automation_data:/var/lib/automation`, `${DATA_ROOT}:/data:ro` | `GET /healthz` returns 200 |
| `inference` | `${INFERENCE_IMAGE}` (no default; any runtime serving OpenAI-compatible `/v1/chat/completions`) | *optional.* Local OpenAI-compatible model runtime. Absent, `LLM_BASE_URL` points elsewhere or is unset and the platform runs in degraded mode (`docs/11` §11) | `127.0.0.1:${INFERENCE_PORT}` -> 11434 | `inference_models:/models` | `GET /v1/models` returns 200 |

Both optional services sit behind compose profiles (`--profile automation`, `--profile inference`)
so a minimal deployment is `app + db + pdf` and nothing references what is not running.

All services: `restart: unless-stopped`, joined to one user-defined network `tms`, resolving each
other by service name (`http://db:5432`, `http://pdf:3000`, `http://app:3000`).

**Container addressing.** Inside the network, use service names. `host.docker.internal` does not
resolve on Linux, and a host virtual-adapter IP is reassigned on reboot, which breaks every
database call at once with no configuration change. Never hardcode an IP.

**Published port vs internal port.** `PDF_URL` for the app is `http://pdf:3000` — the container's
own port, not the host's published `${PDF_PORT}`. The published port is unreachable from inside
another container, and the symptom is every PDF export failing with a bare fetch error.

**Firewall.** Default-deny inbound, SSH only. Docker writes its own iptables rules and bypasses a
host firewall, so **the `127.0.0.1` bind, not the firewall, is what keeps a port private.** A
service published on `0.0.0.0` is public regardless of what the firewall says.

**The local inference runtime has no authentication.** Bound to loopback that is harmless. Bound to
`0.0.0.0` it is an open model endpoint on whatever network the host is on. If it must be reachable
from another container, scope the allow rule to the container subnet exactly — a `/12` is wide
enough to include the host's own Wi-Fi address — and re-verify after every upgrade of the runtime
and after the host joins a new network, because installers recreate their own rules.

---

## 3. Reverse proxy and tunnel

Public reach is an **outbound-dialling tunnel**, not an inbound port. The tunnel container holds a
credential (`TUNNEL_TOKEN`), dials out, and routes:

```
https://<app-host>          -> http://app:3000
https://<automation-host>   -> http://automation:5678
```

TLS terminates at the edge; the tunnel carries plain HTTP internally, which is why nothing inside
is exposed. Both hostnames sit behind an edge access policy (identity or one-time-passcode).
Private services — the database, the PDF renderer, the inference runtime, any admin UI — get no
route at all and are reached over an SSH port-forward:

```bash
ssh -N -L 15432:127.0.0.1:${DB_PORT} <user>@<host>
```

Forward to a **non-colliding local port**: the dev workstation is usually already listening on the
same numbers, and forwarding onto an occupied port silently connects you to your own machine.

A conventional reverse proxy (nginx/Caddy terminating TLS on 443) is an equally valid substitute;
the requirement is only that nothing but the proxy or tunnel is reachable from outside.

---

## 4. One image tag variable per environment

**Never one shared tag.** `image: tms-app:latest` in a file used by two environments means a
`docker compose up -d` on stage pulls whatever prod last built, and vice versa — a change reaches
production the moment someone restarts a stage container, with no deploy and no record.

The scaffold enforces separation structurally:

| File | Variable | Value form |
|---|---|---|
| `compose.yml` | `${APP_IMAGE}` | no default; compose fails if unset |
| `compose.stage.yml` | `APP_IMAGE: ${APP_IMAGE_STAGE}` | `tms-app:stage-<commit-sha>` |
| `compose.prod.yml` | `APP_IMAGE: ${APP_IMAGE_PROD}` | `tms-app:prod-<commit-sha>` |

Each overlay reads its **own** variable name, so a stage `.env` cannot supply a prod image even by
accident. Tags are immutable and carry the commit sha. `latest` is not used anywhere.

### 4.1 The probe that proves they are separate

Run against both environments; the output must differ and must match what was deployed.

```bash
# 1. what tag is actually running, per environment
docker inspect --format '{{.Config.Image}}' tms-stage-app-1
docker inspect --format '{{.Config.Image}}' tms-prod-app-1

# 2. what the running process says about itself
curl -s https://<stage-host>/api/health | jq -r '.release'
curl -s https://<prod-host>/api/health  | jq -r '.release'

# 3. the negative test: change stage, confirm prod does not move
#    deploy a new commit to stage only, then re-run 1 and 2.
#    prod's tag and release must be byte-identical to before.
```

`/api/health` returns `{ "ok": true, "release": "<commit-sha>", "env": "stage|prod",
"migration": "<latest applied migration number>" }`. Two environments reporting the same `release`
or the same `env` is the failure this probe exists to catch, and it belongs in the deploy script
as a hard assertion, not in a checklist.

---

## 5. Migrate-first or deploy-first

Migrations are forward-only, numbered `NNNN_name.sql`, idempotent, and applied by
`scripts/migrate.mjs`. Code deploys never apply migrations implicitly — a deploy that silently
migrates cannot be rolled back by re-deploying the previous image.

Decide per release, by asking one question: **can the currently running code tolerate the new
schema?**

| Change | Order | Why |
|---|---|---|
| additive: new table, new nullable column, new index, new view, new function | **migrate first** | old code ignores what it does not select; the window is safe in both directions |
| new enum value | **migrate first, as its own step, committed before any insert uses it** | an enum addition and an insert using it in the same transaction fails |
| a column the new code requires as NOT NULL | **two releases.** R1: add nullable + backfill + new code writing both. R2: add the constraint. | a single-release version has a window where old code writes NULL |
| rename or drop a column, rename a table | **two releases.** R1: add the new name, dual-write, new code reads the new name. R2: drop the old. | a rename is not atomic across a rolling deploy; something is always reading the old name |
| destructive backfill or a data reshape | **deploy first, migrate in a maintenance window with a fresh backup taken minutes before** | the rollback is the backup, so the backup must be newer than the change |

Two hard rules regardless of order:

- **A migration that derives reference data from whatever rows happen to be present must never run
  on a deployed environment.** It produces a different result on a different dataset. The runner
  carries a `FORBIDDEN_ON:` header check and refuses; the verified rows ship as seed data instead.
- **The migration runner must surface `RAISE NOTICE`.** A client that does not subscribe to notice
  events drops every one, and a migration that reports what it skipped reports nothing.

An empty read after a clean deploy is a missing migration, not a code bug. Check the applied
migration number in `/api/health` before touching source.

---

## 6. Backup and proven restore

| Aspect | Setting |
|---|---|
| What | `pg_dumpall` (whole cluster, including roles), gzipped |
| When | daily, scheduled by a systemd timer with `Persistent=true` so a missed run catches up after downtime |
| Where | local retention of the last 14, then `rsync -a --delete` to off-site storage over SSH, publickey-only |
| Also | `${DATA_ROOT}` (uploaded and generated files) mirrored on the same schedule — a database restore without the files restores half a record |
| Verify the schedule | `systemctl list-timers` shows the next run; a timer that never fired is the normal failure |

Restore, into a throwaway instance:

```bash
gunzip -c dump-<date>.sql.gz | docker exec -i -e PGPASSWORD=... <db-container> psql -U postgres
```

**A backup that has not been restored is not a backup.** The restore drill is a scheduled, recorded
exercise: restore the most recent dump to a scratch host, run `scripts/verify.mjs` against it, run
`scripts/smoke-screens.mjs` against an app pointed at it, and record the wall-clock time. A restore
drill at realistic data volume is a named go-live gate — restore time at 200 records and at 200000
are different numbers, and only one of them is the one you need.

Before any destructive migration, take a fresh dump in the same shell session as the migration and
confirm its size is non-zero.

---

## 7. Deploy, in order

Every step is a gate. Do not proceed past a failing one.

```
 1  Commit and tag on dev.  Only committed work deploys.
    git tag pre-<change>            # the rollback anchor
 2  Build the image with the commit sha as its tag:
    docker build -t tms-app:stage-$(git rev-parse --short HEAD) .
 3  Back up stage's database (and prod's, before the prod pass).
 4  Apply migrations, in order, as the schema-owning role:
    node scripts/migrate.mjs --env stage
    -> must print each applied file and end with the new head number
 5  Verify the schema landed:
    select to_regclass('public.<new_object>');
 6  Set the environment's own image variable and start:
    APP_IMAGE_STAGE=tms-app:stage-<sha> docker compose \
      -f compose.yml -f compose.stage.yml up -d
 7  Health gate:  curl -fsS http://127.0.0.1:${APP_PORT}/api/health
    -> ok:true, release == <sha>, migration == head from step 4
 8  Environment-separation probe (section 4.1). Stage moved; prod did not.
 9  node scripts/verify.mjs --env stage        # the gate suite, section 9
10  node scripts/smoke-screens.mjs --base http://127.0.0.1:${APP_PORT}
11  Manual pass on the live host as a non-admin user, in a clean private window.
12  Repeat 2-11 against prod with APP_IMAGE_PROD and compose.prod.yml.
13  Record the deploy: commit sha, migration head, timestamp, rollback line.
```

Step 11 is not optional and it is not done in the admin session. An admin cookie bleeds through and
hides every authorisation defect; a 403 on a restricted surface is the expected, correct result for
every role and is also the cheapest proof that the build you are looking at is the new one.

---

## 8. Rollback

Three independent levers. Know which one the failure needs before pulling any of them.

| Failure | Lever | Command |
|---|---|---|
| bad code, schema unchanged or additive | previous image tag | `APP_IMAGE_PROD=tms-app:prod-<previous-sha> docker compose -f compose.yml -f compose.prod.yml up -d` |
| bad code on dev | git | `git reset --hard pre-<change>` |
| bad data or a destructive migration | restore | §6, from the dump taken at step 3 |

Old image tags are retained — that is the entire point of tagging by commit sha, and it makes a
rollback seconds rather than a rebuild. The deploy script prints the exact rollback one-liner for
the environment it just touched; paste it into the deploy record.

**Migrations do not roll back.** Forward-only means the recovery from a bad migration is a new
migration that corrects it, or a restore. This is why destructive changes are two releases (§5) —
so the rollback is always "run the previous image", which always works.

Keep the previous environment intact for one week after a cutover from a predecessor system. A
whole-stack rollback is worth a week of disk.

---

## 9. Verification is a gate, not a monitor

`scripts/verify.mjs` — `npm run verify`, and the last step of `npm run reset` — is the assertion
suite over the database and the checked-out source. Seven groups, one named assertion per printed
row, a summary table per group, and a non-zero exit on any failure:

| Group | Asserts |
|---|---|
| schema | every migration file applied, every checksum intact, every table and view commented, every delete guard a migration declares installed |
| config | every `analytics_config` key a SQL or script reader names is loaded and holds the right type; one config version, matching the file on disk and active; the policy version likewise |
| framework | one active framework; competency and observable-behaviour counts equal to the seed (9 competencies, 73 observable behaviours, per-competency `7,7,10,6,7,11,9,7,9`); no orphaned or misparented observable behaviour |
| templates | every seeded template published, every published version re-validating through the builder's own publish rules as of its own `effective_from`, element keys unique within a version |
| data | no grade outside the configured vocabulary, every answer row resolving to an `element_key` in its own template version, no record without a snapshot, no child pointing at a parent that is gone, `framework_id` on every graded row |
| analytics | `grade_num` literal-safe and agreeing with the column path, every `av_*` view selectable, the indicator bands actually occurring in what the views return, the analysis-run states a fresh install must carry |
| access | route files exporting handlers and route config only; no client component reaching a server-only module, directly or transitively |

The assertions live in `scripts/verify/*.mjs`, one module per group.

The rules that make it worth running:

1. **It runs against a freshly migrated environment**, as a step in the deploy (step 9), before
   traffic. Running it later, against an environment that has been live for a week, tests the
   traffic rather than the release.
2. **It exits non-zero on any failure** and fails the deploy. A suite whose failures are reviewed
   later is a monitor, and a monitor does not stop a bad release.
3. **There is no "this data predates the check" escape.** The moment a check can be waived for old
   rows, every subsequent violation is indistinguishable from an old one and the check has stopped
   meaning anything. If a new invariant does not hold for existing data, the release includes the
   migration that makes it hold, or the invariant is not adopted. Data is fixed forward; checks are
   not narrowed to fit the data.
4. It is **deterministic and offline** — no model call, no network. It must produce the same
   verdict on a restored dump as on the live environment, which is what makes it usable in the
   restore drill.

---

## 10. Smoke checks fetch everything

`scripts/smoke-screens.mjs` (see the file) enumerates **every route and every subject page** and
fetches all of them. It does not sample. Sampling is how a single subject with an unusual record
shape takes down a page that nobody looks at until an auditor does.

**A 200 is not proof of rendering.** A server-rendered error boundary, an empty state where data
was expected, and a redirect chain that lands on a login page all return 200. Each route declares
an expected marker — a `data-testid`, a heading string, an element count — and the check asserts
the marker is present in the body. The script prints a table of route, status, marker, timing, and
exits non-zero on any failure.

Run it: after every deploy (step 10), against a restored dump during the restore drill, and in CI
against an ephemeral database seeded with the synthetic population.

---

## 11. Traps

- **One image tag shared by two environments.** A restart on one environment silently promotes the
  other's build. One variable per environment, and the §4.1 probe as a deploy assertion.
- **`latest` as a tag.** Nothing records what is running and nothing can be rolled back to.
- **Editing code on a deployed host.** The next deploy erases it and the symptom returns with no
  trace of the fix.
- **Copying an `.env` between hosts.** Carries the other environment's database, data root and
  secrets. Every host owns its own; the deploy never touches it.
- **Deploying without applying the migration.** Deploys cleanly, reads empty, looks like a code
  bug. Check the migration head in `/api/health` first.
- **A migration that derives reference data from present rows.** Different result on every dataset.
  Forbid it on deployed environments; ship verified rows as seed.
- **A migration runner that swallows `RAISE NOTICE`.** Subscribe to notice events or the migration
  reports nothing about what it skipped.
- **Using a published host port for container-to-container traffic.** Unreachable from inside;
  every PDF export fails with a bare fetch error. Use the service name and the internal port.
- **`host.docker.internal` or a host adapter IP in configuration.** The first does not resolve on
  Linux; the second is reassigned on reboot and breaks every call at once.
- **Trusting the host firewall to keep a Docker port private.** Docker bypasses it. Bind to
  `127.0.0.1`.
- **An unauthenticated local inference runtime bound to `0.0.0.0`.** An open model endpoint on the
  host's network. Loopback, or a subnet-scoped rule verified after every upgrade.
- **A backup that has never been restored.** Drill it, at realistic volume, and time it.
- **Restoring the database without `${DATA_ROOT}`.** Records reference files that are not there.
- **Verification run as a monitor.** Failures reviewed after the fact do not stop a release. Gate
  the deploy on it.
- **A "this data predates the check" waiver.** Kills the check permanently. Fix forward.
- **Smoke-testing a sample of pages.** The one page you did not fetch is the one an auditor opens.
- **Treating a 200 as proof.** Error boundaries, empty states and login redirects all return 200.
  Assert a marker in the body.
