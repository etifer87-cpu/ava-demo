# 03 · Competency framework (ICAO/EASA)

Purpose: the single source of the assessment vocabulary. Every grade, prompt, view, chart axis and
report label in the platform derives from this file.
Status: spec + scaffolded (`scaffold/db/seed/competency_framework.json`, migrations 0040–0059)
Version: v1.0 · 2026-08-26

---

## 1. Model

Nine competencies, each with a fixed set of observable behaviours (OBs), graded on a 1–5 scale.
Aligned to the ICAO competency framework (PANS-TRG Doc 9868) and EASA Part-FCL / Part-ORO
CBTA/EBT, and to the IATA competency assessment guidance for pilots and instructors/evaluators.

The framework is **data, not code**. It lives in three tables and is versioned:

```
competency_frameworks (id, code, name, edition, source_ref, effective_from, is_active)
  └── competencies (id, framework_id, code, index, name, description, colour, position)
        └── observable_behaviours (id, competency_id, code, text, position, is_active)
```

Every graded row carries `framework_id`. Two frameworks therefore coexist without a data
migration: records graded under an earlier framework stay readable exactly as graded, and
analytics scope to one framework at a time. Adding a tenth local competency, renaming one, or
adopting an EBT variant is an INSERT, never a schema change.

**Nothing outside these tables may key on a competency name or an OB string.** Grades reference
`competency_id`; OB selections reference `observable_behaviour_id`. See `docs/16_TRAPS.md` §1.

## 2. The nine competencies

Index follows the OB numbering of the source (0–8).

| # | Code | Competency | Description | Colour |
|---|---|---|---|---|
| 0 | `KNO` | Application of Knowledge | Demonstrates knowledge and understanding of relevant information, operating instructions, aircraft systems and the operating environment | `#2563EB` |
| 1 | `PRO` | Application of Procedures and Compliance with Regulations | Identifies and applies appropriate procedures in accordance with published operating instructions and applicable regulations | `#DB2777` |
| 2 | `COM` | Communication | Communicates through appropriate means in the operational environment, in both normal and non-normal situations | `#F59E0B` |
| 3 | `FPA` | Aeroplane Flight Path Management, automation | Controls the flight path through automation | `#0891B2` |
| 4 | `FPM` | Aeroplane Flight Path Management, manual control | Controls the flight path through manual control | `#0F766E` |
| 5 | `LTW` | Leadership and Teamwork | Influences others to contribute to a shared purpose; collaborates to accomplish the goals of the team | `#CA8A04` |
| 6 | `PSD` | Problem Solving and Decision-Making | Identifies precursors, mitigates problems and makes decisions | `#7C3AED` |
| 7 | `SAW` | Situation Awareness and Management of Information | Perceives, comprehends and manages information and anticipates its effect on the operation | `#DC2626` |
| 8 | `WLM` | Workload Management | Maintains available workload capacity by prioritizing and distributing tasks using appropriate resources | `#059669` |

Colours are placeholder tokens chosen for hue separation, not brand values — see
`docs/13_DESIGN_SYSTEM.md` for the swap procedure and the contrast requirement. They are stored in
`competencies.colour`, so a rebrand is an UPDATE.

## 3. Observable behaviours — 73, verbatim

OB counts per competency: **7 · 7 · 10 · 6 · 7 · 11 · 9 · 7 · 9 = 73**. This is the seed
verification assertion; a seed that produces any other count is rejected.

### 0 · KNO — Application of Knowledge
| Code | Observable behaviour |
|---|---|
| OB 0.1 | Demonstrates practical and applicable knowledge of limitations and systems and their interaction |
| OB 0.2 | Demonstrates required knowledge of published operating instructions |
| OB 0.3 | Demonstrates knowledge of the physical environment, the air traffic environment including routings, weather, airports and the operational infrastructure |
| OB 0.4 | Demonstrates appropriate knowledge of applicable legislation |
| OB 0.5 | Knows where to source required information |
| OB 0.6 | Demonstrates a positive interest in acquiring knowledge |
| OB 0.7 | Is able to apply knowledge effectively |

### 1 · PRO — Application of Procedures and Compliance with Regulations
| Code | Observable behaviour |
|---|---|
| OB 1.1 | Identifies where to find procedures and regulations |
| OB 1.2 | Applies relevant operating instructions, procedures and techniques in a timely manner |
| OB 1.3 | Follows SOPs unless a higher degree of safety dictates an appropriate deviation |
| OB 1.4 | Operates aeroplane systems and associated equipment correctly |
| OB 1.5 | Monitors aircraft systems status |
| OB 1.6 | Complies with applicable regulations |
| OB 1.7 | Applies relevant procedural knowledge |

### 2 · COM — Communication
| Code | Observable behaviour |
|---|---|
| OB 2.1 | Determines that the recipient is ready and able to receive information |
| OB 2.2 | Selects appropriately what, when, how and with whom to communicate |
| OB 2.3 | Conveys messages clearly, accurately and concisely |
| OB 2.4 | Confirms that the recipient demonstrates understanding of important information |
| OB 2.5 | Listens actively and demonstrates understanding when receiving information |
| OB 2.6 | Asks relevant and effective questions |
| OB 2.7 | Uses appropriate escalation in communication to resolve identified deviations |
| OB 2.8 | Uses and interprets non-verbal communication in a manner appropriate to the organizational and social culture |
| OB 2.9 | Adheres to standard radiotelephone phraseology and procedures |
| OB 2.10 | Accurately reads, interprets, constructs and responds to datalink messages in English |

### 3 · FPA — Flight Path Management, automation
| Code | Observable behaviour |
|---|---|
| OB 3.1 | Uses appropriate flight management, guidance systems and automation, as installed and applicable to the conditions |
| OB 3.2 | Monitors and detects deviations from the intended flight path and takes appropriate action |
| OB 3.3 | Manages the flight path safely to achieve optimum operational performance |
| OB 3.4 | Maintains the intended flight path during flight using automation while managing other tasks and distractions |
| OB 3.5 | Selects appropriate level and mode of automation in a timely manner considering phase of flight and workload |
| OB 3.6 | Effectively monitors automation, including engagement and automatic mode transitions |

### 4 · FPM — Flight Path Management, manual control
| Code | Observable behaviour |
|---|---|
| OB 4.1 | Controls the aircraft manually with accuracy and smoothness as appropriate to the situation |
| OB 4.2 | Monitors and detects deviations from the intended flight path and takes appropriate action |
| OB 4.3 | Manually controls the aeroplane using the relationship between aeroplane attitude, speed and thrust, and navigation signals or visual information |
| OB 4.4 | Manages the flight path safely to achieve optimum operational performance |
| OB 4.5 | Maintains the intended flight path during manual flight while managing other tasks and distractions |
| OB 4.6 | Uses appropriate flight management and guidance systems, as installed and applicable to the conditions |
| OB 4.7 | Effectively monitors flight guidance systems including engagement and automatic mode transitions |

### 5 · LTW — Leadership and Teamwork
| Code | Observable behaviour |
|---|---|
| OB 5.1 | Encourages team participation and open communication |
| OB 5.2 | Demonstrates initiative and provides direction when required |
| OB 5.3 | Engages others in planning |
| OB 5.4 | Considers inputs from others |
| OB 5.5 | Gives and receives feedback constructively |
| OB 5.6 | Addresses and resolves conflicts and disagreements in a constructive manner |
| OB 5.7 | Exercises decisive leadership when required |
| OB 5.8 | Accepts responsibility for decisions and actions |
| OB 5.9 | Carries out instructions when directed |
| OB 5.10 | Applies effective intervention strategies to resolve identified deviations |
| OB 5.11 | Manages cultural and language challenges, as applicable |

### 6 · PSD — Problem Solving and Decision-Making
| Code | Observable behaviour |
|---|---|
| OB 6.1 | Identifies, assesses and manages threats and errors in a timely manner |
| OB 6.2 | Seeks accurate and adequate information from appropriate sources |
| OB 6.3 | Identifies and verifies what and why things have gone wrong, if appropriate |
| OB 6.4 | Perseveres in working through problems while prioritizing safety |
| OB 6.5 | Identifies and considers appropriate options |
| OB 6.6 | Applies appropriate and timely decision-making techniques |
| OB 6.7 | Monitors, reviews and adapts decisions as required |
| OB 6.8 | Adapts when faced with situations where no guidance or procedure exists |
| OB 6.9 | Demonstrates resilience when encountering an unexpected event |

### 7 · SAW — Situation Awareness and Management of Information
| Code | Observable behaviour |
|---|---|
| OB 7.1 | Monitors and assesses the state of the aeroplane and its systems |
| OB 7.2 | Monitors and assesses the aeroplane's energy state, and its anticipated flight path |
| OB 7.3 | Monitors and assesses the general environment as it may affect the operation |
| OB 7.4 | Validates the accuracy of information and checks for gross errors |
| OB 7.5 | Maintains awareness of the people involved in or affected by the operation and their capacity to perform as expected |
| OB 7.6 | Develops effective contingency plans based upon potential risks associated with threats and errors |
| OB 7.7 | Responds to indications of reduced situation awareness |

### 8 · WLM — Workload Management
| Code | Observable behaviour |
|---|---|
| OB 8.1 | Exercises self-control in all situations |
| OB 8.2 | Plans, prioritizes and schedules appropriate tasks effectively |
| OB 8.3 | Manages time efficiently when carrying out tasks |
| OB 8.4 | Offers and gives assistance |
| OB 8.5 | Delegates tasks |
| OB 8.6 | Seeks and accepts assistance, when appropriate |
| OB 8.7 | Monitors, reviews and cross-checks actions conscientiously |
| OB 8.8 | Verifies that tasks are completed to the expected outcome |
| OB 8.9 | Manages and recovers from interruptions, distractions, variations and failures effectively while performing tasks |

## 4. Grading scale

| Grade | How well | TEM outcome | Competent | Remedial | Colour |
|---|---|---|---|---|---|
| 1 | ineffectively | unsafe situation | no | required | `#B91C1C` |
| 2 | minimum acceptable | not an unsafe situation | yes, limited | per policy | `#F59E0B` |
| 3 | adequately | safe | yes | no | `#65A30D` |
| 4 | effectively | safe | yes | no | `#15803D` |
| 5 | exemplary | enhances safety | yes | no | `#1D4ED8` |

Non-scoring codes stored alongside grades: `NR` (not required), `NO` (not observed), `NA`.
All three resolve to NULL and are excluded from **both** numerator and denominator of every
metric. They are never mentioned in generated narrative.

**Below standard = grade 1 or 2.** This is the one definition the whole analytics layer rests on;
it is stated once, in `scaffold/config/analytics.yaml`, and read from there.

Grade columns are `TEXT`, not `INTEGER` — `NR`/`NO` must be storable in the same column. Numeric
coercion happens in one SQL function (`grade_num(text) -> int`, returns NULL unless `^[1-5]$`),
which is the single definition of "valid grade" in the system.

## 5. How a grade is derived

Two dimensions of the OBs actually observed:

- **How many** were demonstrated: few → some → many → most → all
- **How often** they were demonstrated: rarely → occasionally → regularly → always

`how_well = min(how_many, how_often)`, then adjusted by the TEM outcome: an unsafe situation caps
the grade at 1; behaviour that enhances safety supports a 5. Where a curriculum mandates OB-only
assessment, the TEM adjustment is omitted.

OBs are **selected, not graded**. A competency grade carries a set of OB references and a free-text
remark. Free-text remarks are never parsed as OBs.

**Performance policy** (operator-configurable, `scaffold/config/policy.yaml`, defaults shown):
target grade 3 in every competency; grade 2 acceptable in a limited number of competencies;
remedial training required for any grade 1, for two successive grades of 2 in the same competency,
or on assessor judgement that grade 3 will not be reached by the next session.

## 6. Seed and verification

Seed source: `scaffold/db/seed/competency_framework.json`, loaded by `scripts/seed-framework.mjs`.

The seeder asserts, and fails loudly on any mismatch:

1. exactly 9 competencies, codes and order as §2;
2. OB counts per competency `7,7,10,6,7,11,9,7,9`, total 73;
3. every OB code matches `^OB [0-8]\.\d{1,2}$` and is unique;
4. OB text byte-matches this document (the JSON is generated from it, never hand-edited);
5. every competency has a colour that passes the contrast rule in `docs/13_DESIGN_SYSTEM.md`.

## 7. Extension points

| Want | Do |
|---|---|
| add a local 10th competency | INSERT into `competencies` with `index = 9`; the radar renders 10 spokes from the row count, nothing is hardcoded to 9 |
| adopt an EBT grading grid | new `competency_frameworks` row, same competencies, different grade descriptors in `config/policy.yaml` |
| operator wording changes | UPDATE `competencies.name` / `observable_behaviours.text`; no code, no prompts, no migration |
| a different domain entirely (cabin crew, dispatch, maintenance) | replace the seed JSON; nothing else in the platform knows what a competency is about |

## 8. Traps

- **A name is not a key.** Any join, prompt guard, config file or chart axis that matches on the
  competency name will silently de-align the first time wording changes ("and" vs "&", "Situation"
  vs "Situational"). Join on ids. Display names late.
- **A framework change is not a rename.** Moving from a nine-skill in-house model to this one
  splits two dimensions and absorbs two others; historical grades cannot be split retroactively.
  Version the framework, keep old grades read-only under their own `framework_id`, start new
  baselines at the cut-over. Force-mapping corrupts every trend line.
- **Prompts and insert-guards must change together.** If an extraction prompt is updated but the
  "insert all competencies in canonical order" guard is not, the old vocabulary reappears with no
  error. In this kit both read the framework from the database at runtime, which is the fix.
- **A grade of 1 must not average away.** See the non-compensatory screening index in
  `docs/06_ANALYTICS.md`.
