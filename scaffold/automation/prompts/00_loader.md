# Prompt loader and the placeholder mechanism

Every prompt in this folder is a template with placeholders. **No prompt file contains a
competency name, an observable-behaviour string, a grade descriptor or a model name.** Those are
loaded from the database and from `scaffold/config/*.yaml` at call time and substituted.

Why this is a hard rule and not a preference: when the assessment vocabulary is pasted into prompt
text it exists in three places at once - the database, the application, and the prompts. They
drift. Restoring an older automation export silently reintroduces the previous spellings, the
insert guard and the prompt stop agreeing, and analytics de-align with no error anywhere. One
observed rename touched 63 literal replacements across 10 steps in 4 pipelines. Loading from the
database makes that class of failure structurally impossible: the prompt and the normaliser read
the same rows.

## Placeholders

| Placeholder | Source | Rendered as |
|---|---|---|
| `{{FRAMEWORK_NAME}}` | `competency_frameworks.name` where `is_active` | one line |
| `{{COMPETENCY_LIST}}` | `competencies` for the active framework, `position` order | one line per competency: `<code> \| <name> \| <description>` |
| `{{OB_LIST}}` | `observable_behaviours` joined to `competencies`, `position` order | one line per OB: `<ob code> \| <competency code> \| <text>` |
| `{{GRADE_SCALE}}` | `config/policy.yaml` | one line per grade: `<n> = <how well> (<TEM outcome>)`, plus the non-scoring codes |
| `{{NON_SCORING_CODES}}` | `config/policy.yaml` | comma-separated list |
| `{{ROOT_CAUSE_CODES}}` | `config/analytics.yaml` | one line per code: `<code> \| <label>` |
| `{{FIGURE_SET}}` | computed by the pipeline, SQL only | a labelled block of every number the narrative may refer to |
| `{{DOCUMENT_TEXT}}` | cleaned extracted text | verbatim, already truncated |
| `{{RECORDS}}` | assembled record corpus or map-step summaries | chronological, each headed with document name and date |
| `{{SUBJECT_LABEL}}` | display label for the subject | one line, synthetic in all examples |
| `{{REPORT_SECTIONS}}` | option flags | the numbered section plan, computed in code |

## SQL the loader runs

```sql
-- competencies
select c.code, c.name, c.description, c.position
from competencies c
join competency_frameworks f on f.id = c.framework_id
where f.is_active and c.deleted_at is null
order by c.position;

-- observable behaviours
select o.code as ob_code, c.code as competency_code, o.text, c.position, o.position
from observable_behaviours o
join competencies c on c.id = o.competency_id
join competency_frameworks f on f.id = c.framework_id
where f.is_active and o.is_active and o.deleted_at is null
order by c.position, o.position;
```

The same two result sets feed the prompt **and** the normaliser that projects the model's output
back onto the framework. One source, no drift.

## Substitution rules

1. Substitution is literal and total. An unresolved `{{...}}` token in a rendered prompt is a
   **failure**, not a warning: the call does not go out. Silent substitution of an empty list is
   how a prompt ends up asking for "the following competencies:" followed by nothing.
2. Injected free text is sanitised first: control characters removed, `"` to `'`, backslashes
   dropped, length capped. A hand-built JSON body is broken by exactly two characters.
3. Placeholders are substituted into the **user** message. The system message is fixed text plus
   `{{COMPETENCY_LIST}}` / `{{OB_LIST}}` / `{{GRADE_SCALE}}` only.
4. Model names never appear. The seam picks `LLM_MODEL_FAST` or `LLM_MODEL_DEEP`.

## CI check

The kit's CI greps every file in this folder for: any competency name from the seed, any OB text
from the seed, any grade descriptor, any string matching a known model-id shape, and any URL. A
match fails the build.
