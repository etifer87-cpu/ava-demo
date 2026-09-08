# 04 · ETR — the electronic training record module

Purpose: how a training event is created, graded, signed, frozen into a record, and read back.
Status: spec + scaffolded (migrations 0020–0039, `scaffold/lib/etr/*`)
Version: v1.0 · 2026-08-26

ETR is a module of the platform, not a product. It owns sessions, grades, signatures, records and
the record report. It does not own the framework (`docs/03`), the template (`docs/05`), the metrics
(`docs/06`) or the qualification rules (`docs/08`).

---

## 1. Two paths, one home

A record reaches the database two ways:

- **Path A — in-app session.** An assessor creates a session against a published template version,
  grades it, both parties sign, the system freezes a record and renders its report.
- **Path B — ingest or import.** An externally produced record (a PDF, an assessment workbook
  exported from a predecessor system) is extracted and loaded.

Both paths write **the same tables** — `records`, `record_tasks`, `record_competencies` — with
`records.source IN ('app','import','ingest')`. This is the single most important structural rule in
the module: any read surface that queries one path only reports zeros for the other, and it does so
silently. In the system this kit is distilled from, a dashboard once showed 44 assessors with
all-zero statistics for exactly this reason.

## 2. Lifecycle

```
draft ─grade─▶ in_progress ─preview─▶ (unchanged) ─sign #1─▶ locked
                                                     │
                                             sign #2 ▼
                                                  signed ─submit─▶ finalized ─▶ record + report
```

| State | Who can change what |
|---|---|
| `in_progress` | assessor edits grades, remarks, OB selections, outcomes freely |
| after the **first** signature by **either** party | everything locks — no field, no grade, no remark |
| both signed | still locked; the submit action unlocks |
| `finalized` | permanent; the record and its report exist; the session is never auto-deleted |

Locking on the **first** signature, not the last, is deliberate: otherwise one party can edit after
the other has attested to what they signed.

**Amendment is unsign, never edit-in-place.** Unsign is an administrative action, password-confirmed
by the acting user, audited, and it clears both signature stamps and returns the session to
`in_progress`. There is no silent correction path.

**Signature semantics.** The signature is an identity assertion, not a drawn image: a disclaimer,
then the signer types their own person id, then confirm. Stored as `signed_at` + `signer_person_id`
+ `signature_method`. A record imported from a predecessor system stores the original signing date
and names and is rendered as "signed on <date>" **without** the electronic-signature wording — it was
not signed here, and claiming it was is a governance defect (`docs/17_GOVERNANCE.md`).

## 3. What gets graded

Three independent layers, each optional per template:

| Layer | Table | Grain | Values |
|---|---|---|---|
| element (task / manoeuvre / item) | `element_grades` | subject x `element_key` x `attempt` | `1..5`, `NR`, `NO`, or `Yes`/`No` for a boolean element |
| competency | `competency_grades` | subject x `competency_id` | `1..5`, `NR`, `NO` |
| observable behaviour | `competency_grade_obs` | competency grade x `observable_behaviour_id` | selected / not selected |

OBs are **selected, not graded**. A free-text remark is never parsed into OBs, and an OB is never
invented or paraphrased from a remark.

**A repeat is a row.** `element_grades.attempt` starts at 1 and increments; every attempt is its own
grade event. Storing only the latest grade hides the initial failure — a task graded 2 and then 4 on
the repeat reads as "meets standard" and the deficiency disappears from every metric. In the source
system, expanding attempts at read time nearly doubled the true below-standard count for one cycle.

**Outcome is never inferred.** `records.outcome ∈ (PASS, FAIL, PARTIAL PASS, INCOMPLETE)` is read
from an explicit outcome field only. Not from task grades, not from the narrative, not from the word
"fail" appearing in a remark, not from a "reason for remedial training" field — that explains why the
session is happening, not how it ended. A system-computed suggestion may be stored alongside
(`outcome_auto`) and shown to the assessor, but the human value is the record.

## 4. Session types

Two orthogonal axes, and conflating them is a design error:

1. **`session_templates.template_kind`** — a controlled vocabulary from `config/policy.yaml`,
   shared by the builder and the session-create filter. The kit ships a neutral starter list:
   `ground_school · simulator_recurrent · proficiency_check · line_check · line_supervised ·
   command_upgrade · crm · low_visibility · upset_recovery · aerodrome_competence · assessment ·
   other`. It is configuration; an operator edits it without touching code.
2. **`records.record_type`** — free text carried on the record itself, because an ingested record
   says what it says. Everything downstream matches it tolerantly (case-insensitive, normalised),
   never by equality.

How the kinds differ in practice:

| Kind | Facility | Form shape | Data shape |
|---|---|---|---|
| ground school | classroom | no setup block, no malfunctions; one event, many subjects, one outcome plus optional per-subject grades | fan-out: signing produces one record per subject |
| simulator | full-flight simulator / training device | the full form: setup grid, section headers, reset blocks, graded events with role and attempts, malfunction multi-select, competency block | the richest data; repeats and OBs both present |
| line check | line | competency block, no simulator setup, no malfunctions | **no repeat attempts exist** — repeat logic is skipped, not zeroed; asset class often unset and must fall back to the subject's current class |
| supervised line flying | line | **one record = one sector**, no repeatable leg group | finalise writes exactly one `line_sectors` row; all counters are derived, never stored (`docs/05` §7) |
| assessment / selection | any | restricted template, hidden from the subject entirely | carries a stand-down period and an attempt number on the record |

## 5. The record form

The form is a rendering of a **published template version** (`docs/05`), plus five things the
renderer owns natively and no template may re-declare:

1. **Session header and setup grid** — from the template version's `session_setup`.
2. **Subject cards** — 1..N subjects, each with a seat role; every graded element is graded per
   subject.
3. **Competency block** — the framework's competencies with their OB pickers, grade selector and
   remark, per subject; each competency independently collapsible.
4. **Outcome selector** — per subject, saved on click.
5. **Remarks and signatures** — session narrative, then the two signature blocks.

A template that declares its own "Remarks" section produces a visible duplicate in the report; the
builder rejects reserved titles at authoring time.

**Save semantics.** Grades save immediately on click, one write per click — a grade is the thing a
person will be held to and must not sit in a debounce buffer. Remarks debounce (~800 ms) into a
pending map keyed by element and subject, and the pending map is flushed before any preview or
navigation. The grading surface must never unmount while the session is open (toggle visibility
rather than conditionally rendering) or in-progress state is lost on preview.

## 6. Freezing the record

On submit, for each subject:

1. Render the report HTML from the database (never from the DOM).
2. Convert to PDF through the shared renderer, store under the subject's routed folder by type and
   year, and record the returned filename — the renderer may have de-duplicated it.
3. Write `records` with the identity of the moment: subject position, asset class, assessor name and
   licence, facility, outcome, remarks, template version id, framework id.
4. Write `record_tasks` and `record_competencies` from the session's grades, attempts included.
5. Write `records.snapshot JSONB` — everything the report needs, so the record still renders
   correctly after its template version is retired.

`snapshot.competency_scores` and `snapshot.tasks` are **arrays of objects**, never keyed maps: a map
crashes consumers that filter, and it breaks the radar. Scores in the snapshot are numeric with
`NR`/`NO` removed.

**Point-in-time truth.** The record keeps the subject's position and asset class *as of the session*.
The roster keeps the current state and is never overwritten by an import. Reports, seat filters and
fleet analytics read the record's own values, falling back to the roster only where the record has
none.

## 7. Reports

One template module renders both the on-screen preview and the PDF. They cannot diverge because they
are the same function.

Block order: title bar (logo embedded as a data URI, not a file reference) · objectives · personal
details (subject and assessor: name, id, position, licence) · event details · failure management
(scenario names, selected malfunctions) · element performance (section headers, graded elements, all
attempts labelled, verbatim comments) · competency assessment (competency, grade, selected OBs one
per line, remark) · session remarks · signatures.

The subject-facing viewer is a pop-up with no download affordance where policy withholds downloads;
the capability, not the UI, is what enforces that (`docs/12`).

**The analysis report** (`analysis_runs`) is a separate output: a narrative assembled over a chosen
set of records, with the nine competency trend charts, strengths, development areas and root-cause
section. Every figure in it comes from SQL; the model narrates only, and the narrative is gated
against the computed figure set before it is stored (`docs/11` §6).

## 8. Import and ingest

**The golden rule: all data is imported, nothing is invented.** Every element grade, comment,
narrative, competency grade, OB and repeat attempt comes over verbatim. `NO`/`NR`/`N/A`/blank become
NULL. Sparse source data stays sparse — if the source recorded a competency block on four records
out of seventy-two, four records get competency grades and the rest do not.

| Concern | Rule |
|---|---|
| template link | by template code, or by exact normalised name; the template version must exist **before** the import, and the loader aborts on a missing or ambiguous match |
| element mapping | by `external_ref` (the syllabus item number) or by title for boolean items; **unmatched elements are dropped**, so a pre-flight mapping check is mandatory, not optional |
| subject matching | id in roster → import under it; id absent but name matches → import under the roster's current id and list the substitution for review; neither → create as an inactive historical person, no login; blank id → hold, do not import, list for manual resolution |
| dedup | `(subject_id, record_date, template_name)`; re-runs skip existing rows so an interrupted run is simply re-run. Idempotency must live in the database, not in a progress file — a progress file deleted before a re-run duplicates everything |
| dates | day-first in this domain. Parse explicitly, reject impossible dates, flag dates more than 90 days future or absurdly past, and rebuild any derived filename if the date changes |
| filename | `{yyyy_mm_dd}_{record_title}_{subject_external_id}.pdf`, built **server-side** from the record's own date — never the ingestion date, never a name the pipeline invented |
| verification | before sign-off, record count, element-grade count, OB count, remark count, comment count and grade distribution must each match the extract audit exactly |

## 9. Traps

- **Reading one source home reports zeros.** Union app-produced and imported records in every
  aggregate. See §1.
- **The last attempt is not the grade history.** Expand attempts at read time; only multi-attempt
  rows expand, and rows whose attempt list has no parseable grade must keep their recorded grade
  rather than being dropped.
- **An outcome must never be inferred** from grades, objectives, conclusions or the word "fail".
- **Locking on the second signature** lets one party edit after the other signed. Lock on the first.
- **An element identity that an editor can destroy destroys its answers.** Answers key on
  `element_key`; see `docs/05` §5.
- **Element titles carry syllabus numbers and syllabus numbers get renumbered.** One logical element
  fragments across several analytic buckets. Group by base name at read time; never derive identity
  from a number the syllabus owner controls.
- **`NR` is structural, not behavioural.** Some record types are entirely `NR` by design. A raw
  `NR` rate penalises an assessor for the rostering they were given; measure excess over an expected
  baseline per (type, family).
- **Deleting is moving.** Every delete moves the file to the retention store, date-prefixed and
  collision-safe, and writes an audit row. Deleting a record additionally requires the acting user
  to re-enter their own password, verified server-side, fail-closed.
- **A failed write must fail loudly.** Sign, unsign, finalise, update and delete return an error on a
  failed database write; a delete runs children before parent, sequentially, so it cannot half-delete
  and report success.
- **Folder lookup by bare id never matches.** Subject folders are named `{id}_{Last}_{First}`; scan
  for the `{id}_` prefix, or the file cleanup silently never runs.
- **All data lands at load time; the render step only renders.** A pipeline that defers a field to
  PDF generation loses it from the database.
