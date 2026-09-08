# Pipeline: analyse-subject

Turns N stored records for one subject into one `analysis_runs` row carrying structured findings
and rendered HTML. Specified by `docs/11_AI_PIPELINE.md` section 4.

Entry: `POST /webhook/analyse-subject`
Body: `{ request_key, subject_id, record_ids?, options: { include_timeline, include_charts, ... }, actor_id }`
Response: `{ ok, run_id, status }` - returned immediately. The run is not synchronous; a model call
never sits in the interactive request path.

## Node graph

```
 1  receive
 2  create-run                (status='queued', request_key)
 3  gather-records            SQL only
 4  compute-figures           SQL only -- every number the report will ever show
 5  build-figure-set          flattened, typed, with formatting variants
 6  render-deterministic      timeline table + every chart, built in code
 7  load-framework
 8  build-findings-prompt
 9  call-model (deep tier)  --- degraded --> 80 complete-no-narrative
10  validate-schema --- invalid --> 10r repair-retry --- invalid --> 90 fail-loud
11  cross-check-trends        model trend vs SQL trend; mismatch is a rejection
12  build-report-prompt
13  call-model (deep tier)  --- degraded --> 80 complete-no-narrative
14  parse-report
15  substitute-placeholders   <!--TIMELINE--> and <!--CHART:{code}--> injected here
16  provenance-gate --- fail --> 91 fail-provenance
17  persist                   status='complete' set ONCE, here
18  render-pdf                own status column, never gates 17
```

## Nodes

| # | Node | Kind | Does |
|---|---|---|---|
| 1 | `receive` | trigger | `request_key` required. A retry resumes the existing run rather than creating a second one. |
| 2 | `create-run` | query | Inserts `analysis_runs` with `status='queued'`. The run id is threaded forward from **this one place**; two nodes reading the run id from two different sources is how a result gets written to a run nobody is watching. |
| 3 | `gather-records` | query | Records for the subject in `session_date` order, optionally filtered to `record_ids`. Reads **every** `source` value - a read surface that queries only `'app'` reports zeros for ingested records. Concatenated text capped at `ANALYSIS_MAX_CHARS`, oldest-first truncation, recorded on the run. |
| 4 | `compute-figures` | query | Every figure: per-competency latest grade, average, trend, below-standard counts, session totals, date range, attempt counts. All from the analytics views. **The model computes nothing.** |
| 5 | `build-figure-set` | code | Flattens the nested structure of (4) recursively into the typed figure set that the provenance gate will use. See `lib/provenance.ts`. |
| 6 | `render-deterministic` | code | Builds the timeline table and every chart as SVG, in code, before any model call. The model is told to emit a placeholder at those positions and nothing else. |
| 7 | `load-framework` | query | Competencies and observable behaviours from the database, for the prompt placeholders. |
| 8 | `build-findings-prompt` | code | `prompts/03_narrative_analysis.md` with `{{COMPETENCY_LIST}}`, `{{OB_LIST}}`, `{{GRADE_SCALE}}`, `{{FIGURE_SET}}`, `{{RECORDS}}`. System and user separated. |
| 9 | `call-model` | seam | Deep tier, JSON mode, `temperature 0`. Degraded return routes to 80. |
| 10 | `validate-schema` | code | Structured-findings schema. One repair retry, then fail loud with the raw response stored. Missing required keys are a failure, never a default. |
| 11 | `cross-check-trends` | code | Each `trend` the model asserted is compared with the trend SQL computed. A mismatch fails the run: the model is narrating a judgement over supplied figures, and a judgement that contradicts the figures is not a wording problem. |
| 12 | `build-report-prompt` | code | `prompts/04_report_assembly.md`. Section numbering is computed in code from the option flags, not by the model. Hard caps on list lengths are numerals in the prompt. |
| 13 | `call-model` | seam | Deep tier, `LLM_MAX_TOKENS_DEEP`, `LLM_TIMEOUT_DEEP_MS`, temperature up to 0.3. |
| 14 | `parse-report` | code | Validates the section map. No fallback text; a missing required section is a failure. |
| 15 | `substitute-placeholders` | code | Injects the deterministic blocks. The injected block brings its own section wrapper, so the prompt must forbid the model wrapping the placeholder in one - otherwise the heading renders twice. |
| 16 | `provenance-gate` | code | `lib/provenance.ts`. Every number in the prose matched against the flattened figure set; `PROVENANCE_MIN_SCORE` and `PROVENANCE_MIN_COVERAGE` from config. Failure goes to 91 with the offending numbers stored. |
| 17 | `persist` | query | `status='complete'`, findings, HTML, `documents_used`. **Set once, at the end.** |
| 18 | `render-pdf` | http | Own column `pdf_status`. A PDF failure does not invalidate a completed run, and a pending PDF must not hold `status` at `queued`. |
| 80 | `complete-no-narrative` | query | Degraded mode. `status='complete_no_narrative'`. Every figure, table, timeline and chart renders; the prose sections carry a neutral notice. |
| 90/91 | `fail-loud` / `fail-provenance` | query | `status='failed'` with `failure_reason` and the raw material for diagnosis. No partial publication. |

## Map-reduce variant

When the corpus exceeds roughly 8 records, or the deployment targets a local runtime, replace
nodes 8-10 with:

```
8a  for each record: build-summary-prompt (prompts/01_extraction.md, summary mode)
8b  for each record: call-model (FAST tier, ~1800 tokens in, small typed summary out)
8c  collect summaries
8d  build-findings-prompt over the summaries instead of the raw corpus
```

Why: a single long call suffers positional attention decay. Citation density rises while distinct
sources cited collapses - measured once at 6 of 9 sources down to 2 of 9, with the payload
comfortably inside the context window. An evaluation counting citations rather than distinct
sources scores that regression as an improvement. Map-reduce makes per-document coverage a
property of the architecture instead of a hope. Track `distinct_sources_cited / sources_available`
on every run either way.

## Traps

- **Setting `status='complete'` before rendering, PDF or the provenance gate.** The UI reads a
  half-built run and someone adds a sleep to work around it.
- **Two nodes reading the run id from two different upstream sources.** The result lands on a
  different run than the one the caller is polling.
- **Letting the model restate a computed figure.** Two sources of truth, and the provenance gate
  is the last line of defence rather than the first.
- **Asking the model for the timeline or the charts.** They are deterministic artefacts. Build
  them in code and give the model a placeholder.
- **The double heading.** The model wraps the placeholder in its own section and the injected
  block brings its own. Forbid the wrapper explicitly.
- **A required key absorbed by `|| []`.** A truncated prompt once dropped five required keys and
  the whole structured-findings layer went missing from every report for weeks, with no error
  anywhere, because the parser defaulted them all.
- **Counting citations instead of distinct sources cited.** Measures the wrong thing and rewards
  the failure.
- **Analysis in the request path.** Blows the interactive latency budget and turns every model
  timeout into a user-visible error.
