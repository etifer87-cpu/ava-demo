# scaffold/deploy

Runnable compose stack for the TMS Kit. The authority for everything here is
`docs/15_DEPLOYMENT.md`; where this README and that document disagree, the document wins and
these files get fixed.

## What is here

| File | Role |
|---|---|
| `compose.yml` | base stack: `app`, `db` (PostgreSQL 17), `pdf`, plus optional `automation` and `inference` behind profiles. Never used alone for a deployed environment. |
| `compose.stage.yml` | stage overlay. Reads `APP_IMAGE_STAGE`. |
| `compose.prod.yml` | prod overlay. Reads `APP_IMAGE_PROD`. |
| `initdb/` | first-boot SQL: extensions and the schema-owning role only. Application schema is migrations, never an entrypoint script. |

Environment variables: copy `scaffold/.env.example` to `.env` beside these files, fill it in,
`chmod 600`. One `.env` per host. Never copy one between hosts - it carries the other
environment's database, data root and secrets.

## Run it

```bash
# stage
APP_IMAGE_STAGE=tms-app:stage-$(git rev-parse --short HEAD) \
  docker compose -f compose.yml -f compose.stage.yml up -d

# prod
APP_IMAGE_PROD=tms-app:prod-$(git rev-parse --short HEAD) \
  docker compose -f compose.yml -f compose.prod.yml up -d

# with the optional services
docker compose -f compose.yml -f compose.prod.yml --profile automation --profile inference up -d
```

The minimal deployment is `app + db + pdf`. With `automation` absent, ingestion is a manual
import. With `inference` absent and `LLM_BASE_URL` empty, the platform runs in degraded mode:
every figure, chart, table and export still renders and only generated prose is missing
(`docs/11_AI_PIPELINE.md` section 11).

## The one rule these files exist to enforce

**One image tag variable per environment.** `compose.stage.yml` reads `APP_IMAGE_STAGE`;
`compose.prod.yml` reads `APP_IMAGE_PROD`; `compose.yml` declares `${APP_IMAGE:?...}` with no
default so an overlay is mandatory. Tags are immutable and carry the commit sha. `latest` appears
nowhere.

A shared tag means a `docker compose up -d` on one environment picks up whatever the other last
built - a change reaching production with no deploy and no record. Prove they are separate after
every deploy (`docs/15` section 4.1):

```bash
docker inspect --format '{{.Config.Image}}' tms-stage-app
docker inspect --format '{{.Config.Image}}' tms-prod-app
curl -s https://<stage-host>/api/health | jq -r '.release, .env'
curl -s https://<prod-host>/api/health  | jq -r '.release, .env'
# then deploy to stage only and confirm prod's tag and release are byte-identical to before
```

## Ordering, per release

`docs/15` section 5 decides migrate-first or deploy-first. The short form: additive changes and
new enum values migrate first; a required NOT NULL column, a rename or a drop is two releases; a
destructive backfill deploys first and migrates in a window with a fresh backup. Code deploys
never apply migrations implicitly - a deploy that silently migrates cannot be rolled back by
re-deploying the previous image.

## Deploy and rollback

Ordered steps: `docs/15` section 7. Rollback levers: `docs/15` section 8. The short form:

```bash
# rollback code
APP_IMAGE_PROD=tms-app:prod-<previous-sha> \
  docker compose -f compose.yml -f compose.prod.yml up -d

# rollback data
gunzip -c dump-<date>.sql.gz | docker exec -i -e PGPASSWORD=... tms-prod-db psql -U postgres
```

## Gates

```bash
node ../scripts/migrate.mjs --env prod          # forward-only, idempotent, prints the head
node ../scripts/verify.mjs  --env prod          # NOT WRITTEN YET - see the note below
node ../scripts/smoke-screens.mjs --base http://127.0.0.1:3000
```

`verify.mjs` is specified by `docs/15_DEPLOYMENT.md` section 9 and **does not exist in this
scaffold yet**; the line above is what the gate will be, not a command that runs today. It runs
against a **freshly migrated** environment as a deploy step, not later against a
week of traffic, and there is no "this data predates the check" waiver - a waiver makes every
subsequent violation indistinguishable from an old one. `smoke-screens.mjs` fetches every route
and every subject page rather than sampling, and asserts an expected marker in each body: a 200
is not proof, because error boundaries, empty states and login redirects all return 200.

## Networking notes that cost real time

- Container-to-container traffic uses the **service name and the internal port**
  (`http://pdf:3000`), never the published host port - the published port is unreachable from
  inside another container and every PDF export fails with a bare fetch error.
- `host.docker.internal` does not resolve on Linux. A host virtual-adapter IP is reassigned on
  reboot and breaks every database call at once. Neither belongs in configuration.
- Every published port is bound to `127.0.0.1`. Docker writes its own iptables rules and bypasses
  the host firewall, so the loopback bind - not the firewall - is what keeps a port private.
- Public reach is the outbound tunnel only. Private services are reached over an SSH port-forward
  onto a **non-colliding** local port; the workstation is usually already listening on the same
  numbers.
- The optional local inference runtime has no authentication. Loopback, or a rule scoped exactly
  to the container subnet, re-verified after every runtime upgrade.
