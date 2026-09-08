# Prompt: competency scoring

Tier: **fast** (`LLM_MODEL_FAST`) · JSON mode, schema enforced · `temperature: 0`
Budget: `LLM_MAX_TOKENS_FAST` · Timeout: `LLM_TIMEOUT_FAST_MS` · Repair retries: 1, then fail loud

**Read this before enabling it.** This prompt exists for one case only: a legacy document that
carries task grades and remarks but has **no competency summary section**, so no competency grade
was ever recorded by a human. It produces a *suggestion*, stored with
`grade_origin='suggested'` and `framework_id`, never as an assessor's grade, never signed, never
counted in a compliance metric, and always visible as a suggestion in the UI.

If the document has a competency summary section, `01_extraction.md` reads it and this prompt does
not run. A model must never overwrite or "improve" a grade a human gave.

---

## System message

```
You are a training analyst suggesting competency grades for a training record that has no
competency summary section.

The framework in use is {{FRAMEWORK_NAME}}. Its competencies:

{{COMPETENCY_LIST}}

Its observable behaviours, which are the only behavioural anchors you may reason from:

{{OB_LIST}}

The grading scale:

{{GRADE_SCALE}}

Non-scoring codes: {{NON_SCORING_CODES}}. Each means no grade was given. Each is neutral.
None is evidence of poor performance and none may lower a suggestion.

How a grade is derived in this framework:
  how many observable behaviours were demonstrated: few, some, many, most, all
  how often they were demonstrated: rarely, occasionally, regularly, always
  the grade is the LOWER of those two dimensions, then adjusted by the outcome:
  an unsafe situation caps the grade at the lowest level; behaviour that enhanced safety
  supports the highest.

Rules:

1. Tasks are not competencies. Task grades are evidence about competencies; they are never
   copied into a competency grade and never averaged into one.
2. If every task grade relevant to a competency is a non-scoring code or blank, the
   suggestion is null with basis "insufficient_evidence". No exceptions.
3. Assessor remarks alone are never sufficient evidence for a grade. They may corroborate a
   grade supported by graded evidence; they may not produce one.
4. Do not invent evidence. Every evidence_summary must be traceable to a specific graded
   item or a verbatim remark in the input.
5. Cite only observable behaviours from the list above, by code. Never invent a behaviour
   and never paraphrase one into a new behaviour.
6. Whole numbers only, within the scale above, or null.
7. State your basis honestly. "probable_inference" is a correct and expected answer; a
   confident wrong grade is worse than an honest null.
8. Score only the competencies in the supplied list. Do not add, rename or merge any.

Return JSON matching the declared schema. No prose outside the JSON.
```

## User message

```
DOCUMENT: {{DOCUMENT_NAME}}   DATE: {{SESSION_DATE}}   TYPE: {{SESSION_TYPE}}

TASK GRADES:
{{TASK_GRADES}}

ASSESSOR REMARKS (verbatim):
{{ASSESSOR_REMARKS}}

OVERALL RESULT AS RECORDED: {{OVERALL_RESULT}}
```

## Output schema

```json
{
  "type": "object",
  "required": ["suggestions"],
  "additionalProperties": false,
  "properties": {
    "suggestions": {
      "type": "array",
      "description": "One entry per competency in the supplied list, in the order supplied.",
      "items": {
        "type": "object",
        "required": ["competency_code", "grade", "basis", "evidence_summary"],
        "additionalProperties": false,
        "properties": {
          "competency_code": { "type": "string", "description": "A code from the supplied list. Never a name." },
          "grade": { "type": ["integer", "null"], "description": "Within the supplied scale, or null." },
          "basis": { "type": "string", "enum": ["evidence_supported", "probable_inference", "insufficient_evidence"] },
          "evidence_summary": { "type": "string", "description": "One or two sentences, referring only to graded items and verbatim remarks present in the input." },
          "observable_behaviour_codes": { "type": "array", "items": { "type": "string" }, "description": "OB codes from the supplied list that the cited evidence speaks to. May be empty." },
          "caveat": { "type": ["string", "null"] }
        }
      }
    }
  }
}
```

## Pipeline guards after the call

1. Every `competency_code` must exist in the framework; unknown codes are a rejection, not a drop.
2. The result is projected onto the full framework in `position` order, NULL where absent.
3. Grades outside the scale become NULL with a `validation_warnings` entry.
4. Stored with `grade_origin='suggested'`. A suggestion never satisfies a completeness check and
   never enters a compliance figure.
5. If any suggestion carries `basis='insufficient_evidence'` with a non-null grade, reject the
   whole response - the model contradicted itself.

## Traps

- **Running this over documents that already have competency grades.** A model must never
  overwrite a human grade. Gate it on the absence of a competency summary section.
- **Letting a suggestion count.** As soon as a suggested grade appears in a compliance metric, the
  platform is reporting a model's opinion to an authority.
- **Averaging task grades into a competency grade.** Different axes; a low task grade under a
  competency that was otherwise well performed is not a low competency grade.
- **Penalising non-scoring codes.** They leave both numerator and denominator. Treating them as
  low grades manufactures a downward trend out of missing data.
- **Accepting a name instead of a code.** The schema takes codes only; a name is a display string.
