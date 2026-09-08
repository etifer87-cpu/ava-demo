# 04 · Seed dataset — the synthetic Avianca population

All data is synthetic, generated deterministically by `npm run seed:synthetic` from a fixed seed,
and regenerable on any host. No real person, licence number, record or document exists in it.
The generator is the kit's (`kit-docs/14`); this document sets its **parameters** and the handful
of **named fixtures** the demo script depends on.

## Operator context (`scaffold/config/policy.yaml`)

| Setting | Value |
|---|---|
| Operator display name | Avianca |
| Org units (bases) | BOG · MDE · CLO · CTG (AOC `AV-COL` under operator `AV`; department `TRG`) |
| Asset classes (fleets) | A320 (A319/A320/A321) · A330 · B787; devices FFS-A320 / FFS-A330 / FFS-B787 at CAE Bogotá |
| Subject label | Pilot |
| Positions | CP · FO · CRFO |
| Seats | PF · PM · observer · relief |
| Instructor roles | TRE · TRI · SFE · SFI · LTC · CRMI · GI |
| Outcomes | PASS · FAIL · PARTIAL PASS · INCOMPLETE · PROFICIENT (= PASS) · NOT PROFICIENT (= FAIL) |
| Grading scale | kit default 1–5 with NR/NO/NA |
| Framework | ICAO 9 competencies / 73 OBs, unmodified |

## Population

| Group | Count | Notes |
|---|---|---|
| Subjects (pilots) | 48 | A320 28 · A330 10 · B787 10; CPT/FO ≈ 45/55; employee ids `AV-1xxxx` |
| Instructors / evaluators | 8 | TRI/TRE and line-check captains, at least two per fleet |
| Training managers | 2 | Camila Restrepo (Training Standards Manager), one Head of Training |
| Programmes | 7 | see table below |
| Sessions | ~360 over 24 months | every screening band populated, including insufficient |
| Records | ~600 | in-app and imported sources both present |
| Documents | ~40 | manuals, regulatory, training records; one synthetic programme manual PDF |

Names are Spanish-language Colombian names generated from a first-name / surname list in the seed
JSON. Any resemblance to a real Avianca employee is coincidental and the lists must not be built
from any real crew list.

## Programmes

| Programme | Fleet | Type | Seeded version |
|---|---|---|---|
| A320 EBT Recurrent · Module 3 | A320 | ebt_recurrent | v2 published, v3 authored live in the demo |
| A330 EBT Recurrent · B787 EBT Recurrent | A330 · B787 | ebt_recurrent | v1 each |
| A320 OPC / LPC | A320 | proficiency_check | v1 |
| A320 Type Rating (initial) | A320 | type_rating | v1 |
| Command Upgrade | all | command_upgrade | v1 |
| Line Check | all | line_check | v1 |

## Named fixtures the script depends on

| Fixture | Role | Requirement |
|---|---|---|
| Camila Restrepo | training_manager | demo login; can publish, view analysis, audit |
| Andrés Mejía | instructor, A320 TRI | has an open session today with Valentina Ochoa on A320 EBT Recurrent |
| Valentina Ochoa | FO A320, `AV-10417` | band `monitor`; ≥ 8 records over 18 months; three analysis runs: complete (provenance 1.000), pending, rejected |
| B787 expiries | QMS | ≥ 5 qualifications expiring within 30 days, ≥ 1 already expired |
| `Avianca_EBT_Programme_Manual_v1.pdf` | DMS | synthetic 6-page PDF under `seed/documents/`, uploaded live in step 7 |

## Qualification types (QMS)

Line Check · OPC · LPC · Type Rating · Recurrent Training · CRM Recurrent · Dangerous Goods ·
Emergency & Safety Equipment · RVSM/PBN · ETOPS (A330/B787 only) · Medical — each with an
interval and a grace rule in the definition, seeded as published v1.

## Invariants the seeder asserts

- 7,7,10,6,7,11,9,7,9 = 73 observable behaviours (kit rule).
- Every screening band occurs for at least two subjects.
- The three named fixtures exist with exactly the states above.
- Two runs from a fresh database produce byte-identical output.
- The neutrality scan finds nothing.
