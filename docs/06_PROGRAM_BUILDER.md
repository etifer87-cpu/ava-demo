# 06 — Program Builder

**Status: plan, not built.** Written 2026-09-11 against the running instance (79 migrations,
`verify:clean` green). Nothing in here has been implemented. It settles the model, the screens, the
seed content and the vocabulary so that the build is mechanical.

Sources read: `EBT A Guide` (Avianca Baseline EBT M1 PII A320 Instructor Guide, Rev. 2, 35 pp),
`PROGRAM_BUILDER_CONTENT_AND_VIEWS_v1_0.md`, `CVX_DECISION_stated_gaps_and_inspector_editing.md`,
and the kit's own `docs/05_TEMPLATES_AND_BUILDER.md` schema as migrated (0020-0023, 0032-0035, 0141).

---

## 1. What gets built

Three screens, in this order:

| # | Screen | Route | Who |
|---|---|---|---|
| 1 | **Programs** — every template, its kind, fleet, version and status, plus **Create new program** | `/templates` | Admin · Head of Training · Training Manager |
| 2 | **Builder** — three panes: library rail, program canvas, inspector | `/templates/[id]` | same |
| 3 | **As instructor** — the instructor projection of the same program, read-only, with a **task rail on the left to navigate** | `/templates/[id]?view=instructor` | same |

Review & Sign (the third reference screen) is the *delivery* module's output, not the builder's. It
is the step after this one and is specified in `docs/04_ETR.md`; it is named here only so nobody
expects it in this slice.

---

## 2. The model — reuse, do not fork

The reference documents describe a `prog.*` / `lib.*` schema (program · module · session · block ·
event). **We are not porting those tables.** The kit already carries an equivalent model, every
grade in the system keys on it, the published-version immutability triggers already guard it, and
the 26-assertion gate suite already asserts against it. A second model would fork the product.

The mapping is exact enough to be boring:

| Reference concept | This build |
|---|---|
| Program | `session_templates` + `session_template_versions` (one template = one gradable session) |
| Module / Session / Block | `template_elements` with `element_type='section'`, nested by `parent_key`, kind in `content.section_kind` |
| Event | `template_elements` with `element_type='task'` |
| Set-up panel | `element_type='setup'` |
| Failure chosen at delivery (slot) | `element_type='event_option'` |
| Instructor prose | `element_type='note'` |
| `lib.tasks`, malfunctions, injects, presets | `element_library`, separated by `element_type` + `tags` |
| `event_targets` | `template_competencies` (version level) + `content.grading.competencies` (element level) |
| `program_type` | `template_kinds` (0032, 0141) — `ebt_recurrent`, `proficiency_check` = "OPC / LPC", `type_rating`, `line_check` |

**Consequence: the builder needs no new tables.** It needs one new migration at most — for the
library-kind tags and any missing index — plus screens, a content shape and a validator.

### 2.1 The content shape

`template_elements.content` is JSONB and today free-form. The builder makes it a **documented,
versioned shape**, declared once in `lib/templates/shape.ts` and validated on every write:

```
task:
  time            "0:50"
  pf              "CM1" | "CM2" | null      (null renders blank, never "both")
  setup           { airport, weather, mass_config, position, reset, atc_script }   each { ref, override }
  conduct         { malfunction, insertion, injects[], instructor_notes, option_group_key }
  automation      { ap, athr, fd }          each required_on | required_off | crew_discretion | n/a
  aims            { aims, competency_focus, grading_criteria, visibility }
  grading         { task_outcome_mode, competency_grade_mode, competencies[] }
  snapshot        "take" | "recall" | null
  variants        { "<device_code>": { ...overrides } }
```

Two rules carried over from the reference decision, because they were paid for once already:

- **Set-up and conduct are references into the library, chosen with a picker — never free text.**
  The override field exists for the local variation and sits one click further away. The moment
  somebody can type an airport into an event, the library stops being the library.
- **Save on blur, per field, one transaction each. No Save button.** Everything the builder touches
  is a *draft*; a published version is immutable by trigger. A gate on a draft edit is ceremony.
  Confirmation gates stay on delete and on publish, where they mean something.

### 2.2 What is deliberately deferred

| Thing | Why | How it appears meanwhile |
|---|---|---|
| Malfunction reference text | The device vendor's effect and cue text is its owner's | **Done 2026-09-11 for the index only**: `data/library/a320-malfunctions.json` carries the IOS button titles, ATA chapter, engine applicability and options (218 rows, core baseline + option groups; customer-specific sets excluded). `npm run seed:library` loads it. Descriptions are never reproduced |
| Approve / publish lifecycle beyond `published` | The kit's publish already freezes the version | Draft → Published → Retired, nothing more |
| Cross-day program object | One template per sim day is the honest unit | `setup.program = { code, module, phase, day }` groups them |

---

## 3. Vocabulary

The kit ships the ICAO/IATA framework: nine competencies, 73 observable behaviours, verbatim. The
guide uses the same nine and differs in **exactly one code**:

**Decision: the code stays `PRO`.** The guide writes `APK` in that slot; we keep the ICAO spelling
so the framework stays the published one, unmodified, and the guide's `APK` is read as the same
competency. Nothing else differs.

| Kit | Guide | Competency |
|---|---|---|
| `KNO` | `KNO` | Application of Knowledge |
| **`PRO`** | *(`APK` in the guide)* | Application of Procedures and Compliance with Regulations |
| `COM` | `COM` | Communication |
| `FPA` | `FPA` | Flight Path Management, automation |
| `FPM` | `FPM` | Flight Path Management, manual control |
| `LTW` | `LTW` | Leadership and Teamwork |
| `PSD` | `PSD` | Problem Solving and Decision-Making |
| `SAW` | `SAW` | Situation Awareness and Management of Information |
| `WLM` | `WLM` | Workload Management |

No migration, no relabel, no fork: the framework ships as published. If their instructors ask, the
answer is that `PRO` is the ICAO code for the competency their guide abbreviates `APK`.

Other guide vocabulary adopted as-is: **CM1 / CM2** (not CP / FO, which stay the roster positions),
**PF / PM**, **TE** (training element), **MV** (manoeuvre validation), **REINF**, **SBT**, **EVAL**,
**LPC**, **MTV**, **UPRT**, **HPS**, **ISI**, **GAPPRI / GAPPRE**, **AWO**, **FICON**, **RWCC**.

---

## 4. Seed content — the guide, taken apart

The guide is one document holding a two-day module. The demo needs **separate templates**, because
that is the argument the product makes: a program is structured data, not a PDF.

**Decided: all four.** Three come out of the guide; the line check is invented against
`docs/04_ETR.md` and exists to exercise `one_record_per_sector` — one record per leg, not one per
day. It is the only seeded template whose content is ours rather than theirs, and it is labelled as
such on screen.

| # | Template | Kind | Sections |
|---|---|---|---|
| 1 | EBT M1 Phase II — Day 1 (A320) | `ebt_recurrent` | EVAL 1 · Transit · EVAL 2 · SBT 1 GAPPRI · SBT 2 / ISI · HPS · REINF |
| 2 | EBT M1 Phase II — Day 2 (A320) | `ebt_recurrent` | SBT 3 Cold WX · LPC / MV / AWO · MTV · UPRT · SBT 4 Fuel Leak · SBT 5 · REINF |
| 3 | OPC / LPC — A320 | `proficiency_check` | the LPC manoeuvre set, standalone |
| 4 | Line check — A320 | `line_check` | one record per sector |

Time budgets come straight from the guide's Main Menu (Day 1: 0:50 · 0:40 · 1:00 · break 0:15 ·
0:35 · 0:25 · 0:10 · 0:05; Day 2: 1:15 · 0:10 · 0:50 · 1:10 · 0:05 · 0:15) so the builder's ruler
has real numbers to show against a 4:00 period.

### 4.1 Substitution rules — no real operational data

The guide is a live operational document. **None of its identifying data is reproduced.** The
demo is built on the same *structure* with substituted values:

| Kind | In the guide | In the demo |
|---|---|---|
| Domestic airports | SKBO, SKPE, SKEJ, SKYP, SKRG, SKMR, AXM | **SKBO, SKCL, SKRG only** |
| International | KBOS | **KJFK only** |
| Flight numbers | real AV numbers | **AV 7001-7099**, a block outside live ranges |
| Aircraft registration | a real fleet tail | **N320AV** (A320), **N330AV** (A330), **N787AV** (B787) |
| Callsign | the live callsign | **AVA 7xx**, matching the flight block |
| Dates | 31 JAN 2027 | relative to the demo date |
| Runways, frequencies, speeds, weights | real | recomputed for the substituted airports |

The AV / AVA shape is kept so the screens read as native to them. Every seeded page carries the
`DEMO` environment chip from `brand.yaml`, and the numbers sit outside their live ranges, so a
printed page cannot be mistaken for an operational one.

Anything not on that list — phase structure, TEM framing, LOSA-driven design, competency focus,
instructor technique, the GAPPRI teaching points — is *method*, not operator data, and is what makes
the demo recognisable to them. That distinction is the whole point: **their process, none of their
numbers.** The neutrality scan (`npm run scan`) already blocks the other direction.

### 4.2 Slots and equivalency groups — in scope

**Decided: build them.** Instructor choice from an equivalency group is the thing that separates a
program builder from a form designer, and the guide relies on it in practice — the same EVAL slot
takes any of several engine malfunctions, and the crew must not meet the same one twice in a cycle.

What that means concretely, and where the cost is:

| Piece | Effort | Note |
|---|---|---|
| `equivalency_groups` + `group_candidates` (library side) | small | two tables, a picker, a create form |
| `content.conduct.slot` on a task | small | replaces the malfunction picker with a slot summary when set |
| `selection_policy` | small | `instructor_choice · rotation · random · manager_assigned` — an enum and four code paths |
| Constraints (no repeat within N modules, cycle coverage) | **large** | needs the delivery side and a history to read; the builder alone cannot evaluate it |

So the build splits at the honest line: **the group, the candidates, the policy and the slot render
in the builder and the instructor view in this slice.** The *constraint engine* — which reads a
pilot's history to say "this candidate was flown in module 2" — lands with the delivery module,
because there is nothing to read until sessions exist. The constraint fields are authored now and
shown as authored; the evaluation is a stated gap on the screen until the history is there.

That keeps 29 Sep intact. If the constraint engine has to be live for the demo, it moves ahead of
the seed (step 9) and the seed becomes two templates instead of four — say so and I will reorder.

### 4.3 The library

**Decided 2026-09-12: the starter library is neutral.** `data/library/standard-library.json` carries
the phases, exercises and events an EBT / LPC / OPC program is expected to contain under ICAO Doc
9995, PANS-TRG, EASA ORO.FC.231 and Part-FCL Appendix 9 - 5 block presets, 28 exercises, 14 events -
plus 7 equivalency groups over the A320 malfunction index. Nothing in it comes from any operator's
document; the earlier guide-derived seed was withdrawn and its rows retired (inactive, never
deleted) by `npm run seed:library`. Set-up values (airports, weather, positions, comms) are typed
by the author in the Set-up element, not picked from a list.

## 5. The screens

### 5.1 Programs — `/templates`

A table, not cards: code, name, kind, fleet, version, status chip, competencies targeted, last
edited, holder of the draft. Filters by kind and fleet. One primary button, **Create new program**,
which asks for the four things that freeze at creation — name, kind, fleet, framework + grading
scheme — and lands in the builder on an empty draft. Clicking any row opens the builder on its
current version; a published version opens read-only with **Clone to draft** as the only action.

### 5.2 Builder — `/templates/[id]`

Three panes, matching the reference layout in Avianca dress:

- **Left — Palette.** What can be added: Section · Exercise · Set-up · Malfunction · Event · Note ·
  Comms, dragged in or added with a button, plus a collapsed *Presets* group (the standard blocks
  and exercises). The content is chosen on the right, not here.
- **Centre — Program.** Drag to reorder and between sections, click a title to rename inline.
  Sections at the top level, notes anywhere, everything else inside a section. Phase colour as a
  3px left rule, never a fill. Every drop and rename is saved at once and the page re-renders from
  the database.
- **Right — Inspector.** One pane per element kind, saving on blur: Exercise (time, PF, snapshot,
  automation, **gradable and how**, aims, instructor notes), Section (level, phase, time,
  training-only, gradable), Set-up (airport, weather, position, comms, reset, ATC and performance
  as free-text lines with **+**; mass as ZFW / ZFWCG / fuel), Malfunction (aircraft type, search by
  ATA / system / name, option, **+**, run in sequence or **choose one at delivery** - the instructor's
  grid), Event (category, pre-created or typed, **+**), Note. The three panes are resizable.
- **Foot — Findings bar.** Green checks, amber warnings, red blockers, each with a jump link. See §6.

### 5.3 As instructor — `/templates/[id]/instructor`

**Built 2026-09-12.** The instructor projection of the real content, read-only, with runtime values
as placeholders: no pilot, no grades, clocks at zero. A rail on the left lists the sections and every
step inside them; the main pane shows one step with Previous / Next: an exercise (PF, time,
automation chips, inherited aims with their source, instructor notes, the grade controls exactly as
they will render, inert), a set-up (the lines), a malfunction or event (a sequence, or the
**choose-one grid**), a note. `lib/program/projection.ts` `instructorProjection(tree, { runtime: null })`
— the delivery screen calls the same function with a session.

### 5.4 Review — `/templates/[id]/review`

**Built 2026-09-12.** The record as both parties will sign it: `subjectProjection(tree)` — exercise
names, the failures assessed on (names only), competencies and grades, the outcome, both signature
blocks. Set-up, conduct, instructor notes and timers are structurally absent, and a test asserts it
over the serialised object. The signature statements come from `policy.yaml` (`signatures.statements`);
a licence check (`proficiency_check`) adds the line about partial pass or fail. The trainee may
**object to the results**: a dialog that closes only through its own buttons, a written reason,
signed; the rule (`signatures.objection`) marks the record *incomplete* and notifies the training
manager. In preview the buttons are inert; the objection, the incomplete state and the manager's
dashboard alert are wired with the delivery module, where a record exists to mark.

## 6. New idea — a findings bar with real rules

The reference builder shows a compliance bar and states that no engine is behind it. We can have a
small honest one, because the guide itself states its rules in plain words. Six checks, declared in
`config/rules.yaml`, read by one predicate:

| Check | Source | Severity |
|---|---|---|
| An EBT module carries all three phases (EVAL, MT, SBT) | IATA EBT / the guide's structure | blocker |
| Section times sum to the declared period | Main Menu, 4:00 per day | warning |
| REINF time is present and not zero | "under no circumstances should this time be cut" | blocker |
| Training-only sections are not graded | "SBT1 and HPS are TRAINING ONLY" | blocker |
| A task targets no more than N competencies | operator policy, default 3 | warning |
| Every graded task names its grading criteria | `aims.grading_criteria` empty | warning |

Each rendered finding carries `data-rule="<id>"` and the test asserts that the set rendered equals
the set in the registry — so a rule that stops firing, and a finding with no rule behind it, both
fail loudly. A rule that cannot yet be evaluated is **not rendered at all**; a warning that fires on
every action is a yellow line people learn to walk past.

## 6.1 Three smaller ideas, cheap and authentic

1. **Snapshot / Recall as first-class.** The guide takes or recalls a snapshot about a dozen times
   and has nowhere to record it. One enum on the task; it renders as a camera chip in both views.
2. **Device variants.** The guide carries a parallel 012FSTD variant in green throughout. Model it
   as `content.variants` with a device toggle in the builder and the instructor view. No other
   vendor's builder does this, and it is exactly the thing their training managers maintain by hand.
3. **Time ruler against the real period.** The data is already there; it makes "3:45 of 4:00" true
   rather than decorative.

---

## 7. Design

The reference screenshots are the Corvanox dark theme. This build is Avianca: white header,
`#DA291C` accent, `#1B1B1B` ink, Red Hat Display, 10px / 6px radii — all already in `brand.yaml`,
nothing hardcoded. The builder needs **one addition to `brand.yaml`: a phase palette** (brief,
evaluation, manoeuvres training, scenario-based training, debrief, reinforcement), used as a 3px
rule in the builder, the instructor view and later the report. Data-state colour stays as decided:
ember for monitor, `#A8321E` priority, `#2F7D32` at standard, as a rule and never a fill.

---

## 8. Build order

Each step ends green on `typecheck` + `verify:clean` + `smoke`, and is one commit.

1. Content shape + validator + `config/rules.yaml` (no screens) — the foundation everything reads.
2. Migration: library tags, phase palette in `brand.yaml`, the `APK` relabel.
3. `/templates` list + Create new program.
4. Builder canvas, read-only: sections, tasks, phase rules, time ruler.
5. Library rail + drag/place + **New malfunction** form.
6. Inspector: Set-up · Conduct · Assessment · Aims, save on blur.
7. Findings bar.
8. Equivalency groups, candidates, selection policy, and the slot on a task (§4.2).
9. Instructor projection + left task rail + device toggle.
10. Seed: the four templates and the library, from the guide, substituted per §4.1.
11. Publish / clone-to-draft, and the gate assertions.

Steps 1-4 are the demo's spine; 10 is what makes it look like theirs. Step 8 is the largest single
item and the one to watch against 29 Sep; its constraint engine is deliberately out (§4.2).

---

## 9. Decisions taken

2026-09-11, before any code:

1. **Four templates** — EBT M1 PII Day 1, Day 2, OPC / LPC, and a Line check. §4.
2. **`PRO` stays `PRO`** — the ICAO framework ships unmodified; the guide's `APK` is the same
   competency. §3.
3. **AV / AVA identifiers outside live ranges** — AV 7001-7099, AVA 7xx, N320AV / N330AV / N787AV,
   and the `DEMO` chip on every page. §4.1.
4. **Slots are in** — group, candidates, selection policy and the slot on a task. The constraint
   engine ships with the delivery module, and is a stated gap until then. §4.2.

### Still open

- Is the constraint engine (no repeat within N modules, cycle coverage) needed *on the day*? If yes,
  it moves ahead of the seed and the seed drops to two templates.
- The guide's SKBO runway designators are the old ones. The demo uses the published 13L/31R and
  13R/31L unless you want their spelling kept.
