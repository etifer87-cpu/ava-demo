# 08 · QMS — qualification management

Purpose: how the platform decides what a subject is currently authorised to do, and how a human
grants it.
Status: spec + scaffolded (migrations 0060–0079, `scaffold/lib/qms/*`)
Version: v1.0 · 2026-08-26

---

## 1. Scope and the one invariant

QMS is the rules-and-compliance engine. It does not grade and it does not store files. It reasons
over what other modules already hold: completion events and grades from ETR (`records`,
`competency_grades`, `line_sectors`), document validity from DMS (`documents`), and experience and
recency from the crew-scheduling feed (`docs/10_INTEGRATION.md`). It emits three things: a derived
qualification status, expiry alerts, and grant alerts.

> **Qualifications are never auto-granted.** Rules being satisfied raises an alert. A human opens
> the alert, sees when each condition was met and against which evidence, and approves. The grant
> is the human act; the engine only ever proposes.

This is load-bearing for authority defensibility and it is the first thing an auditor tests. Every
row in `qualifications` therefore has a named accountable approver reachable through `qual_approvals`
and `qms_events`. A qualification with no approver row is a defect, not a legacy case.

Two further invariants that fall out of it:

| Invariant | Consequence |
|---|---|
| Effective status is derived on read, never stored | Nothing goes stale because a nightly job failed |
| Instructor authorities are qualifications, not roles | A role is who you are; a qualification is what you are authorised to do **today**, and it expires |

The second is the single most reusable idea in this module. Line-training authority, base-training
authority, CRM instruction, examining, standardisation currency and assessment-of-competence are
all `qual_types` with a validity window. Modelling them as roles loses the expiry date, which is
the entire point. Permission cells therefore read `role + requires_qual`: same person, same role,
the qualification decides as of today. See `docs/12_ROLES_AND_PERMISSIONS.md`.

## 2. Tables

`qual_types` · `qual_type_versions` · `qualifications` · `qual_approvals` · `attestations` ·
`qms_events`. DDL in `scaffold/db/migrations/0060`–`0069`.

| Table | Holds |
|---|---|
| `qual_types` | catalogue identity only: `code` (stable, filename-safe), `name`, `category`, `is_active`. No rules. |
| `qual_type_versions` | the versioned `definition JSONB` — every rule, window and approval setting lives here |
| `qualifications` | per-subject holdings: which version granted, validity dates, override, evidence pointer |
| `qual_approvals` | one row per approval workflow instance: open, granted, rejected, waived |
| `attestations` | a named human agreement that gates something (`consent` severity), with staleness |
| `qms_events` | append-only timeline; the version history and the audit trail |

Adding a qualification, a category, a rule or a condition must be an **INSERT, not a migration**.
If a new requirement forces DDL, the definition schema is wrong.

## 3. The versioned definition

A `qual_types` row carries no rules. Rules live in `qual_type_versions.definition`, one JSONB
document per version, immutable once published. A holding records `qual_type_version_id`, so a
subject granted under v3 is still evaluated and displayed under v3 after v4 publishes.

```jsonc
{
  "schema_version": 1,

  "identity": {
    "code": "line_qual",                 // must equal qual_types.code
    "name": "Line qualification",
    "category": "authority",             // licence|medical|rating|route|authority|
                                         // ground|lms|simulator|recency
    "framework_id": "…",                 // required when any condition names a competency
    "description": "…",
    "regulatory_ref": "…"                // free text, framework-generic
  },

  "applicability": {                     // who this type is REQUIRED of; empty arrays = all
    "match": "all",                      // all | any
    "org_unit_ids": [],
    "asset_class_ids": [],
    "positions": [],
    "instructor_roles": [],
    "exclude_person_ids": []             // named exclusions, each needing a reason in the event log
  },

  "requirements": {                      // ONE grouping level. Groups hold conditions.
    "match": "all",                      // all | any | n_of
    "n": null,                           // required when match = n_of
    "groups": [
      {
        "group_key": "g_sim",            // stable, author-assigned, unique in the definition
        "label": "Simulator",
        "match": "all",
        "n": null,
        "conditions": [
          { "condition_key": "c_lpc", "type": "session_completed",
            "params": { "template_code": "lpc", "results": ["pass"] } }
        ]
      }
    ]
  },

  "constraints": [                       // ordering and windowing ACROSS groups/conditions
    { "kind": "after",  "subject": "c_line_check", "reference": "g_sim" },
    { "kind": "within", "members": ["g_sim", "g_ground"], "window_days": 90 }
  ],

  "validity": {
    "mode": "interval",                  // interval | fixed_date | one_time
    "months": 12,                        // interval only
    "anchor": "last_condition_met",      // last_condition_met | approval | earliest_evidence | fixed
    "anchor_date": null,                 // fixed only
    "end_of_month": true,                // expiry rolls to the last day of the anchor+n month
    "warning_days": 60,
    "early_renewal_days": 90,
    "expiry_grace_days": 0
  },

  "approval": {
    "mode": "single",                    // single | two_step | waiver
    "approver_capability": "qms.qualifications.approve",
    "second_approver_capability": null,  // two_step only; must differ from the first approver
    "requires_attestation": false,
    "attestation_key": null,
    "reason_required_on_reject": true
  }
}
```

Notes that matter:

- **One grouping level, deliberately.** Groups contain conditions; conditions never contain groups.
  Arbitrary nesting is expressible but neither the editor nor the plain-English renderer can present
  it honestly, and an approver who cannot read the rule cannot defend the grant.
- **`group_key` and `condition_key` are author-assigned and stable.** Results, evidence links and
  the version diff all reference keys, never array positions. Reordering the editor must not
  invalidate a stored result. Same rule as `template_elements.element_key` in `docs/04_ETR.md`.
- **Constraints are separate from conditions** because they are relations, not tests. `after` says
  the subject's `met_at` must be later than the reference's; `within` says the spread between the
  earliest and latest `met_at` of its members must not exceed `window_days`. A constraint whose
  members are not all met is `not_evaluable`, not failed.

### 3.1 Validity: two windows, never one

`early_renewal_days` and `expiry_grace_days` are different windows on opposite sides of
`valid_until` and must never be collapsed into a single "tolerance" number.

| Window | Side | Meaning | Effect on the new expiry |
|---|---|---|---|
| `early_renewal_days` | before `valid_until` | renewal completed inside it is treated as on-time | new expiry anchors to the **old** `valid_until`, not to the completion date, so credit is not lost |
| `expiry_grace_days` | after `valid_until` | the holding is expired but tolerated for a stated period | new expiry anchors to the **completion date**; the gap is real and is recorded |

`end_of_month` rolls the computed expiry to the last day of its month, which is how most authority
validities are expressed. Apply it after the month arithmetic, never before.

`mode: fixed_date` stores the expiry that the evidence itself carries (a licence, a medical) and
leaves `months` null. `mode: one_time` never expires: the holding is `valid` once granted and
`missing` until then.

## 4. Condition-type registry

One registry drives both the builder's editor and the evaluation engine:
`scaffold/lib/qms/conditions.ts`. Each entry declares its parameter descriptors (which is what the
editor renders), its evidence bucket, its status, and a pure evaluator. Adding a condition type is
one registry entry plus, where the evidence is new, one integration feed. No schema change.

| Type id | Reads | Status |
|---|---|---|
| `session_completed` | `records` by template code / session type + result set | buildable |
| `record_count` | count of matching `records` in a window | buildable |
| `competency_minimum` | `competency_grades` for a `competency_id`, minimum grade over last n | buildable |
| `observable_behaviour_seen` | `competency_grade_obs` for an `observable_behaviour_id` | buildable |
| `element_signed` | `element_grades` by `element_key` | buildable |
| `sector_count` | `line_sectors`, filtered by role PF/PM and take-off/landing flags | buildable |
| `document_valid` | `documents` of a `doc_type`, valid as of `asOf` | buildable |
| `qualification_held` | another `qual_types.code`, valid as of `asOf` | buildable |
| `attestation_present` | `attestations` by key, live and not stale | buildable |
| `manual_evidence` | a human-attached document or note on the approval | buildable |
| `lms_course_completed` | LMS course-completion feed | **stubbed** — needs the feed |
| `flight_experience` | hours / sectors / landings from crew scheduling | **stubbed** — needs the feed |
| `recency_window` | last qualifying duty within n days, from crew scheduling | **stubbed** — needs the feed |
| `external_event` | any integration event by `external_refs.kind` | **stubbed** — needs a counterparty |

A **stubbed** type is fully buildable in the editor and fully renderable in English. Its evaluator
returns `unmet` with `reason: "feed_unavailable"` and `evaluable: false` until the feed is
connected. This is deliberate: an operator can author the real rule on day one, see it displayed
honestly as not-yet-evaluable, and have it start working the day the feed lands, with no edit.
A stubbed condition must never silently evaluate as met. See `docs/10_INTEGRATION.md`.

## 5. The evaluation engine

`scaffold/lib/qms/engine.ts`. Contract, in full:

```ts
evaluate(definition: QualDefinition, evidence: QmsEvidence, asOf: Date): QualEvaluation
```

1. **Pure.** No I/O, no database handle, no clock. Every date comparison uses the injected `asOf`.
   `new Date()` appears nowhere in the module. This is what makes "what would this rule have said
   on 3 March?" answerable, and what makes the engine testable without a database.
2. **Evidence in, decision out.** The caller assembles a `QmsEvidence` bundle with one query per
   bucket for the subject. The engine never widens that.
3. **Unknown condition type returns `unmet`**, `evaluable: false`, `reason: "unknown_condition_type"`.
   It never throws. A definition written by a newer version of the builder than the running engine
   must degrade to "cannot confirm", not to a 500 and never to "met".
4. **Never throws at all.** Malformed params, missing fields and impossible windows all resolve to
   `unmet` with a machine-readable reason. The one exception the engine is allowed to make is
   returning `errors[]` alongside the result for the builder to display.
5. **An empty requirement set is never met.** Zero groups, zero conditions in every group, or a
   group whose conditions all fail the shape check yields `met: false`,
   `reason: "no_requirements_defined"`. `Array.prototype.every()` on an empty array returns `true`,
   and that default would auto-satisfy every half-authored draft in the catalogue. There is an
   explicit guard for this and a test that asserts it.

Output shape:

```ts
{
  met: boolean,
  met_at: string | null,          // ISO date of the LAST condition needed to satisfy the rule
  conditions: [{ condition_key, group_key, type, met, met_at, evaluable, reason, evidence_refs }],
  groups:     [{ group_key, met, met_at, satisfied_count, required_count }],
  constraints:[{ index, kind, status: 'met'|'violated'|'not_evaluable', detail }],
  validity:   { valid_from, valid_until, warning_from, early_renewal_from, grace_until } | null,
  errors: string[]
}
```

`met_at` is the maximum `met_at` across the conditions that were actually required — not the latest
evidence in the bundle. Under `match: any` it is the earliest satisfying condition's date.
`validity` is computed only when `met` is true and all constraints are `met`.

## 6. Status derivation

Derived on read by `deriveStatus(holding, definition, asOf)`, in this precedence:

| Order | Status | When |
|---|---|---|
| 1 | `suspended` | `status_override = 'suspended'` — manual only, or set by a fail / not-completed / no-show outcome so nobody reads as authorised incorrectly |
| 2 | `inactive` | `status_override = 'inactive'` — the subject is not required to hold it right now |
| 3 | `missing` | applicable to this subject but no holding, or a holding with no validity dates |
| 4 | `pending_approval` | rules met, an open `qual_approvals` row, no grant yet |
| 5 | `expired` | `asOf > valid_until + expiry_grace_days` |
| 6 | `warning` | inside `warning_days` before `valid_until`, or inside the grace window after it |
| 7 | `valid` | otherwise |

`planned` is a **presentation** pseudo-status only: a non-expired holding with an upcoming training
plan. It is never persisted and never a database value. "Due" in a KPI means inside the warning
window **and not planned**.

Absence is a finding. For any type whose `applicability` matches a subject, a missing holding is a
`missing` row in every count, and compliance is reported as a fraction per org_unit and asset_class
("38 of 41 current"), never as a list of the people who happen to have a row.

## 7. Approvals, attestations, timeline

**`qual_approvals`** is the workflow instance. `state ∈ open | granted | rejected | waived |
withdrawn`. It carries the `evaluation JSONB` snapshot taken when the alert was raised — what the
engine saw, condition by condition, with dates — so the approver approves against a frozen picture
and the auditor sees the same picture later. `decided_by`, `decided_at`, `decision_reason`.

- **Single** — one approver holding the capability.
- **Two-step** — `first_approved_by` then `decided_by`; a database CHECK requires they differ. The
  second step re-reads the live evaluation and refuses if it has changed since the first.
- **Waiver** — a grant where the rule is *not* met. Permitted, requires a mandatory reason, records
  which conditions were unmet at the time, and is reported separately in every compliance figure.
  A waiver that is invisible in reporting is worse than no waiver mechanism.

A partial unique index enforces **one open approval per subject per qualification type**. Without
it, two alerts raised by two nightly runs produce two grants and two holdings.

**`attestations`** are the `consent` severity: a named human agreement that blocks until present.
The pattern is the projected-figure attestation — a manager attests to a stated `figure` in the
payload; if a later change pushes the real figure above what was attested, the attestation goes
**stale** and blocks again until re-attested. Attesting at one figure must not silently authorise a
higher one. A partial unique index enforces **one live attestation per subject per key**.

**`qms_events`** is append-only and is the version timeline for both types and holdings. Kinds are
listed in migration `0065`. Nothing updates or deletes a row: `REVOKE UPDATE, DELETE` and write
through a restricted role. Append-only by convention is not append-only. See `docs/17_GOVERNANCE.md`.

## 8. The builder wizard

Six steps, one draft `qual_type_versions` row saved on every step, `status = 'draft'`.

| Step | Screen | Guardrail |
|---|---|---|
| 1 | Identity — code, name, category, framework, regulatory reference | `code` is immutable after the first publish; the editor locks it |
| 2 | Applicability — org_unit, asset_class, position, instructor role, exclusions | live **applicability counter**: "applies to 412 of 1,180 people". A rule that matches everyone or nobody is almost always an authoring error, and the counter is how it is caught before publish |
| 3 | Requirements — groups and conditions from the registry | condition params are rendered from the registry descriptors; stubbed types are marked "not evaluable yet" in place |
| 4 | Constraints — AFTER and WITHIN across groups | only keys already defined in step 3 are selectable |
| 5 | Validity and alerts — mode, anchor, end-of-month, warning, early renewal, grace | the two windows are two separate inputs on opposite sides of a rendered timeline, so they cannot be conflated |
| 6 | Approval and publish — mode, capabilities, attestation, effective date | version diff, then password-confirmed publish |

Running down the right of every step:

- **Live preview** — the plain-English rendering of the draft, updating as it is edited.
- **Applicability counter** — recomputed server-side against `people`, never in the browser.
- **Version diff** — the published version against the draft, rendered as English on both sides,
  not as a JSON diff. The approver of a rule change is reading a rule, not a document.
- **Dry-run** — evaluate the draft against a sample of currently-applicable subjects and show how
  many would be met, unmet, or not-evaluable today. A rule change that would instantly satisfy 900
  people is visible before it is published, not after the alerts arrive.

### 8.1 Publish invariants (server-side, every one of them)

The client may check these for a good error message. The server enforces them, because the client
cannot be trusted and a bad definition is unrecoverable once holdings reference it.

1. `identity.code` equals the parent `qual_types.code`.
2. At least one group with at least one condition. Empty definitions cannot be published.
3. Every `group_key` and `condition_key` is unique within the definition and matches `^[a-z0-9_]+$`.
4. Every condition `type` exists in the registry; every required param is present and type-correct.
5. Every constraint references keys that exist.
6. `match: n_of` carries `1 <= n <= member count`.
7. `validity.mode = interval` requires `months >= 1`; `fixed_date` forbids `months`;
   `one_time` forbids all four window values.
8. `two_step` requires a distinct `second_approver_capability`.
9. `requires_attestation` requires a non-null `attestation_key`.
10. Any condition naming a competency or observable behaviour requires `identity.framework_id`,
    and the ids must exist in that framework.
11. `effective_from` is not in the past.
12. A partial unique index permits **one published version per code per effective date**.
13. Publishing re-authenticates the acting user's own password server-side, fails closed 403, and
    writes `qms_events(kind='version_published')` with the actor and the full definition.
14. Publishing never rewrites existing holdings. Holdings keep their granted version until they are
    renewed under the new one.

## 9. Traps

Each of these also appears in `docs/16_TRAPS.md`.

**An empty requirement set evaluates as met.** What happens: a half-authored type with no
conditions marks every applicable subject as satisfied and the approval queue fills with grants for
a rule nobody wrote. Why: `[].every(fn)` is `true`, and the group loop and the condition loop both
hit it. What to do instead: an explicit guard at the top of `evaluate()` returning
`no_requirements_defined`, plus publish invariant 2, plus a test that asserts both.

**Storing derived status.** What happens: a nightly materialisation job fails on a Sunday and on
Monday a subject reads as valid three weeks after expiry. Why: a stored status is only as fresh as
the last successful run, and nothing about the row says how stale it is. What to do instead: derive
on read from `valid_until` and the override. Materialise only as an explicitly-timestamped cache
that the read path is allowed to ignore.

**Conflating early renewal with expiry grace.** What happens: a renewal done a month early
re-anchors to the completion date and quietly shortens the subject's validity by a month, every
cycle. Why: both windows are "days near the expiry" and get merged into one setting. What to do
instead: two fields, two sides, two anchor rules, rendered on a timeline in the editor.

**Modelling instructor authorities as roles.** What happens: an expired examining authority is
still enforced as a role, so an out-of-currency assessor signs a check. Why: roles have no expiry
date. What to do instead: authorities are `qual_types` with validity; permission cells carry
`requires_qual`; the session-create path checks the assessor's status for that stage as of today,
refuses expired, and logs any admin override.

**Auto-granting on rules satisfied.** What happens: nobody can name the human accountable for a
qualification, and the audit fails on the first sample. Why: an engine that can grant will grant.
What to do instead: the engine can only ever write `qual_approvals(state='open')`; the grant path
requires a capability, an approver, and an evidence snapshot.

**Two alerts, two grants.** What happens: a re-run of the evaluation raises a second open approval
and the same qualification is granted twice with different dates. Why: no uniqueness on the
workflow instance. What to do instead: the partial unique index on `(subject_id, qual_type_code)
WHERE state = 'open'`, and an upsert that names it as the conflict target.

**Keying results to array position.** What happens: an author drags a condition up one place and
every stored evaluation, evidence link and diff now points at the wrong rule. Why: JSONB arrays
have order, and order changes. What to do instead: `condition_key` and `group_key`, referenced
everywhere; position is presentation only.

**A stubbed condition that evaluates as met.** What happens: a type depending on an experience feed
that does not exist yet marks everyone met, and grants are approved against nothing. Why: a missing
evidence bucket reads as an empty array, and "no disqualifying evidence" gets treated as pass. What
to do instead: registry entries declare `status: 'stubbed'`; their evaluators return
`evaluable: false`, and both the engine and the English renderer say so out loud.

**Rule changes applied retroactively.** What happens: raising a minimum in one month turns a
previous month's compliant grants red. Why: holdings evaluated against the live definition rather
than the one they were granted under. What to do instead: holdings pin `qual_type_version_id`;
migrations to a new version happen at renewal.

**Matchers living in code.** What happens: a new session type stops mapping to its qualification
and nothing raises, because the keyword list is in a deployed module. Why: mapping was written as
code because it started as three `if`s. What to do instead: matchers are condition params in the
definition; adding one is an INSERT.
