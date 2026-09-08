# Pipeline: ingest-document

Turns one arriving file into one `records` row with `source='ingest'` and its children.
Specified by `docs/11_AI_PIPELINE.md` section 3. This file describes the node graph so it can be
built in any orchestrator, or as a plain server-side job. Nothing here is orchestrator-specific
except the word "node".

Entry: `POST /webhook/ingest-document`
Body: `{ request_key, subject_external_id?, file_ref, actor_id, source_label? }`
Response: `{ ok, record_id | null, status, reason? }` - returned from the last node, not fabricated.

## Node graph

```
 1  receive
 2  resolve-subject
 3  store-and-hash
 4  dedup-check ------------------------------ hit --> 90 return-existing
 5  extract-text
 6  clean-text ------------------------------ too short --> 91 fail-loud (needs OCR/human)
 7  pre-classify (deterministic, no model)
        |                                  \
        | candidate                          not a candidate
        v                                          v
 8  load-framework                          20 build-note-row
 9  build-extraction-prompt                 21 insert-note-row
10  call-model (fast tier)                  22 file-and-patch
11  validate-schema --- invalid --> 11r repair-retry --- invalid --> 92 fail-loud
12  normalise-competencies
13  repair-dates
14  guard-and-clamp --- rejection --> 92 fail-loud
15  insert-transaction
16  file-and-patch
17  respond
```

## Nodes

| # | Node | Kind | Does |
|---|---|---|---|
| 1 | `receive` | trigger | Validates the body shape. `request_key` is required; a retried request must resume, not duplicate. |
| 2 | `resolve-subject` | query | `select id from people where external_id = $1 and deleted_at is null`. Unresolved is a rejection, not a guess. A file for an unknown person is quarantined with `status='unresolved_subject'`. |
| 3 | `store-and-hash` | code | Writes the bytes under `${DATA_ROOT}` at a content-addressed path; computes `sha256`. |
| 4 | `dedup-check` | query | `select id from records where subject_id=$1 and source_sha256=$2`. Hit returns the existing id and stops. Idempotency lever 1 of 3. |
| 5 | `extract-text` | native | In-process text extraction. **Never an HTTP call back into the application** - it is a self-call, authenticated differently per environment, and the canonical "worked in dev, rejected in prod" failure. Extraction failure is a failure, not an empty string. |
| 6 | `clean-text` | code | BOM strip; drop C0/C1 controls except `\n` `\t`; `"` to `'`; drop backslashes; collapse whitespace; hard truncate to `INGEST_MAX_CHARS` recording `text_truncated_at`. Below `INGEST_MIN_CHARS` go to 91. |
| 7 | `pre-classify` | code | Counts distinct structural markers from `config/ingest.yaml`. `is_record_candidate = count >= INGEST_MIN_MARKERS`. **No model call happens before this.** Always logs the marker count so the distribution is inspectable later. |
| 8 | `load-framework` | query | Loads competencies and observable behaviours for the active framework. Feeds both the prompt placeholders and the normaliser, so they cannot drift apart. |
| 9 | `build-extraction-prompt` | code | Loads `prompts/01_extraction.md`, substitutes `{{COMPETENCY_LIST}}`, `{{OB_LIST}}`, `{{GRADE_SCALE}}`, `{{DOCUMENT_TEXT}}`. System and user messages are separate. |
| 10 | `call-model` | seam | `lib/inference.ts` fast tier, JSON mode, `temperature 0`, `LLM_MAX_TOKENS_FAST`, `LLM_TIMEOUT_FAST_MS`. A degraded return is not a failure: the row is stored `processing_status='awaiting_extraction'` with the cleaned text and picked up when inference is configured. |
| 11 | `validate-schema` | code | Validates against the extraction schema. Transport salvage only (leading BOM, code fence, prose either side of a brace-balanced object) and it is logged. |
| 11r | `repair-retry` | seam | One retry, sending the validator's error back. Then 92. |
| 12 | `normalise-competencies` | code | Projects the model's list onto the framework: one row per competency, in `position` order, always, `competency_id` resolved by exact match then code then the configured alias table. NULL where nothing was reported. **No name is stored as a key.** |
| 13 | `repair-dates` | code | The four ordered day-first rules of `docs/11` section 3.5. Rule 4 flags, never corrects. |
| 14 | `guard-and-clamp` | code | Required keys present (no defaulting); enum clamp with the substitution recorded; grade range clamp to NULL with a `validation_warnings` entry; every id resolves. Any rejection goes to 92. |
| 15 | `insert-transaction` | query | One transaction: `records` upsert on the named conflict target `(subject_id, session_date, document_name)`, then `record_tasks` and `record_competencies`. Never a partial write. |
| 16 | `file-and-patch` | http | Calls the application (which owns the filesystem) to move the file to its canonical path and patch `file_path` in the same call. Returns `{ ok, error }` and **the pipeline checks it**. A helper that reports success regardless is how a row ends up pointing at a name that does not exist. Sends `x-internal-token` from the environment, never a literal. |
| 20-22 | note path | code/query | Same insert and filing, `is_record=false`, grades NULL, `notes` = first 6000 cleaned characters, `processing_status='complete'`. Legitimate non-record traffic is most of an inbox; it is not an error. |
| 90-92 | terminals | code | `return-existing` (dedup hit), `fail-loud` (too short / schema failure / guard rejection). A failure stores the raw response and produces **no row**. |

## Rules this graph must keep

- No node has continue-on-error unless it is set deliberately with a stated reason.
- No parse or schema failure is ever converted into a plausible object. There is no
  `catch { return { is_record: false, notes: raw.slice(0,500) } }` in this pipeline, ever.
- `|| []` and `|| ''` on a required field are banned.
- Model name, endpoint and auth appear only in `lib/inference.ts`.
- Competency and observable-behaviour vocabulary appears only in the database.
- Filesystem work belongs to the application, not to pipeline code steps.

## Traps

- **Fabricating a fallback record on parse failure.** The document silently becomes a non-record
  row and disappears from every report that filters on records.
- **Skipping the pre-classifier.** The model bill scales with the mailroom, and non-record traffic
  gets an extraction schema forced onto it.
- **A marker threshold tuned by intuition.** Too high and real records become notes rows silently.
  Measure against a labelled sample; log the count on every document.
- **Upserting without naming the conflict target.** Works until a second unique index exists.
- **Hardcoding the binary field name.** A multipart field named `file` is commonly stored under a
  suffixed key; scan the keys and pick the first matching content type instead.
- **Calling the application's own extraction route from the pipeline.** Self-call, environment-
  dependent auth, passes in development.
