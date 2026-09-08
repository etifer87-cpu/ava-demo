# Prompt: narrative analysis (structured findings)

Tier: **deep** (`LLM_MODEL_DEEP`) · JSON mode, schema enforced · `temperature: 0`
Budget: `LLM_MAX_TOKENS_DEEP` · Timeout: `LLM_TIMEOUT_DEEP_MS` · Repair retries: 1, then fail loud
Used by: `automation/analyse-subject.md` nodes 8-11.

This is the call that produces judgement. It produces **no figures**. Every number it may refer to
arrives in `{{FIGURE_SET}}`, already computed in SQL, and the provenance gate rejects any number
in the output that is not in that set.

---

## System message

```
You are a training analyst writing findings about one trainee's record history for a
training review board.

The framework in use is {{FRAMEWORK_NAME}}. Its competencies:

{{COMPETENCY_LIST}}

Its observable behaviours:

{{OB_LIST}}

The grading scale:

{{GRADE_SCALE}}

Non-scoring codes: {{NON_SCORING_CODES}}.

WHAT YOU MUST NOT DO

1. Do not calculate. Every figure you may cite is given to you in COMPUTED FIGURES. Do not
   count sessions, average grades, work out a percentage, or state a total. If a figure you
   want is not in COMPUTED FIGURES, do not state it - describe the pattern in words instead.
2. Do not restate a figure in a different form. Do not convert a count to a percentage, a
   grade to a fraction, or a date range to a duration. Use the figures exactly as given.
3. Do not mention non-scoring codes or their meaning. A competency with no grade in a
   session is simply not discussed for that session. Never write that something "was not
   observed", "was not required" or "requires further assessment" when the only reason is
   an absent grade. Omit it.
4. Do not invent, infer beyond the evidence, or soften. Do not add encouragement,
   recommendations for courses, or predictions of future performance.
5. Do not use accident, incident, violation or enforcement language unless those exact
   words appear in the source records.
6. Do not identify or characterise assessors. This is an analysis of training evidence,
   not of instructors.

EVIDENCE RULES

7. Every finding cites its source: the document name and its date, exactly as given.
8. Strengths may be claimed ONLY from graded evidence - a grade at the top of the scale, a
   task grade, or a recorded observable behaviour. An assessor remark is never sufficient
   evidence for a strength. This asymmetry is deliberate; do not balance it.
9. Development areas must also originate in graded evidence. An assessor remark may be
   quoted as corroboration in assessor_support, verbatim, or that field is null.
10. Quote verbatim or do not quote. No paraphrase inside quotation marks.
11. Reference competencies by code from the supplied list. Never by a name of your own.
12. A trend is a judgement about grades that were given. Where the figures show fewer than
    two graded sessions for a competency, the trend is "insufficient_data".
13. Where evidence is thin, say so. "insufficient_evidence" is a correct answer and is
    always preferable to a confident claim.

Return JSON matching the declared schema. No prose outside the JSON.
```

## User message

```
SUBJECT: {{SUBJECT_LABEL}}
REPORT DATE: {{REPORT_DATE}}

COMPUTED FIGURES (the only numbers you may state, verbatim):
{{FIGURE_SET}}

TRAINING RECORDS, chronological:
{{RECORDS}}

PERMITTED ROOT CAUSE CODES:
{{ROOT_CAUSE_CODES}}
```

## Output schema

```json
{
  "type": "object",
  "required": ["concern_level", "concern_rationale", "competency_findings",
               "key_strengths", "key_development_areas", "root_causes", "escalation_trigger"],
  "additionalProperties": false,
  "properties": {
    "concern_level": {
      "type": "string",
      "enum": ["low", "medium", "high"],
      "description": "low: performance generally at or above the target grade, no recurring pattern below standard. medium: one or more competencies below standard, or a recurring pattern that warrants monitoring or a defined action. high: multiple competencies below standard, a safety-relevant deficiency stated in the records, or a pattern showing no improvement across successive sessions."
    },
    "concern_rationale": {
      "type": "string",
      "description": "Three to five sentences. Cites document names and dates. States figures only as given in COMPUTED FIGURES."
    },
    "competency_findings": {
      "type": "array",
      "description": "One entry per competency that has at least one grade in the record history. Competencies with no grades are omitted entirely.",
      "items": {
        "type": "object",
        "required": ["competency_code", "trend", "evidence_summary"],
        "additionalProperties": false,
        "properties": {
          "competency_code": { "type": "string" },
          "trend": { "type": "string", "enum": ["improving", "stable", "declining", "insufficient_data"] },
          "evidence_summary": { "type": "string", "description": "Two or three sentences citing document names and dates." }
        }
      }
    },
    "key_strengths": {
      "type": "array",
      "maxItems": 4,
      "items": {
        "type": "object",
        "required": ["competency_code", "finding", "evidence"],
        "additionalProperties": false,
        "properties": {
          "competency_code": { "type": "string" },
          "finding": { "type": "string", "description": "One sentence." },
          "evidence": { "type": "string", "description": "Graded evidence only: grades, task grades, recorded observable behaviours. Cites document name and date. Never an assessor remark." }
        }
      }
    },
    "key_development_areas": {
      "type": "array",
      "maxItems": 4,
      "items": {
        "type": "object",
        "required": ["competency_code", "finding", "evidence", "assessor_support"],
        "additionalProperties": false,
        "properties": {
          "competency_code": { "type": "string" },
          "finding": { "type": "string" },
          "evidence": { "type": "string", "description": "Graded evidence only. Cites document name and date." },
          "assessor_support": { "type": ["string", "null"], "description": "A verbatim corroborating remark, or null. Never a paraphrase." }
        }
      }
    },
    "root_causes": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["code", "evidence_tier", "description", "affected_competency_codes"],
        "additionalProperties": false,
        "properties": {
          "code": { "type": "string", "description": "One of the supplied root cause codes." },
          "evidence_tier": { "type": "string", "enum": ["evidence_supported", "probable_inference", "insufficient_evidence"] },
          "description": { "type": "string", "description": "Two to four sentences. No psychological or medical explanation without an explicit statement in the records." },
          "affected_competency_codes": { "type": "array", "items": { "type": "string" } }
        }
      }
    },
    "escalation_trigger": {
      "type": "string",
      "description": "One specific, observable event or grade outcome that would raise the concern level. Not a recommendation and not a prediction."
    }
  }
}
```

## Pipeline guards after the call

1. Every `competency_code` and every `code` resolves against the database. Unknown is a rejection.
2. **Trend cross-check**: each asserted trend is compared with the trend computed in SQL. A
   mismatch fails the run. The model is judging over supplied figures; a judgement that
   contradicts them is not a wording problem.
3. `key_strengths[].evidence` must not be the sole content of any assessor remark in the corpus -
   a strength sourced from narrative is rejected.
4. Every entry in `key_development_areas` with a non-null `assessor_support` must match a remark
   in the corpus byte for byte after whitespace normalisation.
5. **Provenance gate** over all prose fields (`lib/provenance.ts`, `docs/11` section 9).
6. Missing required keys fail the run. They are never defaulted to `[]` or `''`.

## Traps

- **Asking for `latest_score` or `average_score` in the schema.** Creates a second source of truth
  for a number SQL already has, and makes the provenance gate the first line of defence instead of
  the last. Pass figures in; never ask for them back.
- **Balancing the strengths/weaknesses asymmetry.** Someone will eventually "fix" rule 8 because
  it looks inconsistent. It is the main anti-flattery control; strengths sourced from remarks turn
  every report into a commendation.
- **Letting absent grades become findings.** a sentence saying a competency "was not observed" reports a gap
  in the data as a finding about a person.
- **Dropping the citation requirement to shorten output.** Then nothing in the report can be
  checked against a record.
- **Measuring citation density instead of distinct sources cited.** Density rises exactly when
  coverage collapses onto the two most recent documents.
