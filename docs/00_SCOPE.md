# 00 · Scope — Avianca TMS demo

Status: agreed 2026-09-08 · Target: demo to Avianca by **2026-09-29** (2–3 weeks)

## Purpose

A live, branded instance of the Corvanox training platform that lets Avianca's training leadership
see, in fifteen minutes, how a competency-based training programme is authored, delivered, graded,
signed, analysed and kept in compliance — on synthetic data that looks like their operation.

## In scope

| Module | What the demo shows | Kit spec |
|---|---|---|
| Program Builder | Open a programme template, edit the canvas, pick competencies / observable behaviours, publish an immutable version | `kit-docs/05` |
| ETR | Instructor grades a session against that template, signs, record freezes, PDF renders | `kit-docs/04` |
| Analytics | Subject profile (KPIs, radar, trends), fleet overview, screening bands | `kit-docs/06`, `07` |
| AI narrative | One analysis run narrated by the model and gated by provenance; one run rejected by the gate; degraded mode is the default state | `kit-docs/11` |
| QMS | Qualification expiry dashboard by fleet, one qualification definition | `kit-docs/08` |
| DMS | Document library, upload, ingestion status | `kit-docs/09` |
| Platform | Roles, audit log, Avianca brand, PDF export | `kit-docs/12`, `13` |

## Out of scope — do not build

- Dispatch / crew scheduling / roster of any kind.
- LMS, crew-scheduling or SSO integration (`kit-docs/10`).
- Mobile / offline client.
- Automation runner (workflow-orchestrator service). Ingest and analysis run as in-app routes for the demo.
- Local inference container. The inference seam points at a hosted API or stays empty.
- Spanish interface. English only for now (decided 2026-09-08); Spanish is a later roll-out item.

## Assumptions

- Avianca operates A320-family, A330 and B787 fleets from BOG, MDE, CLO and CTG, trains at the CAE
  centre in Bogotá, and is already on EBT (OPC/LPC kept alongside). Programmes use the ICAO
  competency framework. The demo speaks that language and no other.
- The audience is Head of Training / Training Standards, not IT. Screens matter more than APIs.
- Data is synthetic, deterministic, and regenerable on the server from the repo alone.

## Success criteria

1. `docs/03_DEMO_SCRIPT.md` runs end to end on `https://avademo.corvanox.com` without a workaround.
2. The same script runs locally on `http://localhost:3100` as the fallback.
3. `npm run verify` is green on both, including the neutrality scan.
4. Nothing on the server was put there by hand: `git pull` + `docker compose up` + `npm run reset`.
