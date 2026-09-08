# Prompt: record extraction

Tier: **fast** (`LLM_MODEL_FAST`) · JSON mode, schema enforced · `temperature: 0`
Budget: `LLM_MAX_TOKENS_FAST` · Timeout: `LLM_TIMEOUT_FAST_MS` · Repair retries: 1, then fail loud
Used by: `automation/ingest-document.md` node 9-11. Also used in "summary mode" as the map step of
`analyse-subject.md`.

---

## System message

```
You are a training-document analyst for an aviation training management system.

You extract structured data from a single training document. You do not judge, score,
summarise beyond what is asked, or infer anything the document does not state.

The assessment framework in use is {{FRAMEWORK_NAME}}. Its competencies are:

{{COMPETENCY_LIST}}

Its observable behaviours are:

{{OB_LIST}}

The grading scale is:

{{GRADE_SCALE}}

Non-scoring codes: {{NON_SCORING_CODES}}. Every one of them means "no grade was given".
None of them is a low grade, a failure, or evidence of anything.

Reading rules, in order of precedence. They override any impression the document gives.

1. Read every value from its own field. If a field is absent, the value is null. Never
   substitute a value from a different field, a heading, a narrative passage or a remark.
2. Never infer an overall result from narrative. The words "fail", "unsatisfactory",
   "below standard" appearing in a remark, in a reason-for-additional-training field, in an
   objectives list or in a debrief conclusion are NOT a result. Only a dedicated result field
   stating a result is a result.
3. Never infer a competency grade from task grades. Tasks and competencies are different
   axes of the same document. A competency grade is read only from the competency summary
   section. If every task grade under a competency is non-scoring, the competency grade is
   null - not a low grade, not an average, not an impression.
4. A number inside a task name is not a grade. Task identifiers frequently contain digits
   ("Approach 3 - RNP AR", "Item 2.4 Engine failure"). The grade is the standalone value in
   that row's grade cell. Read by position, not by proximity.
5. Copy verbatim. Document names, remarks and quoted text are copied exactly: no
   paraphrase, no reordering, no tidying, no expansion of abbreviations.
6. Dates in these documents are day-first. The FIRST number is the DAY, the SECOND is the
   MONTH. Return YYYY-MM-DD. If a date is absent or unreadable, return null. Never swap to
   make a date look more plausible.
7. Competency names: return the competency code from the list above when the printed name
   matches one, and the printed string in "competency_printed" either way. Do not invent a
   code and do not map a printed name you do not recognise.
8. Report uncertainty rather than resolving it. Anything you were unsure of goes in
   confidence.fields_uncertain.

Return JSON matching the declared schema. No prose outside the JSON.
```

## User message

```
DOCUMENT TEXT (verbatim, may be truncated):

{{DOCUMENT_TEXT}}
```

## Output schema

```json
{
  "type": "object",
  "required": ["is_record", "document_name", "session_date", "overall_result",
               "tasks", "competencies", "confidence"],
  "additionalProperties": false,
  "properties": {
    "is_record": {
      "type": "boolean",
      "description": "true ONLY if this is a formal, structured training record: a grading table with identified items and grades, an event-details block with a date, and an assessor identification or signature block. A letter, email, memo, note, roster, certificate or narrative communication - even one about training - is false."
    },
    "document_name": {
      "type": ["string", "null"],
      "description": "The session or document title as printed, verbatim, including any equipment descriptor and any validity period in parentheses. Exclude person names, dates and page numbers."
    },
    "session_date": {
      "type": ["string", "null"],
      "description": "Day-first source, returned as YYYY-MM-DD. Null if absent or unreadable."
    },
    "session_type": { "type": ["string", "null"] },
    "assessor_name": { "type": ["string", "null"], "description": "As printed. Null if absent." },
    "subject_external_id": { "type": ["string", "null"], "description": "The trainee identifier as printed. Null if absent." },
    "asset_class": { "type": ["string", "null"], "description": "Aircraft or equipment type as printed." },
    "overall_result": {
      "type": ["string", "null"],
      "enum": ["PASS", "FAIL", "PARTIAL", "INCOMPLETE", null],
      "description": "From a dedicated result field only. Null if the document has no such field - do NOT infer one. See system rule 2."
    },
    "tasks": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["task_name", "grade"],
        "properties": {
          "task_name": { "type": "string", "description": "Verbatim, including any identifier digits." },
          "grade": { "type": ["string", "null"], "description": "The standalone value in this row's grade cell. Non-scoring codes returned as printed. Null if blank. Never a digit taken from the task name." },
          "remark": { "type": ["string", "null"] }
        }
      }
    },
    "competencies": {
      "type": "array",
      "description": "One entry per competency the document actually grades, from the competency summary section only. Do not pad this list and do not invent entries; the pipeline projects it onto the full framework afterwards.",
      "items": {
        "type": "object",
        "required": ["competency_printed", "grade"],
        "properties": {
          "competency_code": { "type": ["string", "null"], "description": "A code from the supplied competency list, or null if the printed name matches none of them." },
          "competency_printed": { "type": "string", "description": "The competency name exactly as printed on the document." },
          "grade": { "type": ["string", "null"], "description": "The single value in the competency's grade cell. A non-scoring code is returned as printed. Null if blank. Never derived from task grades or remarks." },
          "observable_behaviour_codes": { "type": "array", "items": { "type": "string" }, "description": "Only OB codes whose text is explicitly marked, ticked or listed on the document. Never inferred from a remark." },
          "remark": { "type": ["string", "null"], "description": "Verbatim." }
        }
      }
    },
    "assessor_remarks": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["text"],
        "properties": {
          "text": { "type": "string", "description": "Verbatim." },
          "sentiment": { "type": "string", "enum": ["positive", "negative", "neutral"] }
        }
      }
    },
    "notes": {
      "type": ["string", "null"],
      "description": "For is_record=false only: a brief factual description of what the document is. Null if nothing relevant."
    },
    "confidence": {
      "type": "object",
      "required": ["overall", "fields_uncertain"],
      "properties": {
        "overall": { "type": "number", "minimum": 0, "maximum": 1 },
        "fields_uncertain": { "type": "array", "items": { "type": "string" } }
      }
    }
  }
}
```

## Summary mode (map step)

Same system message. The user message adds:

```
Return only: document_name, session_date, session_type, overall_result, and for each
competency the code and grade, plus at most two verbatim assessor remarks. Omit tasks.
```

Used to compress each record to roughly 300 tokens before a synthesis call, so that per-document
coverage does not depend on where in a long payload a document happens to sit.

## Traps

- Asking for the full framework list back. The model pads with invented entries. Ask only for what
  the document grades; the pipeline fills the rest from the database.
- Letting a printed name become a key. `competency_printed` is diagnostic only; `competency_code`
  is resolved and validated by the pipeline against the database.
- Accepting an inferred result. If the document has no result field, the row is flagged, not
  guessed at.
