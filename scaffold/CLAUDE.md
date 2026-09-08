# Instructions for a coding agent working in this scaffold

You are continuing someone else's build. This file tells you what to read, what you may not break,
and what "it works" has to mean before you say it.

## 1. Read order

1. `../_KIT_CONTRACT.md` — the authoring contract. Hard rules, naming, table names, number ranges.
2. `README.md` — what runs today, what is a stub, what nobody has written yet.
3. `app/ROUTES.md` — every route, the capability that gates it, its state.
4. The doc for the area you are touching: `../docs/02_DATA_MODEL.md`, `03_COMPETENCY_FRAMEWORK.md`,
   `04_ETR.md`, `05_TEMPLATES_AND_BUILDER.md`, `06_ANALYTICS.md`, `07_VISUALISATION.md`,
   `08_QMS.md`, `09_DMS.md`, `10_INTEGRATION.md`, `11_AI_PIPELINE.md`,
   `12_ROLES_AND_PERMISSIONS.md`, `13_DESIGN_SYSTEM.md`, `15_DEPLOYMENT.md`, `16_TRAPS.md`,
   `17_GOVERNANCE.md`.
5. The `lib/` module you are about to use. Do not add a parallel helper next to an existing one.

**`docs/` is the authority.** Where the scaffold and a doc disagree, the doc is right and the
scaffold is the thing that gets fixed. If you conclude the doc is wrong, say so in your final
message and change nothing in `docs/03`, `docs/04`, `docs/05` or an existing migration.

## 2. Invariants you must not break

**Ids, not names.** Grades reference `competency_id`; observable-behaviour selections reference
`observable_behaviour_id`. A competency or OB name is a display string that an operator edits
without a migration. Nothing keys on it — not a column, not a class name, not a switch, not a
prompt, not a comment that a later reader will trust.

**`element_key`, not the row id.** `template_elements.element_key` is stable and author-assigned.
Answers, grades and imported tasks reference the key. The row's surrogate `id` changes when an
editor rewrites an element set, and anything pointing at it is orphaned silently.

**Grades are `TEXT`.** `NR`, `NO` and `NA` live in the same column as `1`–`5`. Numeric coercion
happens in exactly one place per language: `grade_num(text)` in SQL, `lib/grades.ts` in TypeScript.
Non-scoring codes resolve to NULL and are excluded from BOTH numerator and denominator. Never
impute, never count as a 3, never mention them in narrative.

**Thresholds live in `config/*.yaml`.** Below-standard, band boundaries, windows, weights,
minimum sample sizes. Read at runtime, injected as values. A literal `2` in a comparison is a
defect even when it is correct today.

**The deterministic core computes; the model narrates.** No figure in a chart, a table, a tile or a
report may originate in a language model. Narration is validated against the computed figure set
before it is stored (`lib/provenance.ts`). Degraded mode — no inference configured — must keep
every figure, chart, table and export working.

**Soft delete, everywhere.** `deleted_at`, plus an `audit_log` row. Nothing hard-deletes a record,
a document or a person; the triggers enforce it, so a `DELETE` will fail loudly rather than
succeed quietly.

**No operator identity.** No airline, vendor, authority, domain or server name anywhere — not in a
comment, not in seed data, not in a test fixture. No real people, no real record values. Synthetic
data is obviously synthetic (`DEMO-0001`, `Alex Rivera`). Env var NAMES only; never a value.

**Capability first, and not rendered.** Every handler: `requireSession()`, then
`requireCapability()` or `requireOnPerson()`, before it reads anything. Every UI element the role
lacks is absent from the markup, not disabled. `proxy.ts` is a filter; `lib/access.ts` is the
boundary.

**Scope before serialisation.** Filter rows in SQL with the visible id set as one `uuid[]`
parameter. Never return rows and expect the client to hide some, and never build the filter
yourself — ask `visiblePersonIds()`.

## 3. Verification discipline

Claiming something works without running it is the fastest way to lose a reviewer's trust for the
rest of the project. Before you say a thing runs:

```bash
npm run typecheck      # tsc --noEmit. A type error is a broken build, not a warning
npm run migrate        # applies cleanly from the current state
npm run seed:framework # and the other seeds your change depends on
npm run dev            # then actually open the routes you changed
npm run smoke          # every route, every subject page, no sampling
npm run test           # the deterministic core
```

Rules about that list:

- A 200 is not proof. `smoke-screens.mjs` checks for a marker in the body and for markers that must
  be absent, because a rendered error boundary, an unexpected empty state and a redirect to the
  login page all return 200.
- Never quieten a check to make it pass. Removing `data-error-boundary="true"` from `ErrorState`,
  or adding a route to the smoke script without a marker, hides exactly the failure the script
  exists to find.
- `--limit-subjects` is sampling. It is for a fast local loop and never for a gate.
- If a script you need does not exist yet, say so plainly. Do not write a stand-in that seeds a
  different shape from the one the docs specify. Everything `package.json` names exists today,
  `scripts/verify.mjs` (`docs/15_DEPLOYMENT.md` §9) included: `npm run verify`, and the last step
  of `npm run reset`.
- `verify.mjs` is a GATE, not a monitor. It assumes a freshly migrated and freshly reseeded
  environment and it must never gain an escape - no cutoff date, no `created_at` floor, no legacy
  flag, no ignore list, no environment variable that narrows an assertion. A check that can be
  waived for old rows can no longer tell a new violation from an old one. If an invariant does not
  hold for the data that exists, the release carries the migration that makes it hold.

## 4. House style

- Server components by default. `'use client'` only when the component genuinely needs
  interactivity, and the file says why in its header.
- Route handlers export handlers and configuration only. Logic goes in `lib/`.
- Filters are `GET` forms; every filtered view is a URL.
- No charting library, no CSS framework, no component library. Hand-written SVG and one
  stylesheet.
- Files split at about 400 lines.
- Comments explain why, and name the failure a rule prevents. Do not narrate what the code does.
- No emoji, anywhere.

## 5. When you finish

State what you changed, what you ran, what you verified, and what you did not. Name anything you
found wrong in another author's file rather than fixing it silently — especially in `docs/03`,
`docs/04`, `docs/05` and the existing migrations, which are closed.
