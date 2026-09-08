# 05 · Templates and the builder

Purpose: how an assessment form is authored, versioned, published, rendered and filled.
Status: spec + scaffolded (migrations 0020–0023, `scaffold/db/seed/templates/`)
Version: v1.0 · 2026-08-26

There are two authoring surfaces in the platform and they share one philosophy but not one model:

| | Session template (this doc) | Qualification definition (`docs/08`) |
|---|---|---|
| what it describes | the form a session is graded on | the rules a person must satisfy to hold a qualification |
| stored as | rows: version + elements + competency selection | one versioned JSONB definition |
| authored in | the **template builder** (free-form canvas) | the **qualification builder** (six-step wizard) |
| versioning | published versions are immutable; clone to edit | identical |

Both follow the same three rules: a published version is never edited, every consumer records the
version it used, and the preview shows the author what the thing will do before they publish it.

---

## 1. Model

```
session_templates            stable identity: code, name, kind, asset_class, owner, status
  └── session_template_versions   version, status draft|published|retired, effective_from,
      │                           change_note, session_setup jsonb, published_at/by
      ├── template_elements        element_key, element_type, title, position, parent_key,
      │                            is_mandatory, external_ref, config jsonb
      └── template_competencies    competency_id, position, allowed_ob_ids (empty = all)
```

Two columns carry the weight:

- **`element_key`** — stable, author-assigned, unique within a template version, and never
  regenerated. Every answer, every import mapping and every analytic rollup keys on it. In the
  system this kit is distilled from, saving a template deleted and re-inserted every element row,
  minting new ids and orphaning the answers stored against them. That is the failure this column
  exists to prevent.
- **`external_ref`** — the operator's syllabus item number. It is an import mapping key and a
  cross-reference, **never an identity**: syllabus owners renumber, and identity must survive that.

`template_competencies` selects which of the framework's competencies this form grades, and
optionally narrows the OB pick-list. It stores `competency_id`, never a name.

## 2. Element catalogue

| `element_type` | Renders as | `config` keys | Graded |
|---|---|---|---|
| `section` | full-width band that groups the elements after it; collapses its children | `competency_ids[]`, `performance_criteria[]` | no |
| `task` | the graded item: card with number, time, role, grade control, optional comment | `number`, `time`, `total_time`, `role` (`A`/`B`/`both`/`either`/null), `notes`, `grade_type` (`scale`\|`boolean`), `competency_ids[]`, `performance_criteria[]`, `allow_attempts` | yes |
| `setup` | a set-up / reset block rendered as a labelled table | `rows[] {label, value}`, `notes` | no |
| `event_option` | multi-select option group (malfunctions, scenarios); selections print on the report | `options[] {key, name, trigger}` | selection only |
| `note` | static instructional prose | `text` | no |
| `field` | a typed input: `text`, `textarea`, `number`, `date`, `select`, `checkbox`, `radio` | `field_type`, `label`, `options[]`, `required`, `min`, `max`, `pattern`, `help` | no |
| `computed` | a read-only derived panel rendered by a named component reading one endpoint | `component`, `params` | no |
| `group` | a repeatable set of children, `min`/`max` instances | `min`, `max`, `item_label` | children |

Conditional visibility is available on every element: `config.visible_when = {element_key, op, value}`.

Five things the renderer owns natively and no template may declare: the subject cards, the competency
block, the outcome selector, the session remarks, and the signature blocks. A template that declares
its own "Remarks" section duplicates the native one; the builder rejects reserved titles at save.

`computed` deserves its own note. A derived panel — a progress counter, a running total, a currency
strip — is never typed by a human and never re-implemented per template. It names a component, the
component reads one endpoint, and the arithmetic lives in one place. A form that asks an assessor to
add up their own sectors will eventually be wrong, and no one will know which copy was right.

## 3. The builder

A free-form canvas, not a wizard, because a session form is a sequence rather than a decision tree.

- **Three visual levels by indent and colour**: section (full width) → task and setup block
  (indent 1) → event option group (indent 2). The nesting is rendered from `element_type` and
  `parent_key`; the stored model is a flat ordered list, which is what makes reordering cheap.
- **Drag and drop with explicit drop zones**; `position` renumbers sequentially on drop.
  `element_key` never changes.
- **Two palettes, always visible**: the element library (reusable tasks with their competency tags)
  and the option library (faceted by system chapter), each searchable.
- **Undo/redo** over a bounded ring of states.
- **Per-element menu** for duplicate, convert type, group, remove. Menus flip upward near the
  viewport bottom.
- **Collapse controls** per section plus expand-all / collapse-all, with a hidden-count badge.
- **Competency tab** — pick the competencies this form grades and narrow OB lists.
- **Preview tab** — renders the form exactly as the assessor will see it, against a synthetic
  subject, from the draft definition.
- **Publish** — validates, requires a change note and an effective date, and is password-confirmed:
  publishing changes what people will be graded against.
- **Batch edit at list level** with per-field opt-in, so an unticked field is left unchanged rather
  than blanked.

Validation at publish, enforced server-side and independently of the UI:

1. every `element_key` unique within the version and matching `^[a-z0-9][a-z0-9_.-]{0,63}$`;
2. no reserved titles; no empty template; no section with no children;
3. every `competency_id` and `observable_behaviour_id` exists in the framework;
4. every `visible_when.element_key` resolves inside the same version;
5. `effective_from` present and not in the past;
6. a published version with the same `effective_from` does not already exist.

## 4. Rendering and answer storage

A session records `template_version_id` at creation. It renders that version for its whole life,
whatever happens to the template afterwards.

Answers are normalised rows, not an answer blob:

```
element_grades(session_id, person_id, element_key, instance_no, attempt, grade, remarks, graded_at)
competency_grades(session_id, person_id, competency_id, grade, remarks)
competency_grade_obs(competency_grade_id, observable_behaviour_id)
```

`instance_no` covers repeatable groups; `attempt` covers repeats of the same item. Field-type
elements store into `element_grades.value_text` / `value_num` / `value_date` on the same key.

At finalise the answers are also frozen into `records.snapshot` (`docs/04` §6) so a record survives
the retirement of its template.

## 5. Versioning and migration

| Situation | Behaviour |
|---|---|
| author edits a draft | free, in place |
| author edits a published version | not possible; clone to `version + 1` as a new draft |
| a new version is published | new sessions use it; **in-flight sessions keep rendering their own version** |
| a version is retired | no new sessions; existing records still render |
| a template is deleted | only a draft may be deleted; a template with any record is deactivated, never removed |

Backdating a publish does not retroactively re-grade or re-render anything, and the publish dialog
says so in words.

Migration discipline when replacing an authoring model: run the old and new renderers side by side
over every template, diff the produced forms, and switch one template kind at a time behind a flag.
Verify by comparing outputs, not by reading code.

## 6. Seed templates

The kit ships four synthetic starter templates in `scaffold/db/seed/templates/`, authored against the
ICAO framework and carrying no operator content. They exist to make a fresh install renderable and to
show the builder's element types in use.

| File | Kind | Shape |
|---|---|---|
| `simulator_recurrent.json` | `simulator_recurrent` | 6 sections, 24 tasks with attempts, 2 setup blocks, 1 malfunction option group, all 9 competencies |
| `proficiency_check.json` | `proficiency_check` | fixed manoeuvre list, 18 tasks, per-task comments, competency block that tolerates being entirely unfilled |
| `line_supervised.json` | `line_supervised` | the one-sector form of §7, 9 tasks, 3 with a `flown_by` radio, a `computed` progress panel |
| `ground_school.json` | `ground_school` | classroom form: attendance field group, 6 knowledge checks, one outcome, fan-out on signature |

Every seed template is validated by `scripts/seed-templates.mjs` against the same publish rules the
builder enforces. If the seeder passes something the builder would reject, the seeder is wrong.

## 7. Worked example — the supervised-line-sector template

The most instructive of the four, because its structure is a set of decisions rather than a layout.

**One record is one sector.** A multi-sector duty day is two records. There is no "add another leg"
affordance and no repeatable group. That single rule makes the sector counter unambiguous, makes the
title token derivable, and lets the finalise hook write exactly one `line_sectors` row per session
with a conflict-update rather than reconciling a list.

**The title is generated, never typed**: `S{seq}/{planned} · {role} · {date} · {flight} {dep}/{arr}`,
used in the form header, the record list, the report footer and the filename, so progress reads at a
glance anywhere.

**Structured, not free text.** Whether the subject flew the take-off and the landing are booleans
(`to_by_subject`, `lnd_by_subject`), defaulted from the sector role and overridden only for the
exception — because a free-text tag cannot be counted, filtered or alerted on. The approach is graded
but excluded from the regulatory minima, and the template says so rather than leaving it implied.

**The progress panel is `computed`.** Sectors done against planned and against the minimum, take-offs
and landings per role, observation sectors, partner-operator sectors, release state, and a pace
warning — all derived from previously finalised sectors by one endpoint. Where a classification has
no per-role minimum, the panel shows a bare count with no target and no colour, rather than inventing
a threshold to be amber against.

## 8. Import and export

**Template import is parse-then-commit, never single-shot.** One endpoint parses a source document
(PDF, workbook) and returns a draft definition **without writing**; the author reviews and edits it in
a preview; a second endpoint commits it. Templates run to dozens of elements, and a silent insert of
a mis-parsed structure is unacceptable.

Parse rules: unknown element type → drop that element and report it; `position` renumbered from zero
whatever the source said; `element_key` generated from `external_ref` or slugified title and made
unique; competencies resolved against the framework by code and **rejected if unknown** — never
substituted with a default; an empty template name is a hard failure. Duplicate `(code, effective
period)` at commit returns a conflict with the existing id unless overwrite is explicitly requested.

Export is the same definition as JSON, plus a rendered PDF of the blank form for the training manual.

## 9. Traps

- **Save must not re-mint element identity.** Diff-based saves keyed on `element_key`; never
  delete-then-reinsert. A template seeded outside the builder is otherwise wiped the first time an
  author opens and saves it.
- **Unmatched import elements are dropped silently.** Verify the mapping before loading, never after.
- **Reserved titles duplicate native blocks.** Validate at authoring time, not at render time.
- **A competency list pasted into a parser or a prompt goes stale.** Resolve competencies from the
  database at runtime and reject unknown codes.
- **One grouping level is enough.** Arbitrary nesting in a rule or form editor produces definitions
  nobody can read and previews nobody trusts. Sections and one level of grouping, and a preview that
  renders the whole thing in plain language.
- **A publish that changes who is qualified deserves friction.** Change note, effective date,
  password confirmation, diff against the current version.
- **The builder's validation and the seeder's validation must be one function.** Two copies drift,
  and the drift shows up as data the UI cannot open.
