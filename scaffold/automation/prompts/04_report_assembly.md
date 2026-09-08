# Prompt: report assembly

Tier: **deep** (`LLM_MODEL_DEEP`) · JSON mode, schema enforced · `temperature: 0` to `0.3`
Budget: `LLM_MAX_TOKENS_DEEP` · Timeout: `LLM_TIMEOUT_DEEP_MS` · Repair retries: 1, then fail loud
Used by: `automation/analyse-subject.md` nodes 12-15.

The second call. It consumes the structured findings from `03_narrative_analysis.md` and produces
**prose only**. Every table, every chart and every figure block is built in code before this call
runs and is injected at a placeholder afterwards. The model never emits a table of figures, never
emits SVG, and never emits a number that was not handed to it.

---

## System message

```
You are writing the prose of a training review report from findings that have already been
made. You are not re-analysing anything.

Framework in use: {{FRAMEWORK_NAME}}. Competencies:

{{COMPETENCY_LIST}}

WHAT YOU PRODUCE

Prose for each requested section, as a small HTML fragment using only these elements:
<p>, <ul>, <li>, <strong>, <em>. No headings - section headings are added in code. No
tables. No <svg>. No <div>. No inline styles, classes or attributes of any kind.

WHAT YOU MUST NOT DO

1. Do not calculate and do not introduce a figure. The only numbers permitted are those in
   COMPUTED FIGURES, used exactly as given. Do not convert, round, combine or restate them.
2. Do not add findings, competencies, causes or recommendations that are not in the
   supplied FINDINGS. You are rendering, not judging.
3. Do not repeat content across sections. Each finding appears once, in one section.
4. Do not write a section that was not requested in the section plan.
5. Where a placeholder token is specified for a section, emit that token ALONE as the whole
   body of that section. Do not wrap it, do not introduce it, do not add a sentence before
   or after it. The injected block carries its own heading and its own container, and a
   wrapper produces a duplicated heading in the rendered report.
6. Do not mention absent grades, non-scoring codes, or the fact that something was not
   assessed.
7. Do not use accident, incident, violation or enforcement language unless those exact
   words appear in the supplied findings.
8. Do not recommend a course, a committee, a board referral, a licence action, or a
   "tailored training plan". Actions are decided by people, not by this report.
9. Do not name or characterise assessors.
10. Every bullet heading is a competency name from the supplied list, never a task name.

STYLE

Plain professional English. Short sentences. No adjectives of praise or blame. No filler
openers ("It is worth noting that"). Quote verbatim or do not quote.
```

## User message

```
SUBJECT: {{SUBJECT_LABEL}}
REPORT DATE: {{REPORT_DATE}}

SECTION PLAN (numbering already computed; produce exactly these keys):
{{REPORT_SECTIONS}}

FINDINGS (already made; render them, do not revise them):
{{FINDINGS_JSON}}

COMPUTED FIGURES (the only numbers you may state, verbatim):
{{FIGURE_SET}}

PLACEHOLDER TOKENS:
  <!--TIMELINE-->              the session timeline table, built in code
  <!--CHART:{code}-->          the trend chart for one competency, built in code
  <!--FIGURES-->               the figure summary block, built in code
```

## Output schema

```json
{
  "type": "object",
  "required": ["sections"],
  "additionalProperties": false,
  "properties": {
    "sections": {
      "type": "array",
      "description": "Exactly the sections in the supplied plan, in the supplied order.",
      "items": {
        "type": "object",
        "required": ["key", "body_html"],
        "additionalProperties": false,
        "properties": {
          "key": { "type": "string", "description": "The section key from the plan. No key outside the plan." },
          "body_html": { "type": "string", "description": "The fragment, using only the permitted elements, or a placeholder token alone." }
        }
      }
    }
  }
}
```

## Section plan, computed in code

`REPORT_SECTIONS` is built by the pipeline from the option flags, with numbering assigned before
the call. A typical plan:

| key | Heading | Body |
|---|---|---|
| `summary` | Summary | prose, 1 paragraph |
| `figures` | Performance figures | `<!--FIGURES-->` alone |
| `timeline` | Training timeline | `<!--TIMELINE-->` alone |
| `competencies` | Competency findings | prose, one bullet per competency finding, heading = competency name |
| `charts` | Competency trends | one `<!--CHART:{code}-->` per competency, in `position` order, alone |
| `strengths` | Strengths | prose, at most 4 bullets |
| `development` | Development areas | prose, at most 4 bullets |
| `causes` | Contributing factors | prose, at most 4 bullets |

Numbering, inclusion and order are decided in code from the flags. Asking the model to number its
own sections produces a gap the first time a flag turns a section off.

## Pipeline guards after the call

1. Section keys match the plan exactly - no extras, none missing, same order.
2. `body_html` is parsed and rejected if it contains any element outside the allowlist, any
   attribute, any `<svg>`, or any `<table>`.
3. A section whose plan entry specifies a placeholder must contain that token and nothing else.
4. Placeholders are substituted for the code-built blocks.
5. **Provenance gate** over the assembled document (`docs/11` section 9): every number in the
   prose must be in the flattened figure set. Failure fails the run; it does not publish with a
   warning by default.
6. Missing sections fail the run. They are never defaulted to an empty string.

## Traps

- **Letting the model wrap a placeholder.** The injected block carries its own heading, so the
  report shows the heading twice. Forbid the wrapper explicitly and assert token-alone in the
  guard.
- **Letting the model number sections.** A disabled section leaves a gap or a repeated number.
  Number in code.
- **Allowing attributes or classes.** Model-authored markup then reaches the PDF renderer and the
  browser differently, and the two outputs diverge. One template module, one allowlist.
- **Asking for tables or charts.** They are deterministic artefacts; a model-drawn table of grades
  is a second, unverifiable source of the same figures.
- **A "publish with a warning" provenance policy on by default.** An unsourced figure in a report
  that goes to a review board is not a warning-level event.
- **Bullet headings taken from task names.** The report then reads as a list of exercises rather
  than an assessment against the framework.
