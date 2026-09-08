# 01 · Isolation — names, ports, volumes

Two other stacks exist and must never be touched: the local training system on `localhost:3000`
with its own Docker, database and automation containers, and `demo.corvanox.com` on cvx-hel1.
Isolation here is by **name** (compose project, container, volume, network) and by **port**.
Both are fixed below and identical on the PC and on the server.

## Fixed names

| Thing | Value | Where set |
|---|---|---|
| Compose project | `ava` | `deploy/compose.yml` → `name: ava` |
| Containers | `ava-app`, `ava-db`, `ava-pdf` locally (base compose); `ava-prod-app`, `ava-prod-db`, `ava-prod-pdf` on the server (prod overlay) | `container_name:` in compose |
| Network | `ava` | compose `networks:` |
| Volumes | `ava_pgdata`, data root mounted from `DATA_ROOT` | compose + `.env` |
| Database | `ava_demo` · owner role `ava_owner` · migration role `ava_migrate` | `.env` (`POSTGRES_DB`, `POSTGRES_USER`, `DB_MIGRATION_ROLE`) |
| Session cookie | `ava_session` | `.env` `SESSION_COOKIE_NAME` |
| Image | `ava-demo:<git-sha>` | `.env` `APP_IMAGE_PROD` (server), `APP_IMAGE_STAGE` unused |

## Fixed ports (host side, loopback-bound by compose)

| Service | PC (`.env`) | cvx-hel1 (`.env`) | Reason |
|---|---|---|---|
| app | `APP_PORT=3100` | `APP_PORT=3100` | 3000 is taken locally; on the server the corvanox demo stacks own their own ports |
| db | `DB_PORT=5433` (compose.dev.yml) | `DB_PORT=5433` (compose.yml + prod overlay) | 5432 is taken by another local Postgres |
| pdf | `PDF_PORT=3101` | `PDF_PORT=3101` | keep the 31xx block for Ava |
| automation | not started | not started | out of scope |
| inference | not started | not started | out of scope |

Before the first `docker compose up` on either host, prove the ports are free:

```powershell
# PC
Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in 3100,5433,3101 }
docker ps --format "{{.Names}}  {{.Ports}}"
```

```bash
# cvx-hel1
ss -ltnp | grep -E ':(3100|5433|3101)\b'
docker compose ls
```

Both must return nothing for the Ava ports and must not list any `ava` project yet.

## Filesystem

| Host | Repo | Data root (`DATA_ROOT`) | `.env` |
|---|---|---|---|
| PC | `C:\Avianca TMS` | `C:\Avianca TMS\data` (git-ignored) | `C:\Avianca TMS\scaffold\.env` |
| cvx-hel1 | `/opt/ava/repo` | `/opt/ava/data` | `/opt/ava/repo/scaffold/.env` (chmod 600) |

The corvanox demo lives elsewhere on the same box under its own directory and compose project.
Nothing under `/opt/ava` references it and nothing outside `/opt/ava` is edited by an Ava session.

## Cloudflare

One hostname, one ingress rule, one Access application — all scoped to `avademo.corvanox.com`:

- Tunnel: the existing Corvanox-team tunnel on cvx-hel1. Add an ingress entry
  `avademo.corvanox.com → http://localhost:3100`. Do not reorder or edit other entries.
- DNS: one CNAME `avademo` → the tunnel. Never MX, SPF or any apex record.
- Access: application `Ava demo` on `avademo.corvanox.com`, policy one-time PIN for an allowlist of
  e-mail addresses. Same shape as `demo.corvanox.com`; a separate application.

## The neutrality gate

`npm run verify` includes a full-text scan of the repository against the word list at
`NEUTRALITY_WORDLIST` (a path outside the repo, set in `.env`). The list names every string that
must never appear here: other operators, their cities, their LMS vendors, their hostnames, their
legacy skill vocabulary. A hit is a failed gate, and the fix is removal, never an exception entry.
