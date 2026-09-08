# 11 · AI pipeline

Purpose: how documents become records and how records become narrative, as a blueprint that can be
re-implemented in any orchestrator or in plain server code, with the deterministic core intact.
Status: spec + scaffolded (`scaffold/automation/`, `scaffold/lib/inference.ts`, `scaffold/lib/provenance.ts`)
Version: v1.0 · 2026-08-26

---

## 1. The invariant

**The deterministic core computes every figure. The model only narrates. Narration is checked
against the computed figure set before it is stored.**

Read that as three separate obligations:

1. No number in a report, chart, dashboard tile, export or certificate originates in a model.
   Counts, averages, trends, below-standard tallies, session totals, dates and grades all come
   from SQL over `records`, `competency_grades` and `element_grades` (`docs/06_ANALYTICS.md`).
2. The model receives those computed figures as input and produces prose that refers to them. It
   is never asked to compute, aggregate, rank or count.
3. Before any generated prose is persisted, every number appearing in it is extracted and matched
   against the figure set that was supplied. Unmatched numbers fail the gate. See §9.

The corollary is the design rule that makes the whole pipeline testable: **remove the model and
the platform still works** — every figure, chart and table renders, only the prose paragraphs are
absent. That is degraded mode (§11), and it is a supported, tested state, not an outage.

---

## 2. Two pipelines

| Pipeline | Trigger | Input | Output | Model calls |
|---|---|---|---|---|
| **Ingest** — document to record | file arrives (upload, watched folder, batch import) | one file | one `records` row with `source='ingest'`, plus `record_tasks` / `record_competencies` children | 0 or 1 |
| **Analyse** — subject to narrative | user or scheduler requests an analysis of one subject | N records already in the database | one `analysis_runs` row with structured findings and rendered HTML | 1 or 2 |

Both run **out of the interactive request path**. The interactive budget is under two seconds for
95% of actions; a model call is not compatible with that. The request creates a run row with
`status='queued'` and returns immediately; the client polls or subscribes.

Both are optional. Ingest exists because operators arrive with a backlog of legacy PDFs. Analyse
exists because reading forty records is not a job for a human. Neither is a dependency of the app.

---

## 3. Ingest pipeline, stage by stage

```
 1 receive          file + subject hint + actor
 2 store            write to content-addressed path, compute sha256
 3 dedup            sha256 seen for this subject? -> stop, return existing record id
 4 extract          native text extraction from the file, no model
 5 clean            control-char strip, whitespace collapse, hard truncate
 6 pre-classify     deterministic marker count -> is_record_candidate (no model call)
 7a not a candidate -> write a non-record row (notes only), stop.        NO MODEL CALL
 7b candidate      -> fast-tier extraction call, JSON mode, schema-validated
 8 repair-retry     one retry on invalid JSON, then fail loud
 9 normalise        project onto the framework loaded from the database
10 date repair      day-first repair rules, flag-not-fix out-of-range
11 validate         required keys present, enums clamped, ranges clamped
12 insert           idempotent upsert on the dedup key, children in one transaction
13 file             move to canonical path, patch the row atomically
```

### 3.1 The deterministic pre-classifier (stage 6)

**Nothing calls a model to find out whether a document is worth a model call.** The classifier is
a pure function over the cleaned text and costs microseconds:

```
markers = [ "grading", "assessment", "session", "assessor", "signature",
            "competency", "observable", "aircraft", "date of" ]        # config, not code
count   = number of distinct markers found (case-folded, substring)
is_record_candidate = count >= MIN_MARKERS                             # default 2
```

Marker list and threshold live in `scaffold/config/ingest.yaml`. Tune the threshold by measuring
against a labelled sample, not by intuition.

Traffic that fails the gate is not discarded and is not an error. It becomes a row with
`source='ingest'`, `is_record=false`, all grade fields NULL, `notes` = the first 6000 characters
of cleaned text, and `processing_status='complete'`. A letter, a memo, a licence scan and a
roster all legitimately land here. A pipeline that treats "not a record" as a failure will be
switched off by its operators within a week.

**Two-sided cost.** Set the threshold too high and real records silently become notes rows; set it
too low and the model bill scales with the mailroom. Log the marker count on every document so the
distribution is inspectable after the fact.

### 3.2 Extraction and cleaning limits (stages 4-5)

- Text extraction is **native and in-process**. Do not make an HTTP call from the automation
  runner back to the application to extract text: it is a self-call, it is authenticated
  differently in every environment, and it is the canonical "worked in development, rejected in
  production" failure.
- Cleaning, in order: strip a leading BOM; remove C0/C1 control characters except `\n` and `\t`;
  replace `"` with `'` and drop backslashes (they are the two characters that break a hand-built
  JSON body downstream); collapse runs of whitespace; normalise newlines.
- **Hard truncate** to `INGEST_MAX_CHARS` (default 60000). Truncation is recorded on the row
  (`text_truncated_at`), never silent.
- **Minimum length gate**: fewer than `INGEST_MIN_CHARS` (default 100) characters of extracted
  text is a scanned image, not a document. Fail loud and route it to OCR or to a human. Do not
  send 40 characters to a model and store what comes back.
- Extraction failure is a failure. It is not an empty string.

### 3.3 Model call (stage 7b)

One call, fast tier. See §5 and `scaffold/automation/prompts/01_extraction.md`.

### 3.4 Normalisation against the framework (stage 9)

The model returns whatever competencies it saw named on the page. The pipeline never trusts that
list. It loads the active framework from the database:

```sql
select c.id, c.code, c.name, c.position
from competencies c
join competency_frameworks f on f.id = c.framework_id
where f.is_active and c.deleted_at is null
order by c.position;
```

and then emits **one row per competency in the framework, in `position` order, always**, with a
NULL grade where the model reported nothing. Matching from the model's string to a `competency_id`
is done once, here, by case-folded exact match then by code then by a configured alias table
(`scaffold/config/ingest.yaml: competency_aliases`). Everything downstream keys on
`competency_id`. **No name reaches storage as a key.**

A missing competency is not an omission to tolerate quietly — it breaks position-indexed charts
and it silently shrinks a denominator. Emitting the full set is what makes the shape stable.

### 3.5 Date repair (stage 10)

Source documents are overwhelmingly day-first. Applied in order to whatever ISO date the model
returned:

| Rule | Condition | Action |
|---|---|---|
| 1 | `month > 12` | swap day and month, set `date_correction_note` |
| 2 | `day > 12` and `month <= 12` | leave it — day-first was already honoured |
| 3 | not a valid calendar date | set NULL, note it |
| 4 | more than 90 days in the future, or before 2000-01-01 | keep, flag `date_suspect=true` |

Rule 4 does not auto-correct. A wrong year is not recoverable by swapping, and a pipeline that
guesses at it will quietly move a record into the wrong reporting period.

### 3.6 Idempotency and dedup (stages 3 and 12)

| Key | Scope | Purpose |
|---|---|---|
| `sha256(file_bytes)` + `subject_id` | stage 3 | the same file re-uploaded is a no-op returning the existing record id |
| `(subject_id, session_date, document_name)` unique index | stage 12 | the same session ingested from a differently-named copy collapses to one row |
| `ingest_runs.request_key` | whole run | caller-supplied; a retried request resumes rather than duplicating |
| migration files | schema | forward-only, idempotent, so re-application is safe |

Stage 12 is an upsert with an explicit conflict target. **Name the conflict target.** Relying on
the database to infer which unique index you meant works until a second index exists.

Every run row carries a `request_key`. Without it, a client retry after a timeout produces a second
run and a second set of children, and there is no way afterwards to tell the duplicate from the
original.

### 3.7 Insert guards (stage 11-12)

Before insert, in this order, each failing loud:

1. **Required keys present.** If the shape lacks `is_record`, `session_date`, `competencies` or
   `tasks`, stop. Do not default them. See §8.
2. **Enum clamp.** `overall_result`, `session_type`, `asset_class` clamped to the configured
   allowlist; a value outside it is a rejection, not a silent substitution — except where the
   config explicitly names a default, in which case the substitution is recorded on the row.
3. **Range clamp.** A grade outside 1-5 becomes NULL and is counted in `validation_warnings`.
   `NR` / `NO` / `NA` and blank become NULL. Grade columns are `TEXT` (`docs/03`).
4. **Referential check.** `subject_id`, `framework_id`, every `competency_id` and every
   `observable_behaviour_id` must resolve. An unresolved reference is a rejection.
5. **Transaction.** Parent row and all children insert in one transaction. Children before parent
   on delete, parent before children on insert. A half-written record is worse than none.

---

## 4. Analyse pipeline, stage by stage

```
1 create run          analysis_runs row, status='queued', request_key
2 gather              SQL only: records for the subject, in date order, plus every figure the
                      report will display -- averages, trends, counts, below-standard tallies
3 build figure set    the flat, typed set of every number that may legally appear (see 9)
4 render deterministic parts   timeline table, all charts, all tables -- built in code, never by the model
5 deep-tier call      structured findings, JSON mode, schema-validated
6 repair-retry        one retry, then fail the run loud
7 deep-tier call 2    prose/HTML assembly, consuming (5), with placeholders for (4)
8 substitute          inject the deterministic blocks at their placeholders
9 provenance gate     every number in the generated prose matched against the figure set
10 persist            status='complete' only after 8 and 9 both pass
```

Stage 4 before stage 5 is deliberate: the deterministic artefacts exist before the model is asked
for anything, so the model can be told *"emit `<!--TIMELINE-->` and nothing else there"* rather
than being trusted to reproduce a table.

**Status is set once, at the end.** Do not mark a run `complete` before the rendering, PDF or
provenance stages finish; a UI that then re-fetches gets a half-built run, and the workaround is
always a sleep. If a later stage is genuinely optional, give it its own status column
(`pdf_status`), never an early `complete`.

**Cap the corpus.** `ANALYSIS_MAX_CHARS` (default 45000) over the concatenated record text, with
oldest-first truncation and the truncation recorded on the run. When the corpus exceeds the cap,
switch to map-reduce (§6) rather than dropping documents.

---

## 5. Two-tier model split

One seam, two model names. Both resolve through `scaffold/lib/inference.ts`.

| Tier | Env var | Used for | Typical budget | Timeout |
|---|---|---|---|---|
| fast | `LLM_MODEL_FAST` | classify, extract fields from one document, per-document summarisation in map-reduce | 2000-3000 output tokens | 60 s |
| deep | `LLM_MODEL_DEEP` | multi-record structured findings, prose and report assembly | 8000-20000 output tokens | 300 s |

Rules:

- **Model names are environment variables, never literals.** A model id appearing in a prompt
  file, a node parameter or a source file is a defect. The cost of getting this wrong is that a
  provider swap becomes a search-and-replace across every call site, and someone misses one.
- The provider is described only as *an OpenAI-compatible chat completions endpoint at
  `LLM_BASE_URL`*. Nothing above the seam knows the vendor, the auth scheme, the version header or
  the response shape. A local runtime, a hosted API and a corporate gateway are all the same three
  variables.
- Both tiers may point at the same model. That is a valid, cheap configuration and must not break.
- Raise the client timeout well beyond what a hosted API needs. A local runtime at ~30 tokens/s
  takes minutes for a long completion, and a 60-second default turns that into a spurious failure.

### 5.1 When to prefer map-reduce over one long call

A single call over a long concatenated corpus suffers **positional attention decay**: the model
cites the last two documents and treats the first seven as background, even when the whole payload
fits in the context window with room to spare. Measured on one comparison, citation *density* rose
while *distinct sources cited* fell from 6 of 9 to 2 of 9 — an evaluation counting citations rather
than distinct sources would have scored that regression as an improvement.

Map-reduce fixes it structurally: one bounded fast-tier call per record producing a small typed
summary, then one deep-tier synthesis over the summaries. It trades one 16k call for ten small
ones and makes per-document coverage a property of the architecture instead of a hope. Use it
whenever the corpus exceeds ~8 records or the deployment targets a local runtime.

---

## 6. Prompt architecture

### 6.1 Shape

- **System/user split is mandatory.** The system message carries the role, the output contract and
  the invariable rules. The user message carries only the data for this call. A single giant user
  turn makes the contract indistinguishable from the payload, and a document containing the words
  "ignore the above" is then a live injection vector.
- **Schema enforcement, not prose enforcement.** Request JSON mode with a declared schema. Prose
  such as "return only the JSON object, no markdown" is a fallback for endpoints without JSON
  mode, not the primary mechanism.
- **`temperature: 0`** for extraction, classification and structured findings. Narrative assembly
  may run at up to 0.3; nothing in this platform runs higher.
- **Token budgets are explicit per call** and live in `scaffold/config/inference.yaml`.
- **Timeouts are explicit per tier.** No unbounded call.
- **One repair retry** on schema failure, then fail (§8).

### 6.2 Every list comes from the database

Prompt templates in `scaffold/automation/prompts/` contain **placeholders, never vocabulary**:

```
{{COMPETENCY_LIST}}      one line per competency: code | name | description
{{OB_LIST}}              one line per observable behaviour: code | competency code | text
{{GRADE_SCALE}}          the 1-5 descriptors from config/policy.yaml
{{FIGURE_SET}}           the computed figures this narrative may refer to
```

The loader (`scaffold/automation/prompts/loader.md`) reads them from `competencies`,
`observable_behaviours` and the config files at call time and substitutes. Consequences:

- Renaming a competency is an `UPDATE`. No prompt edit, no deploy, no migration.
- Adding a tenth competency changes every prompt at once, correctly.
- The prompt and the insert guard read the *same* source, so they cannot drift apart. In systems
  where the vocabulary is pasted into prompts, restoring an older automation export silently
  reintroduces the previous spellings and analytics de-align with no error anywhere.

A prompt file containing a competency name, an OB string or a grade descriptor as literal text is
a defect, and CI greps for it.

### 6.3 Contract discipline inside the prompt

- Field descriptions carry the disambiguation rules inline. The schema *is* the instruction set;
  a separate "rules" section that repeats them drifts from the schema.
- Every enumerated field lists its permitted values verbatim.
- Negative constraints are explicit and worked: give the counter-example, not just the rule.
- Hard caps on generated list lengths ("at most 3 bullets") are stated as numerals.
- Asymmetric evidence rules are load-bearing and must survive editing: **strengths may be claimed
  only from numeric grades**; development areas may be *supported* by an assessor remark but must
  still originate in a grade. This is the main anti-flattery and anti-narrative-drift control.

---

## 7. Expected output shapes

Exact shapes live in `scaffold/automation/prompts/*.md` next to each prompt; the summary contract:

**Extraction (fast tier).**

```json
{
  "is_record": true,
  "document_name": "string, verbatim from the document",
  "session_date": "YYYY-MM-DD or null",
  "session_type": "string or null",
  "assessor_name": "string or null",
  "subject_external_id": "string or null",
  "asset_class": "string or null",
  "overall_result": "PASS | FAIL | PARTIAL | INCOMPLETE | null",
  "tasks": [{ "task_name": "string", "grade": "string or null", "remark": "string or null" }],
  "competencies": [{ "competency_code": "string as printed", "grade": "1-5 | NR | NO | NA | null",
                     "remark": "string or null" }],
  "assessor_remarks": [{ "text": "verbatim", "sentiment": "positive|negative|neutral" }],
  "notes": "string or null",
  "confidence": { "overall": 0.0, "fields_uncertain": ["field names"] }
}
```

**Structured findings (deep tier).**

```json
{
  "concern_level": "low | medium | high",
  "concern_rationale": "prose citing document names and dates",
  "competency_findings": [{ "competency_code": "string",
                            "trend": "improving|stable|declining|insufficient_data",
                            "evidence_summary": "prose" }],
  "key_strengths": [{ "competency_code": "string", "finding": "prose", "evidence": "prose" }],
  "key_development_areas": [{ "competency_code": "string", "finding": "prose",
                              "evidence": "prose", "assessor_support": "quote or null" }],
  "root_causes": [{ "code": "string from the configured list", "evidence_tier":
                    "evidence_supported|probable_inference|insufficient_evidence",
                    "description": "prose", "affected_competency_codes": ["string"] }],
  "escalation_trigger": "one observable behaviour that would raise the level"
}
```

Note what is **absent**: no `latest_score`, no `average_score`, no counts. Those are computed and
passed *in*; asking the model to restate them creates a second source of truth and a provenance
failure waiting to happen. Trends are a judgement over supplied figures and are cross-checked
against the SQL trend before storage.

**Report assembly (deep tier).** HTML fragments keyed by section, plus the placeholder tokens
`<!--TIMELINE-->` and `<!--CHART:{competency_code}-->` at the positions where deterministic blocks
are injected. The model never emits a table of figures and never emits SVG.

---

## 8. Error handling: never swallow a parse failure

This is the single most expensive lesson in the source material and it is stated as a prohibition.

**A parse or schema failure must never be converted into a plausible-looking object.**

The failure mode, concretely: an extraction parser caught its JSON error and returned
`{ is_record: false, notes: raw.slice(0, 500) }`. A malformed model response therefore became a
well-formed "this is not a training record" row. Nothing errored, nothing alerted, and the
document was gone from every report that filtered on records.

The compounding version: a prompt was accidentally truncated by a source-level typo, dropping five
required keys **and** the output contract. The parser absorbed all five with `|| []` and `|| ''`
defaults. Every report generated afterwards silently lacked its entire structured-findings layer.
There was no error anywhere, for weeks.

Rules:

1. `JSON.parse` failure after the one repair retry (§6.1) sets the run to `status='failed'` with
   the raw response stored for inspection. It does not produce a row.
2. **Missing required keys are a failure, not a default.** `|| []` and `|| ''` on a required field
   are banned; CI greps for the pattern next to schema field names.
3. Fabricating a fallback record is banned in all forms.
4. Salvage is permitted only for *transport* damage — a leading BOM, a code fence, prose either
   side of a brace-balanced object. Salvage is logged. Salvage is not repair of content.
5. Every stage that writes must report what it wrote. A write-back helper that returns success
   regardless of the response is how a file ends up in the staging folder with a database row
   pointing at a name that does not exist. Return `{ ok, error }` and check it.
6. Continue-on-error is set per node deliberately or not at all. A pipeline where no step can fail
   is a pipeline where no step reports failure.

---

## 9. The provenance gate

Implemented in `scaffold/lib/provenance.ts`; enforced at stage 9 of the analyse pipeline and at
any other point where generated prose is persisted.

```
figureSet  = every number the deterministic core computed for this run,
             flattened from the whole nested structure, with tolerance and formatting variants
narrative  = the generated prose
numbers    = every numeric literal extracted from narrative, excluding an ignore list
             (dates already matched, section numbers, ordinals in list markers)

provenance = matched(numbers) / total(numbers)        -- how much of what it said is real
coverage   = citedSources / availableSources          -- how much of the evidence it used

store only if provenance >= MIN_PROVENANCE and coverage >= MIN_COVERAGE
```

Both thresholds live in `scaffold/config/analytics.yaml`. Defaults: provenance 1.0 (no unsourced
figure at all), coverage 0.6.

### 9.1 The flattening failure

**A provenance gate that inspects only the top-level keys of the figure set will reject correct
figures.**

The computed figures are nested — per-competency arrays, per-session objects, arrays of objects
inside those. A gate that iterates `Object.values(figures)` and collects only the scalars finds the
run totals and misses every per-competency average. The model correctly cites "an average of 2.4 in
Communication", the gate does not find 2.4 in its flat list, and a correct, fully-sourced report is
rejected. Operators then lower the threshold, which disables the gate for the incorrect cases too.

So: **flatten recursively.** Walk arrays and objects to any depth, collect every number, and
include formatting variants of each — the same value as an integer, at one decimal place, at two
decimal places, and as a percentage where the figure is a ratio. Match with a small epsilon rather
than by string equality. `scaffold/lib/provenance.ts` does exactly this and its test fixture is a
deliberately deep structure.

The symmetric failure is worth naming too: a gate that is too permissive (matching any substring of
any number) passes a hallucinated "17 sessions" because 17 appears inside a date. Extract numbers
with word boundaries and exclude already-matched date spans before matching.

### 9.2 What a failed gate does

It does **not** silently drop the narrative and publish the figures. It fails the run with
`status='failed'`, `failure_reason='provenance'`, and stores the offending numbers so the prompt
or the figure set can be fixed. A near-miss policy (`provenance >= 0.95`) that publishes with a
warning banner is configurable but off by default.

---

## 10. Anti-misread rules

These generalise beyond any one document format and belong in the extraction prompt, in the
validator, and in the reviewer's checklist.

1. **Read a value from its own field.** An overall result comes from the dedicated result field
   and nowhere else. If the document has no such field, the result is the configured default and
   the row is flagged `result_inferred=true` — it is not guessed.
2. **Never infer a result from narrative.** The word "fail" in an assessor remark, in a
   "reason for remedial training" field, in an objectives list, or in a debrief conclusion is not
   a result. Only a dedicated result field saying so is a result.
3. **Never infer a competency grade from task grades.** Tasks and competencies are different
   axes. A competency grade comes from the competency summary section only. Where every task grade
   under a competency is non-scoring, the competency grade is NULL — not a low grade, not an
   average, not an impression.
4. **A number inside a task name is not a grade.** "Approach 3 - RNP AR" contains a 3 that is part
   of the exercise identifier. The grade is the standalone value in the row's grade cell. Read
   position, not proximity.
5. **Non-scoring codes are neutral.** `NR`, `NO`, `NA` and blank resolve to NULL and leave both
   numerator and denominator of every metric. They are never a failure, never a low grade, and
   never mentioned in generated narrative — a report that says a competency "was not
   observed" has turned an absence of data into a finding.
6. **Remarks are evidence, not data.** Free text is never parsed into observable behaviour
   selections, never parsed into grades, and never used as the sole basis for a strength.
7. **Verbatim means verbatim.** Document names, assessor remarks and quoted evidence are copied,
   not paraphrased, not reordered, not tidied. Paraphrase is how a quotation becomes a fabrication.
8. **Dates are day-first until proven otherwise** (§3.5), and an out-of-range date is flagged, not
   corrected.

---

## 11. Degraded mode

**No inference configured is a first-class supported state**, exercised by the test suite and by
one CI job with `LLM_BASE_URL` unset.

| Configured | Behaviour |
|---|---|
| `LLM_BASE_URL` unset or empty | `inference.ts` returns `{ ok: false, degraded: true, reason: 'not_configured' }` without attempting a request. Callers must handle it — the type makes ignoring it a compile error. |
| endpoint unreachable, times out, or returns non-2xx after the retry | same shape, `reason: 'unavailable'`, logged with the status |
| schema failure after the repair retry | **not** degraded — this is a failure (§8) |

Behaviour of each surface in degraded mode:

- **Ingest**: the pre-classifier still runs; a candidate document is stored with
  `processing_status='awaiting_extraction'` and the raw text, and is picked up when inference is
  configured. Nothing is lost and nothing is fabricated.
- **Analyse**: the run completes with `status='complete_no_narrative'`. Every figure, table,
  timeline and chart renders. The narrative sections are replaced by a neutral notice.
- **Reports and PDFs**: generate normally, without prose sections.
- **UI**: features that require inference are visibly disabled with a reason, not silently absent.

The rule behind it: an operator must be able to run this platform for a year with no model
configured at all, and every compliance-relevant output must still be correct. Anything the model
is load-bearing for is a design error.

---

## 12. Traps

- **Swallowing a parse failure into a fallback object.** The document silently becomes a non-record
  or the report silently loses a layer. Fail loud, store the raw response, leave the row absent.
  See §8.
- **`|| []` on a required key.** Absorbs a truncated prompt, a renamed field, a provider change and
  a schema drift — all as "empty results". Validate required keys explicitly.
- **Pasting the competency vocabulary into prompts.** Three copies (database, application, prompt)
  drift. Restoring an older automation export reintroduces old spellings with no error. Load every
  list from the database at call time.
- **Keying anything on a competency name.** See `docs/03` §8. Names are display strings.
- **Letting the model produce a figure.** Every number must be computed. A model that restates a
  supplied average will eventually restate it wrong, and the provenance gate is the last line of
  defence, not the first.
- **A provenance gate that only walks top-level keys.** Rejects correct nested figures, operators
  lower the threshold, the gate stops protecting anything. Flatten recursively (§9.1).
- **One long call over a large corpus.** Positional decay collapses distinct-source coverage while
  citation density rises, so a naive evaluation scores the regression as an improvement. Measure
  distinct sources; use map-reduce (§5.1).
- **Marking a run complete before the last stage.** The UI reads a half-built run and someone adds
  a sleep. Set the terminal status once, at the end.
- **Model ids or endpoint URLs as literals.** A provider swap becomes a search-and-replace and
  someone misses a call site. Everything through `LLM_BASE_URL` / `LLM_MODEL_FAST` /
  `LLM_MODEL_DEEP`.
- **Treating "not a record" as an error.** Legitimate non-record traffic is most of an inbox.
  Store it as notes, complete the run.
- **Upserting without naming the conflict target.** Works until a second unique index exists, then
  silently updates the wrong row.
- **Calling the application's own HTTP API from inside the application.** Different auth in every
  environment; passes in development, rejected in production. Call the function directly.
- **A model call inside the interactive request path.** Blows the interactive latency budget and
  makes every timeout a user-visible error. Queue it.
