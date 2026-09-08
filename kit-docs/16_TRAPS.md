# 16 · Traps

Purpose: the failure catalogue for the whole kit — every way this platform has been seen to break,
grouped by the mechanism that breaks it rather than by the module it breaks in.
Status: spec
Version: v1.0 · 2026-08-26

---

## How to use this file

Read the twelve class headings below **once, now**, before you write anything. That takes four
minutes and it is the whole point of the file: you are not expected to remember a hundred entries,
only to recognise which *kind* of thing is happening to you.

Then come back the first time something behaves strangely — and in this platform "strangely" almost
always means one of these five symptoms:

- a number is plausible but wrong, and no test fails;
- two screens disagree about the same person;
- a count is lower than it should be and nothing logged an error;
- something works for you and not for the person who reported it;
- a check has been green since the day it was written.

Each of those maps to a class. Go to the class, not to the module. The module doc will tell you how
the feature is meant to work; this file tells you how it fails, which is usually the faster route
back to a working system.

Every entry has the same four parts: **what happens** (the symptom as you would first meet it),
**why** (the mechanism), **do instead** (the rule), **where** (the doc that owns the detail).
Entries are numbered `class.entry` and are referred to by that number from the module docs.

**The one-sentence version of the whole file.** Almost every entry below is a case of the same three
diseases: an identity that something else is allowed to change, a fact with two homes, or a failure
that returns success. If you are in a hurry, distrust those three things and you will avoid most of
this catalogue without reading it.

---

## The twelve classes

| # | Class | The question it answers |
|---|---|---|
| 1 | Identity and vocabulary | what is this row, and who is allowed to change that answer |
| 2 | Two homes for one fact | which copy is right, and how would you know |
| 3 | Silent truncation and silent drop | where did the missing rows go, and why was there no error |
| 4 | Checks that cannot fail | what is this test actually asserting |
| 5 | Gates that reject correct output | why is the safety mechanism the thing that is broken |
| 6 | Averaging away what matters | what did the arithmetic hide |
| 7 | Ordering | what had to exist before this ran |
| 8 | State that contradicts itself | which column is lying |
| 9 | Lifecycle and locking | when did this become unchangeable, and did it |
| 10 | Access and disclosure | who can see this, and how do you know they can't |
| 11 | Operational | what is actually running, and can you get it back |
| 12 | Rendering and the second reader | does it survive the printout, the projector and the colour-blind reader |

The last class is the one people discover after shipping. It is here because a report that is wrong
on paper is wrong, however correct the SQL behind it was.

---

## Index — where each doc's Traps section lands here

Every doc ends with its own Traps section, written in that module's vocabulary. This table maps each
of them onto the classes below, so that a mechanism described in three modules is written once.

| Doc | Its traps live in classes | Entries it owns outright |
|---|---|---|
| `00_REPLICATION_RUNBOOK.md` | 4, 7, 11 | 7.1, 11.12 |
| `01_ARCHITECTURE.md` | 2, 3, 7, 11 | 3.12, 7.4 |
| `02_DATA_MODEL.md` | 1, 2, 6, 7, 9 | 1.8, 1.10, 7.7, 7.8, 9.13 |
| `03_COMPETENCY_FRAMEWORK.md` | 1, 6, 7 | 6.11 |
| `04_ETR.md` | 1, 2, 3, 6, 9 | 3.11, 7.10, 9.11 |
| `05_TEMPLATES_AND_BUILDER.md` | 1, 2, 3, 7, 9, 12 | 1.3, 12.19 |
| `06_ANALYTICS.md` | 2, 4, 5, 6, 12 | most of class 6, 5.8 |
| `07_VISUALISATION.md` | 12 | most of class 12 |
| `08_QMS.md` | 1, 4, 8, 9 | 4.1, 4.2, 9.4, 9.7, 9.8 |
| `09_DMS.md` | 3, 8, 9, 10, 11 | 8.1, 9.14, 10.13, 11.17 |
| `10_INTEGRATION.md` | 1, 2, 3, 5, 9, 10 | 3.1, 3.2, 5.7, 9.10, 10.12 |
| `11_AI_PIPELINE.md` | 1, 2, 3, 5, 8, 11 | 5.1, 5.2, 5.4, 8.6 |
| `12_ROLES_AND_PERMISSIONS.md` | 4, 10 | most of class 10 |
| `13_DESIGN_SYSTEM.md` | 1, 2, 10, 12 | 12.2, 12.3, 12.17 |
| `14_SEED_AND_SYNTHETIC_DATA.md` | 1, 2, 4, 7, 11 | 1.12, 4.3, 4.5, 4.11, 4.12, 4.13, 4.14, 4.15, 11.18 |
| `15_DEPLOYMENT.md` | 3, 4, 7, 11 | most of class 11 |
| `17_GOVERNANCE.md` | 3, 8, 9, 10 | 9.2, 9.3, 10.10, 10.11, 10.14 |

---

## 1. Identity and vocabulary

*Keying on something an editor is allowed to change. The corruption is always silent, because a
broken join returns fewer rows rather than an error.*

**1.1 A name is not a key.**
*What happens:* a join, a chart axis, a config file or a prompt guard that matches a competency by
name de-aligns the first time the wording changes — "and" for "&", a singular for a plural — and
simply returns fewer rows. *Why:* a name is a display string, editable without a migration. *Do
instead:* join on `competency_id` and `observable_behaviour_id`; resolve names at render time.
*Where:* `docs/02_DATA_MODEL.md` §7, `docs/03_COMPETENCY_FRAMEWORK.md` §8,
`docs/13_DESIGN_SYSTEM.md` §11.

**1.2 A row surrogate id is not a key either, when an editor can rewrite the row.**
*What happens:* grades disappear from a record the moment an author opens the template and saves
it. *Why:* the answers pointed at `template_elements.id`, and a save re-minted the rows. *Do
instead:* answers reference `template_elements.element_key` — stable, author-assigned, unique
within a template version. The absence of a foreign key from `element_grades.element_key` is
deliberate and must not be "fixed" later. *Where:* `docs/02_DATA_MODEL.md` §7,
`docs/05_TEMPLATES_AND_BUILDER.md` §5.

**1.3 A save that re-mints element identity.**
*What happens:* a template authored outside the builder — a seed, an import — is silently wiped
the first time someone opens and saves it in the builder. *Why:* the save was implemented as
delete-then-reinsert rather than as a diff. *Do instead:* diff on `element_key`; insert, update
and tombstone, never truncate. *Where:* `docs/05_TEMPLATES_AND_BUILDER.md` §9.

**1.4 A label that carries a number the syllabus owner controls.**
*What happens:* one real element appears in analytics as three or four low-volume fragments, and
every ranking of "most-failed items" is wrong. *Why:* element titles embed syllabus item numbers,
and syllabus numbers get renumbered between template versions. *Do instead:* group on
`element_key`. Where a legacy normalisation is unavoidable, prove zero collisions within any
single record before applying it. *Where:* `docs/06_ANALYTICS.md` §18, `docs/04_ETR.md` §9.

**1.5 Matching people by name.**
*What happens:* two people with the same name merge into one subject, or one person with a changed
name splits into two, and grades land on the wrong record. *Why:* the external id was absent on
some rows and name matching was the fallback. *Do instead:* match on `external_refs` and the
external id; unmatched rows are held and reported, never guessed. Normalise homoglyphs and
collapse double spaces on import, or one code silently becomes two. *Where:*
`docs/10_INTEGRATION.md` §4.

**1.6 Keying results to array position.**
*What happens:* an author drags one condition up a place, and every stored evaluation, evidence
link and diff now points at a different rule. *Why:* JSONB arrays have order, and order is
presentation. *Do instead:* `condition_key` and `group_key`, referenced everywhere; position
renders, it does not identify. *Where:* `docs/08_QMS.md` §9.

**1.7 Hardcoding the competency count.**
*What happens:* a framework edition adds a tenth competency and a chart silently drops it — a
fixed three-by-three grid, a nine-row strip, a nine-column heatmap, a nine-spoke radar, an array
of nine labels, a nine-branch switch. *Why:* nine felt permanent. *Do instead:* every count
derives from the framework row count; the grid wraps; the radar computes spoke angles from
`data.length`. *Where:* `docs/07_VISUALISATION.md` §9, `docs/13_DESIGN_SYSTEM.md` §11,
`docs/03_COMPETENCY_FRAMEWORK.md` §7.

**1.8 An enum for a vocabulary the operator edits.**
*What happens:* adding a value requires a migration committed before any insert can use it, and
retiring one is impossible. *Why:* a constrained vocabulary was modelled as a database enum. *Do
instead:* a `CHECK` on `TEXT` for a fixed vocabulary, a catalogue table for an editable one.
*Where:* `docs/02_DATA_MODEL.md` §6.

**1.9 A vocabulary list copied into a prompt, a parser or a config file.**
*What happens:* an old spelling reappears with no error — often when an older automation export is
restored — and matching quietly stops working. *Why:* three copies of one list drift, and only the
database one is maintained. *Do instead:* load every list from the database at call time, reject
unknown codes, and have seeds reference codes and resolve to ids. *Where:*
`docs/11_AI_PIPELINE.md` §12, `docs/05_TEMPLATES_AND_BUILDER.md` §9,
`docs/14_SEED_AND_SYNTHETIC_DATA.md` §10.

**1.10 A table name that is safe here and only here.**
*What happens:* every request against `users` fails with a schema-cache error after a swap to a
REST-over-Postgres data layer. *Why:* that layer owns an internal `auth.users` and the names
collide. *Do instead:* if that variant is ever adopted, rename the table **before** the swap, not
after. Reaching PostgreSQL directly, the name is fine. *Where:* `docs/02_DATA_MODEL.md` §7.

**1.11 A mapping written as code because it started as three conditionals.**
*What happens:* a new session type stops mapping to its qualification, and nothing raises, because
the keyword list lives in a deployed module. *Why:* it was three `if`s when it was written. *Do
instead:* matchers are parameters in the definition; adding one is an INSERT, not a release.
*Where:* `docs/08_QMS.md` §9.

**1.12 A comparison against a vocabulary the schema no longer has.**
*What happens:* a whole branch stops running and nothing raises — supervised-line records finalise
and write zero `line_sectors` rows, and multi-subject sessions stop occurring. *Why:* the code
compared `template_kind` against the coarse family names of a mapping that a later migration
deleted, so the comparison is simply never true; a wrong string is a silent `false`, never an
error. *Do instead:* branch on the POLICY PROPERTY of the kind — `one_record_per_sector`,
`fan_out_on_signature`, `facility_kind` — never on a family name, and delete the family vocabulary
from every reader in the same change that deletes it from the schema. *Where:*
`docs/04_ETR.md` §4, `docs/14_SEED_AND_SYNTHETIC_DATA.md` §10, `config/policy.yaml` §1.

---

## 2. Two homes for one fact

*The same quantity computed in two places, or stored in two places, will diverge. The question is
never whether — only which surface someone will read first.*

**2.1 Reading one source home reports zeros for the other.**
*What happens:* a dashboard shows zero for a population the roster clearly contains. *Why:* in-app
and imported records share one table with different `source` values, and the view filtered to one
of them because "that is where the real grades are". *Do instead:* every "all data" aggregate
reads all sources and groups rather than filters; the synthetic population carries both homes, or
it cannot reproduce this. *Where:* `docs/02_DATA_MODEL.md` §7, `docs/06_ANALYTICS.md` §18,
`docs/04_ETR.md` §1.

**2.2 Two derivations of one concept will disagree.**
*What happens:* the list page and the dashboard show a different concern level for the same
person, and it is not obvious which is wrong. *Why:* the concept was derived once in SQL and again
in a route handler or a chart component. *Do instead:* one function, one endpoint, every surface
reads it. Concern is derived in a single SQL function with the person-level override winning.
*Where:* `docs/06_ANALYTICS.md` §18, `docs/02_DATA_MODEL.md` §7.

**2.3 A tile or a drill-down that recomputes its own totals.**
*What happens:* the number in the tile and the number in the chart beneath it differ by a little,
which is worse than differing by a lot because nobody notices for a month. *Why:* the tile ran its
own query. *Do instead:* tiles read the row the chart drew; a drill-down reads the same view its
chart reads and holds exactly the same capability, no wider. *Where:* `docs/07_VISUALISATION.md`
§9, `docs/06_ANALYTICS.md` §18.

**2.4 Two validators for one definition.**
*What happens:* the seeder or the importer writes a template the builder cannot open. *Why:* the
builder's validation and the seeder's validation were written twice and drifted. *Do instead:* one
module, imported by both. The drift always shows up as data the UI refuses to load. *Where:*
`docs/05_TEMPLATES_AND_BUILDER.md` §9, `docs/14_SEED_AND_SYNTHETIC_DATA.md` §10.

**2.5 Two renderers for one report.**
*What happens:* the on-screen preview and the PDF diverge, and the divergence is discovered by
whoever is holding the printout. *Why:* preview and export were implemented separately because the
export needed "just one small change". *Do instead:* one template module produces the HTML string
for both; the PDF path is that string given to the renderer. *Where:* `docs/01_ARCHITECTURE.md`
§3, and class 12 below for what else breaks in print.

**2.6 A config that re-reads per request.**
*What happens:* two figures in one report disagree because a threshold changed between two queries
of the same page load. *Why:* the config module was made to re-read so that edits would apply
without a restart. *Do instead:* cache config per process, deliberately, and make a threshold
change a restart or an explicit reload with a version bump recorded in `config_versions`. *Where:*
`docs/13_DESIGN_SYSTEM.md` §10.

**2.7 A model restating a figure.**
*What happens:* a report sentence carries a number close to the computed one but not equal to it,
and the reader believes the sentence. *Why:* a model emits a token sequence that resembles a
number; one that restates an average will eventually restate it wrong. *Do instead:* the
deterministic core computes every figure, and narration is validated against that figure set
before it is stored. *Where:* `docs/11_AI_PIPELINE.md` §12, `docs/06_ANALYTICS.md` §18; 5.1 for
the gate.

**2.8 Webhooks treated as the system of record.**
*What happens:* a consumer misses a delivery during an outage and its copy stays permanently
wrong, with nothing to reconcile against. *Why:* the notification path was the only path. *Do
instead:* webhooks notify; the outward API with an `updated_since` filter is the source of truth,
and the consumer documentation says so. *Where:* `docs/10_INTEGRATION.md` §4.

---

## 3. Silent truncation and silent drop

*Rows go missing and the process reports success. This is the class that costs the most days,
because there is nothing to search the logs for.*

**3.1 Assuming a list endpoint returns everything.**
*What happens:* a roster read returns the first page, existing people look new, and the loader
either dies on duplicate keys or — worse — creates duplicates. *Why:* a server-side row cap that
ignores the requested limit and reports no error. *Do instead:* every bulk read paginates by key,
and the loader asserts that the count it processed equals the count the run claims. *Where:*
`docs/10_INTEGRATION.md` §2, §4.

**3.2 Offset pagination without a total ordering.**
*What happens:* rows come back twice, a duplicate report inflates by an order of magnitude, and
somebody spends a week hunting a data-quality problem that does not exist. *Why:* without an
`ORDER BY` on a unique key the server may reorder between pages. *Do instead:* keyset pagination
(`id > last`, ordered), never offset. *Where:* `docs/10_INTEGRATION.md` §4.

**3.3 Unmatched import rows dropped silently.**
*What happens:* an import reports success having loaded two thirds of the file, and the gap is
found months later by someone looking for a record that was definitely submitted. *Why:* the
mapping matched most elements and the loader skipped the rest. *Do instead:* verify the mapping
**before** the load, not after; hold and report unmatched rows; reconcile counts against the
source before sign-off. *Where:* `docs/05_TEMPLATES_AND_BUILDER.md` §9, `docs/04_ETR.md` §8.

**3.4 Unrouted documents failing quietly.**
*What happens:* the estate develops a shadow inbox — an unmapped document type is dropped or filed
flat, with no warning. *Why:* a routing table with no default branch, or a default branch that
logs at debug level. *Do instead:* unrouted lands in `inbox/`, raises a warning-level event, and
appears as a count on the records dashboard. *Where:* `docs/09_DMS.md` §9.

**3.5 A required key absorbed by `|| []`.**
*What happens:* an extraction returns "no results" and everything downstream treats that as a
valid empty document. *Why:* the default absorbs a truncated response, a renamed field, a provider
change and a schema drift, all as emptiness. *Do instead:* validate required keys explicitly and
fail. *Where:* `docs/11_AI_PIPELINE.md` §12.

**3.6 A parse failure swallowed into a fallback object.**
*What happens:* the document silently becomes a non-record, or the report silently loses a layer.
*Why:* the `catch` block returned a shape that satisfied the type. *Do instead:* fail loud, store
the raw response, leave the row absent — an absent row can be found; a plausible empty one cannot.
*Where:* `docs/11_AI_PIPELINE.md` §8, §12.

**3.7 A naive unnest that drops the rows it cannot parse.**
*What happens:* below-standard counts come out lower than the source, by a few rows nobody can
locate. *Why:* expanding an attempt list drops rows whose recorded grade is set but whose attempt
list holds an unparseable value. *Do instead:* rows with no parseable attempt list keep their
recorded grade rather than being dropped. *Where:* `docs/02_DATA_MODEL.md` §7, `docs/04_ETR.md`
§9.

**3.8 A migration runner that swallows `RAISE NOTICE`.**
*What happens:* a migration reports "applied" and says nothing about the half of itself it
skipped. *Why:* the client never subscribed to notice events. *Do instead:* the runner listens for
`notice` and prints every one. *Where:* `docs/15_DEPLOYMENT.md` §11, `_KIT_CONTRACT.md` §4.

**3.9 A second call in a two-call operation that 401s alone.**
*What happens:* ingestion appears to succeed, the file is moved, and the metadata write silently
fails. Files accumulate with null paths and it surfaces weeks later as a retrieval failure. *Why:*
automation authenticates differently from a browser, and the internal-token header is easy to omit
on one call out of five. *Do instead:* the move and the metadata write are one server-side
operation returning an explicit persisted/failed result, recorded in the run log. *Where:*
`docs/09_DMS.md` §9.

**3.10 An audit write made non-blocking.**
*What happens:* the action succeeds, the audit write fails to a console line nobody reads, and the
record and its trail diverge permanently and silently. *Why:* the audit call was made best-effort
so it could never break a request. *Do instead:* write the audit row in the same transaction,
through a trigger or function, and let its failure fail the action. *Where:*
`docs/17_GOVERNANCE.md` §8.

**3.11 A lookup by bare id against a compound name.**
*What happens:* a cleanup or retention job silently never runs, and nobody notices because
"nothing to do" and "found nothing" look identical. *Why:* subject folders are named
`{id}_{Last}_{First}` and the scan looked for `{id}`. *Do instead:* scan for the `{id}_` prefix,
and make a job that matched zero targets say so. *Where:* `docs/04_ETR.md` §9.

**3.12 A generated REST layer between the application and the database.**
*What happens:* four failures arrive together — a URL-length limit on id lists, a silent row cap,
a schema cache that must be remembered and reloaded, and a statement timeout that cannot be raised
from inside a function. *Why:* the transport constrains the query. *Do instead:* reach PostgreSQL
directly with `pg` from server code. The REST variant is documented, not scaffolded; if it is
adopted, budget for all four and see 1.10. *Where:* `docs/01_ARCHITECTURE.md` §3,
`docs/15_DEPLOYMENT.md`.

**3.13 A cursor stored inside the container.**
*What happens:* a redeploy makes a feed re-fetch its entire backlog, or skip a window entirely.
*Why:* the checkpoint was a file written next to the script. *Do instead:* the cursor is a column
in `sync_runs`, advanced only after a successful load. *Where:* `docs/10_INTEGRATION.md` §4.

**3.14 A migration shipped without its grants.**
*What happens:* the application role cannot read tables that plainly exist, and the failure looks
like a caching bug for a day. *Why:* grants were assumed to be inherited. *Do instead:* every
migration ships its own `GRANT` statements. *Where:* `docs/02_DATA_MODEL.md` §6.

---

## 4. Checks that cannot fail

*A green test is evidence of nothing until you have seen it go red. Every entry here is a check that
was passing for a reason unrelated to correctness.*

**4.1 An empty requirement set evaluates as met.**
*What happens:* a half-authored qualification type marks every applicable subject as satisfied,
and the approval queue fills with grants for a rule nobody finished writing. *Why:* `[].every(fn)`
is `true`, in the group loop and in the condition loop alike. *Do instead:* an explicit guard at
the top of the evaluator returning `no_requirements_defined`, a publish invariant forbidding it,
and a test that asserts both. *Where:* `docs/08_QMS.md` §9.

**4.2 A stubbed condition that evaluates as met.**
*What happens:* a rule depending on a feed that does not exist yet marks everyone compliant, and
grants are approved against nothing. *Why:* a missing evidence bucket reads as an empty array, and
"no disqualifying evidence" was treated as a pass. *Do instead:* registry entries declare `status:
'stubbed'`, their evaluators return `evaluable: false`, and both the engine and the plain-language
renderer say so out loud. *Where:* `docs/08_QMS.md` §9.

**4.3 A check asserted over a population that never occurs.**
*What happens:* an assertion has been green since it was written, because no row has ever reached
it. *Why:* coverage was assumed from the profiles that were requested, not measured from the rows
that were produced. *Do instead:* compute coverage from the generated rows and print it; an
assertion that cannot fail is not an assertion. *Where:* `docs/14_SEED_AND_SYNTHETIC_DATA.md` §10.

**4.4 A rate assertion cannot catch a join fan-out.**
*What happens:* a duplicate row inflates numerator and denominator equally, so the percentage
stays plausible while every count behind it is doubled. *Why:* rates are invariant to the defect.
*Do instead:* assert on a **structural** quantity — the period count on every row must equal the
configured count, and row counts must match a pre-taken baseline. *Where:* `docs/06_ANALYTICS.md`
§18.

**4.5 A seed shaped unlike what the application writes.**
*What happens:* the suite is green against a database the application would never create, and the
first real record breaks it. *Why:* the seed took a shortcut — one row per element instead of one
per attempt, a keyed map in a snapshot instead of an array of objects. *Do instead:* same tables,
same columns, same key shapes, same attempt semantics, same snapshot structure, byte for byte in
shape. *Where:* `docs/14_SEED_AND_SYNTHETIC_DATA.md` §10.

**4.6 A demonstration population that reaches only the healthy half.**
*What happens:* a band, an alert state or an empty state ships broken because it has never once
been rendered. *Why:* the critical grade, the suppressed period, the subject with no records, the
below-minimum assessor and the too-small cohort side do not occur by accident. *Do instead:* place
each of them deliberately and print a coverage table. A band that has never occurred has never
been seen to work. *Where:* `docs/14_SEED_AND_SYNTHETIC_DATA.md` §10,
`docs/00_REPLICATION_RUNBOOK.md` phase 2.

**4.7 An excursion placed inside its own base window.**
*What happens:* the alert built to demonstrate the excursion does not fire. *Why:* the base
estimates its own standard deviation, so an excursion inside it widens the limits until they
contain it. *Do instead:* every demonstration excursion sits after the end of the base window.
*Where:* `docs/14_SEED_AND_SYNTHETIC_DATA.md` §10.

**4.8 A base estimated from too small a sample.**
*What happens:* an indicator either alerts permanently or never alerts at all. *Why:* at low rates
a short sample yields a zero base or an inflated one; both are degenerate. *Do instead:* size the
sample so the expected count in it is well into double digits, and keep it configurable. *Where:*
`docs/06_ANALYTICS.md` §18.

**4.9 A permanently red baseline that both sides learn to read past.**
*What happens:* a check is failing, everyone knows why, and six months later a real failure hides
inside the noise. *Why:* an escape hatch was added for data that predates the check, or the red
was accepted as historical. *Do instead:* never waive a check for legacy data — fix forward, or
narrow the check to a population where it can pass honestly. *Where:* `docs/15_DEPLOYMENT.md` §11,
`docs/00_REPLICATION_RUNBOOK.md` phase 5.

**4.10 Testing scoped access as an administrator.**
*What happens:* a scoped bug reaches production behind a confident "works for me". *Why:* an
administrator's session bleeds through every convenience path. *Do instead:* test in a clean
private window as the target user, with only that user's roles. *Where:*
`docs/12_ROLES_AND_PERMISSIONS.md` §8.

**4.11 An evaluation that improves as the thing it measures gets worse.**
*What happens:* a change to a long single-call analysis scores better on a naive metric while
covering fewer distinct sources. *Why:* positional decay collapses distinct-source coverage while
citation density rises, and the metric only saw density. *Do instead:* measure distinct sources
explicitly, and use map-reduce over the corpus. *Where:* `docs/11_AI_PIPELINE.md` §5, §12.

**4.12 A hole in the base window is not neutral.**
*What happens:* a structural assertion fails on rows that are otherwise correct — observed base
periods disagree with the configured count. *Why:* a base period below the suppression minimum is
suppressed and drops out of the window. *Do instead:* spread events evenly across the window
rather than sampling randomly, and treat the disagreement as a defect rather than noise. *Where:*
`docs/14_SEED_AND_SYNTHETIC_DATA.md` §10.

**4.13 A per-item random roll reaches everyone.**
*What happens:* a demonstration population in which almost every subject has a repeat — a
population no operator would recognise, so nobody trusts anything computed from it. *Why:*
eligibility was rolled once per element, and over a long window a per-element roll converges on
everybody. *Do instead:* decide it once per subject. *Where:* `docs/14_SEED_AND_SYNTHETIC_DATA.md`
§10.

**4.14 A deliberate excursion that lands wherever the roster fell.**
*What happens:* a band-coverage assertion fails one period short, passes again on the next seed,
and no change explains either. *Why:* assessors were drawn independently per event, which gives
each the right SHARE and the wrong DISTRIBUTION — at these denominators one assessor regularly
owns a whole period, and an assessor bias of a grade either way moves that period's rate further
than any deliberate difficulty offset. *Do instead:* deal the roster as a rotation across the
window instead of drawing it per event, and give every excursion a margin rather than relying on
the period sitting exactly at the base rate. *Where:* `docs/14_SEED_AND_SYNTHETIC_DATA.md` §10.

**4.15 A band asserted at one period grain, driven by a calendar written at another.**
*What happens:* a quarterly indicator never reaches its consecutive-period band while the monthly
one reaches all of its bands from the same data. *Why:* the difficulty calendar was monthly, and
three months of alternating offsets average out inside one quarter; the quarter then lands
wherever counting noise puts it, and its denominator was never controlled at all. *Do instead:*
one calendar per period grain, laid out in whole periods after the base, carrying the volume as
well as the offset — a suppression band is a statement about n, and n left to chance is a band
left to chance. *Where:* `docs/14_SEED_AND_SYNTHETIC_DATA.md` §10, `docs/06_ANALYTICS.md` §5.

---

## 5. Gates that reject correct output

*A safety mechanism that fires on good input is worse than no mechanism, because the response is
always to weaken it — and it is then weak for the bad input too.*

**5.1 A provenance gate that walks only top-level keys.**
*What happens:* a correct, fully-sourced narrative is rejected because the figure it cites is a
per-competency average nested two levels down. Operators lower the threshold, and the gate stops
protecting anything. *Why:* the gate collected scalars from `Object.values(figures)` and never
descended. *Do instead:* flatten recursively to any depth, include formatting variants of every
number, and match with a small epsilon rather than by string equality. *Where:*
`docs/11_AI_PIPELINE.md` §9.1.

**5.2 The same gate made too permissive.**
*What happens:* a fabricated count passes because the digits appear inside a date somewhere in the
figure set. *Why:* substring matching. *Do instead:* extract numbers with word boundaries and
exclude already-matched date spans before matching. *Where:* `docs/11_AI_PIPELINE.md` §9.1.

**5.3 A failed gate that publishes anyway.**
*What happens:* figures are published with the narrative quietly dropped, and the run looks
successful. *Why:* failing softly felt safer than failing the run. *Do instead:* the run fails
with an explicit failure reason and stores the offending numbers so the prompt or the figure set
can be fixed. A near-miss publish policy is configurable and off by default. *Where:*
`docs/11_AI_PIPELINE.md` §9.2.

**5.4 Treating legitimate non-record traffic as an error.**
*What happens:* the error rate on ingestion is enormous and the real errors are invisible inside
it. *Why:* most of an inbox is not a record, and "not a record" was mapped to failure. *Do
instead:* store it as notes and complete the run. *Where:* `docs/11_AI_PIPELINE.md` §12.

**5.5 Treating a correct lock as a failure.**
*What happens:* a client retries forever against a record that is correctly locked, and the
assessor believes their work has been lost. *Why:* a 409 was mapped to the generic error handler.
*Do instead:* on the client's own submission id, a 409 is the transition to local read-only,
displayed as "signed on the server". *Where:* `docs/10_INTEGRATION.md` §4.

**5.6 A missing header reported as an authentication failure.**
*What happens:* days are spent on credentials that were correct all along. *Why:* the counterparty
assumed browser-supplied headers and surfaced their absence as a 401. *Do instead:* send origin,
referer and user-agent on every connector call, and record in the connector notes which of them
the counterparty actually requires. *Where:* `docs/10_INTEGRATION.md` §4.

**5.7 Uncorrected multiple comparisons.**
*What happens:* a competency is flagged as significantly different when nothing is happening, and
it happens most times the report is run. *Why:* one hypothesis per competency at alpha 0.05 across
a framework of nine produces a false positive more often than not. *Do instead:*
Bonferroni-correct by the active competency count, read from the framework table rather than
assumed. *Where:* `docs/06_ANALYTICS.md` §18.

**5.8 A guard the planner evaluates after the thing it guards.**
*What happens:* the one function that defines a valid grade raises `invalid input syntax for type
integer` on a literal — `grade_num('NR')` — while the identical value read from a column returns
`NULL` correctly. Every view is right and every hand-check is wrong, so the defect hides in exactly
the place a person looks to check it. *Why:* a `LANGUAGE sql` function whose body is one `SELECT`
is inlined into the calling query, and the planner then constant-folds any sub-expression whose
inputs are all constant — including the cast inside the `CASE` arm the `CASE` exists to protect,
at plan time, before its own condition runs. *Do instead:* put the cast on the `CASE`, not in an
arm, so its input is an expression containing a `STABLE` call and cannot be folded; assert both the
literal and the column path in the deploy gate, because the safe formulation looks like something
worth simplifying. `plpgsql` also fixes it and costs the inlining — measure before choosing it.
*Where:* `docs/06_ANALYTICS.md` §2.2, migration `0140_grade_num_literal_safe.sql`.

---

## 6. Averaging away what matters

*Compensatory arithmetic over a non-compensatory reality. Every entry here produces a number that is
defensible in isolation and wrong for the decision it is used in.*

**6.1 A critical grade averages away.**
*What happens:* a subject with one critical failure and a run of good grades reads as
unremarkable. *Why:* any index that converts grades to points and takes a mean lets later grades
cancel a failure that is not cancellable. *Do instead:* remove critical grades from the arithmetic
entirely and handle them as a flag with an explicit recovery run — where a grade one step above
critical breaks the run and restarts the counter. *Where:* `docs/06_ANALYTICS.md` §18, §11.

**6.2 The last attempt is not the history.**
*What happens:* an element graded below standard and then repaired reads as having met the
standard first time; below-standard counts come out at roughly half their true value. *Why:* the
aggregate read one row per task per record. *Do instead:* expand `attempt`; every attempt is its
own grade event. Then flag the change as a break in series — means shift down, counts rise, and
figures either side are not comparable. *Where:* `docs/06_ANALYTICS.md` §18,
`docs/02_DATA_MODEL.md` §7.

**6.3 An unavailable term acting as free credit.**
*What happens:* the assessor who generated the least evidence scores highest. *Why:* a composite
that deducts from a fixed base rewards the absence of the evidence a term needs. *Do instead:*
rescale over available points and render unavailable terms as `n/a`. *Where:*
`docs/06_ANALYTICS.md` §18.

**6.4 A one-sided spread term.**
*What happens:* an assessor who gives every subject the same grade scores as exemplary. *Why:*
only excess spread was penalised. *Do instead:* penalise both tails, against a configured spread
floor as well as a minimum. *Where:* `docs/06_ANALYTICS.md` §18.

**6.5 A raw not-observed rate penalises a roster, not an assessor.**
*What happens:* assessors who are given a particular session type look systematically worse.
*Why:* some session types are entirely not-required by design, and "not observed" is structural
there, not behavioural. *Do instead:* measure excess over an expected rate per (template code,
asset class). *Where:* `docs/06_ANALYTICS.md` §18, `docs/04_ETR.md` §9.

**6.6 Comparing an assessor to a mean they are inside.**
*What happens:* every deviation shrinks toward zero and the outlier the report exists to find is
the one it hides. *Why:* the benchmark included the assessor being measured, and a fleet mean
measures their roster, not their grading. *Do instead:* compare against what the same subjects
scored with other assessors, exclude the assessor from their own cohort, shrink by `n / (n + k)`,
and mark low-volume assessors provisional. *Where:* `docs/06_ANALYTICS.md` §18,
`docs/12_ROLES_AND_PERMISSIONS.md` §7.

**6.7 A suppressed period continuing a run.**
*What happens:* absence of evidence is presented as evidence — a clean streak that is really a gap
in reporting. *Why:* the run counter skipped over suppressed periods. *Do instead:* a suppressed
period breaks the run. *Where:* `docs/06_ANALYTICS.md` §18.

**6.8 A base that recomputes itself.**
*What happens:* a genuine improvement is invisible, because the yardstick moved with the thing it
measures. *Why:* the baseline window rolled automatically. *Do instead:* freeze the base; rebasing
is a config edit recorded in `config_versions` and announced on the chart. *Where:*
`docs/06_ANALYTICS.md` §18.

**6.9 A distinct count summed across periods.**
*What happens:* a yearly figure is larger than the truth because a subject active in four months
was counted four times. *Why:* distinct counts are not additive. *Do instead:* a period-grained
view of its own for each grain that is displayed. *Where:* `docs/06_ANALYTICS.md` §18.

**6.10 Bucketing by a person's current attributes.**
*What happens:* a reassigned subject's old grades follow them to their new org unit or asset
class, and both units' history is now wrong. *Why:* the aggregate joined to the person rather than
to the event. *Do instead:* bucket by the record's dimensions at session time, falling back to the
template's, and only then to the person's current values. The frozen columns on `sessions` and
`records` exist for exactly this. *Where:* `docs/06_ANALYTICS.md` §18, `docs/02_DATA_MODEL.md` §7.

**6.11 A framework change treated as a rename.**
*What happens:* every trend line in the platform is corrupted, and there is no way back. *Why:*
moving between competency frameworks splits some dimensions and merges others; historical grades
cannot be redistributed retroactively. *Do instead:* version the framework, leave old grades
read-only under their own `framework_id`, and start new baselines at the cut-over. *Where:*
`docs/03_COMPETENCY_FRAMEWORK.md` §8, `docs/02_DATA_MODEL.md` §7.

**6.12 Choosing a duplicate survivor silently.**
*What happens:* the grade distribution shifts and nobody can say by how much. *Why:* imports
produced duplicate `(record, element, attempt)` rows, some with conflicting grades, and a dedupe
was applied because the duplicates were obviously wrong. There is no obviously correct survivor.
*Do instead:* report the duplicate count as a data-quality metric and refuse to dedupe until a
rule is chosen and written down. *Where:* `docs/06_ANALYTICS.md` §18.

---

## 7. Ordering

*Everything here works when run in the right order and fails quietly in the wrong one. None of these
produce an error; they produce defaults.*

**7.1 Config after its readers.**
*What happens:* every number in the system is wrong in a way no test notices. *Why:* a seeder that
runs before thresholds are loaded does not fail — it quietly uses a default. *Do instead:* config
first, then framework, then templates, then data; and no default anywhere in a seed script — the
temptation to write `?? 30` beside a minimum sample is the whole trap in one line. *Where:*
`docs/00_REPLICATION_RUNBOOK.md` phase 2, `docs/14_SEED_AND_SYNTHETIC_DATA.md` §10.

**7.2 References before the framework they reference.**
*What happens:* orphaned competency references that the schema happily accepts. *Why:* the
framework seed had not run. *Do instead:* seed the framework before anything that grades against a
competency, and assert the expected behaviour count on completion. *Where:*
`docs/00_REPLICATION_RUNBOOK.md` phase 2.

**7.3 Records before their template.**
*What happens:* an import lands grades against elements that do not exist yet, or against the
wrong version of them. *Why:* the records were the interesting part. *Do instead:* template
published first, mapping verified, then load, then reconcile counts against the source before
sign-off, into a scratch environment first. *Where:* `docs/04_ETR.md` §8,
`docs/00_REPLICATION_RUNBOOK.md` phase 6.

**7.4 Guessing the release direction.**
*What happens:* a deploy that reads a column the schema does not have yet, or a view that changes
under an image expecting the old shape. *Why:* the order was habitual rather than decided. *Do
instead:* decide per release — if the migration changes what a view returns and the new image
depends on it, migrate first; if the new image reads something the old schema lacks, deploy after.
Ask which direction is harmless and take that one. *Where:* `docs/01_ARCHITECTURE.md` §5.

**7.5 Deploying without applying the migration.**
*What happens:* a clean deploy that reads empty, and looks exactly like a code bug. *Why:* the two
steps are separate and the second is easy to skip. *Do instead:* check the migration head in the
health endpoint before believing anything else. *Where:* `docs/15_DEPLOYMENT.md` §11.

**7.6 A prompt updated without its guard.**
*What happens:* the old vocabulary reappears in extracted output with no error anywhere. *Why:*
the extraction prompt and the insert-side guard were two artefacts changed on two days. *Do
instead:* both read the framework from the database at runtime, so there is nothing to keep in
step. *Where:* `docs/03_COMPETENCY_FRAMEWORK.md` §8, `docs/11_AI_PIPELINE.md` §12.

**7.7 A deferred foreign key that is never added.**
*What happens:* the schema works, accepts orphan ids, and nothing indicates the constraint is
missing. *Why:* the framework migration range runs after the ETR range, so those columns exist
unconstrained in between; if the constraint migration is skipped or fails, nothing complains. *Do
instead:* verify after migrating that every such column appears in
`information_schema.referential_constraints`. *Where:* `docs/02_DATA_MODEL.md` §5, §7.

**7.8 A cascade in the wrong place.**
*What happens:* deleting a template or a session takes dependent records with it. *Why:* cascades
were added for convenience while writing the schema. *Do instead:* only three cascades exist —
user to role grants, session to its grades and subjects, template version to its elements. A
delete with dependent records must fail loudly; the correct action is a soft delete anyway.
*Where:* `docs/02_DATA_MODEL.md` §7.

**7.9 Validating at render time rather than authoring time.**
*What happens:* a template saves cleanly and then cannot be rendered, or duplicates a native block
because its title was reserved. *Why:* validation lived in the renderer. *Do instead:* validate in
the builder at authoring time, through the shared rules module of 2.4. *Where:*
`docs/05_TEMPLATES_AND_BUILDER.md` §9.

**7.10 Deferring a field to the render step.**
*What happens:* a field exists on the printed report and nowhere in the database, so no analytic
can ever use it and a re-render loses it. *Why:* the value was computed where it was displayed.
*Do instead:* all data lands at load time; the render step only renders. *Where:* `docs/04_ETR.md`
§9.

**7.11 A migration that derives reference data from the rows present when it runs.**
*What happens:* a different result on every environment, and no way to tell which is right. *Why:*
the migration read the data instead of carrying it. *Do instead:* forbid it on deployed
environments; ship verified rows as seed. *Where:* `docs/15_DEPLOYMENT.md` §11.

**7.12 A window parameter honoured literally.**
*What happens:* every configured base window is empty, so every indicator reports insufficient
data on a freshly seeded environment. *Why:* a months parameter was treated as the window rather
than as a floor, and the configured base starts earlier than it. *Do instead:* extend generation
to cover the earliest configured base, and print that you did. *Where:*
`docs/14_SEED_AND_SYNTHETIC_DATA.md` §10.

**7.13 An alter that fails halfway through.**
*What happens:* a migration errors mid-statement and leaves a table half-converted, which is worse
than either state. *Why:* a constraint was still in place when the column type changed under it —
a numeric range check on a grade column being converted to text is the canonical case. *Do
instead:* drop dependent constraints, convert, re-add what still applies. Grade columns are text;
a grade vocabulary is not a number. *Where:* `docs/02_DATA_MODEL.md` §7.

---

## 8. State that contradicts itself

*One fact, two columns, and a moment between the two writes. The database is the only place that can
enforce the agreement.*

**8.1 A status column drifting from its own count.**
*What happens:* an item shows clear while findings are open against it, and every compliance
figure derived from the status is wrong in a direction nobody looks. *Why:* two writes, one
transaction, one of them conditional. *Do instead:* a deferrable constraint trigger checked in
both directions, and — when it does drift — recount from the source rows inside the same
transaction rather than trusting one column and rewriting the other in application code. *Where:*
`docs/09_DMS.md` §8, §9.

**8.2 Storing a value that should be derived.**
*What happens:* a nightly materialisation fails on a Sunday and on Monday a subject reads as valid
three weeks after expiry, with nothing on the row to say how stale it is. *Why:* a stored status
is only as fresh as its last successful run. *Do instead:* derive on read; materialise only as an
explicitly-timestamped cache the read path may ignore. The same rule makes counters derived, never
stored. *Where:* `docs/08_QMS.md` §9, `docs/04_ETR.md` §4, `docs/05_TEMPLATES_AND_BUILDER.md` §7.

**8.3 Deriving a value that should have been frozen.**
*What happens:* editing a retention rule silently changes the disposal date of every record
approved under the previous one. *Why:* the date was computed on read from the live rule. *Do
instead:* freeze the date on the row at approval and version the rules by their effective date.
This is the mirror image of 8.2 — the test is whether the value is a fact about a past event
(freeze) or a statement about the present (derive). *Where:* `docs/09_DMS.md` §9,
`docs/17_GOVERNANCE.md` §8.

**8.4 Marking a run complete before its last stage.**
*What happens:* a surface reads a half-built run, and somebody adds a sleep to make it stop.
*Why:* the status was set where the work looked finished. *Do instead:* set the terminal status
once, at the end, in the same transaction as the last write. *Where:* `docs/11_AI_PIPELINE.md`
§12.

**8.5 No uniqueness on a workflow instance.**
*What happens:* a re-run raises a second open approval and the same qualification is granted twice
with different dates. *Why:* nothing prevented two open instances for one subject and type. *Do
instead:* a partial unique index on the open state, and an upsert that names it as the conflict
target. *Where:* `docs/08_QMS.md` §9.

**8.6 An upsert without a named conflict target.**
*What happens:* it works until a second unique index exists, and then silently updates the wrong
row. *Why:* the inferred target changed when the schema did. *Do instead:* always name the
conflict target explicitly. *Where:* `docs/11_AI_PIPELINE.md` §12.

**8.7 A sync that updates.**
*What happens:* a re-run overwrites a corrected value with the counterparty's stale copy, and the
correction is gone with no trace. *Why:* an upsert written for convenience. *Do instead:* inbound
feeds insert or hold, never update and never delete; manual and corrected rows carry their own
source and are excluded from sync writes; conflicts go to a reconciliation queue for a human to
accept or reject one difference at a time. *Where:* `docs/10_INTEGRATION.md` §2, §4.

**8.8 Inferring an outcome that was never recorded.**
*What happens:* a record shows an outcome nobody assessed, and it is defended for weeks because
the derivation looks reasonable. *Why:* an outcome was computed from grades, objectives,
conclusions or the presence of a word in free text. *Do instead:* an outcome is recorded or it is
absent. It is never inferred, at any point in the pipeline, including at import. *Where:*
`docs/04_ETR.md` §9.

---

## 9. Lifecycle and locking

*When a thing becomes unchangeable, what happens to the work that was in flight, and what the
evidence looks like afterwards.*

**9.1 Locking on the second signature.**
*What happens:* one party edits the content after the other has signed it. *Why:* the lock was
placed where the record was considered finished rather than where it stopped being provisional.
*Do instead:* lock on the **first** signature. *Where:* `docs/04_ETR.md` §9, §2.

**9.2 Editing a signed record.**
*What happens:* content changes under a signature, and every signature in the store becomes
deniable — including the honest ones. *Why:* an "an administrator can fix it" path was left open.
*Do instead:* the first signature locks; unsign-with-a-reason is the only amendment path; prior
signatures are retained as superseded, never overwritten. *Where:* `docs/17_GOVERNANCE.md` §8.

**9.3 An imported record asserting a platform signature.**
*What happens:* asked who signed electronically, the honest answer is nobody — the row was
imported. *Why:* the importer reused the signature columns because they fit. *Do instead:* a
distinct attestation kind for imported evidence, claimed attributes clearly labelled, no content
hash, and a rendering that says where it was actually signed. *Where:* `docs/17_GOVERNANCE.md` §8.

**9.4 A rule change applied retroactively.**
*What happens:* raising a minimum this month turns last month's compliant grants red. *Why:*
holdings were evaluated against the live definition rather than the one they were granted under.
*Do instead:* holdings pin the definition version they were granted under; migration to a new
version happens at renewal, and publishing never rewrites existing holdings. *Where:*
`docs/08_QMS.md` §9.

**9.5 A publish with no friction.**
*What happens:* the population of who is qualified, or what a form asks, changes without anyone
being able to say when or why. *Why:* publish was a button. *Do instead:* change note, effective
date, re-authentication, a diff against the current version, and an applicability count computed
server-side — a rule matching everyone or nobody is almost always an authoring error, and the
count is how it is caught before publish. *Where:* `docs/05_TEMPLATES_AND_BUILDER.md` §9,
`docs/08_QMS.md` §7.

**9.6 Early renewal conflated with expiry grace.**
*What happens:* a renewal done a month early re-anchors to the completion date and quietly
shortens validity by a month, every cycle, compounding. *Why:* both windows are "days near the
expiry" and were merged into one setting. *Do instead:* two fields, two sides, two anchor rules,
rendered on a timeline in the editor. *Where:* `docs/08_QMS.md` §9.

**9.7 An engine that can grant will grant.**
*What happens:* nobody can name the human accountable for a qualification, and the audit fails on
the first sample. *Why:* the evaluator was given the grant path because the rules were satisfied.
*Do instead:* the engine only ever opens an approval; the grant requires a capability, a named
approver and an evidence snapshot. *Where:* `docs/08_QMS.md` §9.

**9.8 Instructor authorities modelled as roles.**
*What happens:* an assessor whose examining authority expired last month signs a check, because
the role never expired. *Why:* roles have no validity dates. *Do instead:* authorities are
qualification types with validity; permission cells declare the qualification they require; the
session-create path checks the assessor's status for that stage as of today, refuses when expired,
and logs any override. *Where:* `docs/08_QMS.md` §9, `docs/12_ROLES_AND_PERMISSIONS.md` §4.

**9.9 A background pull landing mid-session.**
*What happens:* the template or the roster is replaced under an assessor who is part-way through
grading. *Why:* the pull was made automatic for symmetry with the push. *Do instead:* push
automatic, pull explicit, with a visible "last pulled" timestamp. *Where:*
`docs/10_INTEGRATION.md` §4.

**9.10 A delete that half-completes and reports success.**
*What happens:* parent rows are gone, children remain, and the failure surfaces later as an orphan
nobody can explain. *Why:* the writes were concurrent, or a failed write returned no error. *Do
instead:* sign, unsign, finalise, update and delete all return an error on a failed write; a
delete runs children before parent, sequentially. *Where:* `docs/04_ETR.md` §9.

**9.11 Deleting rather than moving.**
*What happens:* evidence a retention rule or a legal hold required is destroyed by one unlink in
one batch path. *Why:* the shared soft-delete helper was inconvenient in that one place. *Do
instead:* soft delete everywhere, files included — a delete moves the file to the retention store,
date-prefixed, and writes an audit row. One implementation, no unlink call in the codebase, a test
that greps for one, and the acting user's own password for a record. *Where:* `docs/09_DMS.md` §9,
`docs/04_ETR.md` §9.

**9.12 Append-only by convention.**
*What happens:* a cleanup script or an ORM cascade edits the audit log, and its value as evidence
is gone with no way to detect that it happened. *Why:* "append-only" was a comment. *Do instead:*
a mutation-denying trigger plus `REVOKE UPDATE, DELETE` from every application role, and writes
through a restricted path. *Where:* `docs/02_DATA_MODEL.md` §7, `docs/17_GOVERNANCE.md` §8.

**9.13 Retrieval chunks attached to a document rather than to a version.**
*What happens:* a superseded revision keeps answering queries, with a citation that looks current.
*Why:* re-chunking updated rows in place instead of retiring them. *Do instead:* chunks belong to
a version row and carry its checksum; superseding retires the old set. *Where:* `docs/09_DMS.md`
§9.

---

## 10. Access and disclosure

*Everything here was correct on the screen the developer was looking at.*

**10.1 Collapsing scopes to the widest one.**
*What happens:* a user can see a subject on one page and not on another, which reads as a caching
bug for a long time. *Why:* resolving a capability to a single "highest" scope is intuitive and
wrong — scopes like *assigned* and *team* are not nested. *Do instead:* union the member sets.
*Where:* `docs/12_ROLES_AND_PERMISSIONS.md` §8.

**10.2 A disabled control standing in for a permission check.**
*What happens:* it tells the caller exactly what they are missing, it is trivially re-enabled in
the browser, and sooner or later a handler trusts it. *Why:* rendering-and-disabling was easier
than conditional rendering. *Do instead:* do not render it at all; the server re-checks
regardless. *Where:* `docs/12_ROLES_AND_PERMISSIONS.md` §8, `docs/13_DESIGN_SYSTEM.md` §11.

**10.3 Importing the server resolver into a client component.**
*What happens:* the whole permission model ships to the browser, and the connection string with
it. *Why:* one import, in one component, for one convenience. *Do instead:* pure predicates and
the resolver in separate modules, `import 'server-only'` at the top of the resolver, and a lint
rule — this is the one boundary in the codebase worth one. *Where:*
`docs/12_ROLES_AND_PERMISSIONS.md` §8.

**10.4 A new route that defaults to open.**
*What happens:* a route ships unguarded because nothing required it to declare a capability.
*Why:* the guard was opt-in. *Do instead:* an allow-list of route prefixes with their capabilities
and a final deny. Every audit of this system starts by asking for that list. *Where:*
`docs/12_ROLES_AND_PERMISSIONS.md` §8.

**10.5 Self-exclusions treated as scopes.**
*What happens:* an assessor watches their own leniency delta and grades to the metric; a subject
refreshes their own analysis; someone amends the record they signed. *Why:* *assigned* and *team*
both include the holder, so no scope can express "everyone but you". *Do instead:* exclusions are
enforced in the resolver's visible-person set, at every scope including the widest — which is also
why routes may not build their own filters. *Where:* `docs/12_ROLES_AND_PERMISSIONS.md` §7.

**10.6 A visibility flag skipped by a second route.**
*What happens:* a subject reads a record that was marked hidden from them, through the file stream
rather than the record view. *Why:* the flag was applied in serialisation on one path only. *Do
instead:* apply the flag before serialisation on every own-scope read **and** on the document
stream route; resolve files by id through the resolver, never by path. *Where:*
`docs/12_ROLES_AND_PERMISSIONS.md` §7, `docs/09_DMS.md` §9.

**10.7 A hard gate made overridable.**
*What happens:* a restricted visibility is granted "temporarily" to solve an operational problem
and is still granted two years later. *Why:* it was modelled as a capability that could be
granted. *Do instead:* it is a non-overridable gate, checked after every other rule, on every
request. *Where:* `docs/12_ROLES_AND_PERMISSIONS.md` §8.

**10.8 Role changes riding on the profile form.**
*What happens:* a stale client resubmits an old role array and escalates someone's privileges.
*Why:* one form saved profile fields and roles together. *Do instead:* roles change through their
own route, their own capability and their own audit action. *Where:*
`docs/12_ROLES_AND_PERMISSIONS.md` §8.

**10.9 Export treated as view.**
*What happens:* someone downloads a full record set that policy allowed them only to read on
screen. *Why:* the download route reused the view capability. *Do instead:* export and bulk export
are distinct capabilities, checked at the download route, with no own-scope carve-out, and every
export is audited with a record count. *Where:* `docs/09_DMS.md` §9, `docs/17_GOVERNANCE.md` §5.

**10.10 A helpful login error.**
*What happens:* valid usernames can be enumerated from outside, and deactivated accounts are
identifiable. *Why:* the failure reason was returned to the client. *Do instead:* one generic
message to the client, the specific outcome in the admin-only log. *Where:*
`docs/17_GOVERNANCE.md` §8.

**10.11 Re-authenticating the wrong user.**
*What happens:* a destructive action is confirmed with the target's password rather than the
caller's, so the control confirms nothing. *Why:* the target was the object already loaded in the
handler. *Do instead:* re-authentication always verifies the acting session's own user,
server-side, fail-closed. *Where:* `docs/17_GOVERNANCE.md` §8.

**10.12 Personal data in a URL.**
*What happens:* names and identifiers land in access logs, proxy logs, browser history and
third-party error reporting — outside every retention rule the platform enforces. *Why:* a GET was
easier than a POST. *Do instead:* opaque ids in paths, filters in bodies, and a route-level check
that refuses to build a URL containing a name field. *Where:* `docs/10_INTEGRATION.md` §4.

**10.13 A storage path reaching the client.**
*What happens:* the storage layout becomes part of the public API surface, traversal included.
*Why:* the path was already in the row the API returned, and an id-based fetch was replaced with a
path-based one for convenience. *Do instead:* exclude the storage key from every select list that
serves a client; fetch files by document id through the resolver. *Where:* `docs/09_DMS.md` §9.

**10.14 A log with no retention period.**
*What happens:* addresses and identifiers accumulate indefinitely, and the security log becomes
the largest undeclared personal-data store in the platform. *Why:* it was built as a security
feature, not as a data store. *Do instead:* a stated period, an automated purge, and a line in the
privacy notice. *Where:* `docs/17_GOVERNANCE.md` §8.

**10.15 A young log presented as complete coverage.**
*What happens:* a reviewer infers that no activity occurred before the earliest row. *Why:* nobody
said when logging started. *Do instead:* state the logging start date in every audit pack and keep
the prior evidence source named. *Where:* `docs/17_GOVERNANCE.md` §8.

**10.16 A tablet payload carrying more than the screen shows.**
*What happens:* restricted material — concern levels, watch-list membership, analysis output,
assessor analytics, restricted notes — reaches a device that never displays it. *Why:* the payload
was built from the server-side row. *Do instead:* build the offline payload from an explicit
allow-list for every role including the widest, leak no figure derived from a restricted document
into a self-view, encrypt at rest and purge on sync. *Where:* `docs/10_INTEGRATION.md` §3.

---

## 11. Operational

*What is actually running, and whether you could get it back.*

**11.1 One image tag shared by two environments.**
*What happens:* a routine restart on one environment silently promotes the other's build. *Why:* a
bare `up -d` pulls whatever that tag now points at. *Do instead:* one image variable per
environment, and a probe asserting the split, run as a deploy assertion. *Where:*
`docs/15_DEPLOYMENT.md` §4.1, §11, `docs/01_ARCHITECTURE.md` §5.

**11.2 `latest` as a tag.**
*What happens:* nothing records what is running, and there is nothing to roll back to. *Why:* it
was convenient once. *Do instead:* immutable tags, recorded per environment. *Where:*
`docs/15_DEPLOYMENT.md` §11.

**11.3 Editing code on a deployed host.**
*What happens:* the symptom returns at the next deploy, with no trace of the fix or the diagnosis.
*Why:* the host had a shell and the fix was one line. *Do instead:* fix in the repository, deploy.
*Where:* `docs/15_DEPLOYMENT.md` §11.

**11.4 Copying an environment file between hosts.**
*What happens:* one environment quietly points at the other's database, data root and secrets.
*Why:* the file was "mostly the same". *Do instead:* every host owns its own; the deploy never
touches it. *Where:* `docs/15_DEPLOYMENT.md` §11.

**11.5 A published host port used for container-to-container traffic.**
*What happens:* every export fails with a bare fetch error, unreachable from inside the network.
*Why:* the URL that worked from a laptop was reused inside the stack. *Do instead:* service name
and internal port between containers. *Where:* `docs/15_DEPLOYMENT.md` §11.

**11.6 A host-loopback alias or a host adapter address in configuration.**
*What happens:* it does not resolve at all on one platform, and on another it breaks every call at
once after a reboot. *Why:* the address is assigned, not fixed. *Do instead:* service names inside
the stack; explicit configuration outside it. *Where:* `docs/15_DEPLOYMENT.md` §11.

**11.7 Trusting the host firewall to keep a container port private.**
*What happens:* a port believed to be internal is reachable from the network. *Why:* the container
runtime writes its own forwarding rules and bypasses the host firewall. *Do instead:* bind
published ports to loopback. *Where:* `docs/15_DEPLOYMENT.md` §11.

**11.8 An unauthenticated local inference runtime bound to all interfaces.**
*What happens:* an open model endpoint on the host's network, usable by anyone who finds it.
*Why:* the default binding was never changed. *Do instead:* loopback, or a subnet-scoped rule
verified after every upgrade — upgrades reset it. *Where:* `docs/15_DEPLOYMENT.md` §11.

**11.9 A backup that has never been restored.**
*What happens:* the first restore is attempted during the first real incident, at full volume, and
it does not work. *Why:* the dump job was green, so the job looked done. *Do instead:* a scheduled
restore test with a recorded outcome, drilled at realistic volume and timed, and a full-volume
rehearsal as a cutover gate. *Where:* `docs/15_DEPLOYMENT.md` §11, `docs/17_GOVERNANCE.md` §8.

**11.10 Restoring the database without the file store.**
*What happens:* records reference files that are not there, and the restore looks successful.
*Why:* the database was the thing that felt like the system. *Do instead:* the data root is part
of the backup and part of the drill. *Where:* `docs/15_DEPLOYMENT.md` §11.

**11.11 A verification suite run as a monitor.**
*What happens:* failures are reviewed after the release they should have stopped. *Why:* it was
scheduled rather than wired into the deploy. *Do instead:* gate the deploy on it, and run it
against a freshly migrated, freshly seeded environment. *Where:* `docs/15_DEPLOYMENT.md` §11,
`docs/00_REPLICATION_RUNBOOK.md` phase 5.

**11.12 Smoke-testing a sample of pages.**
*What happens:* the one page nobody fetched is the one a reviewer opens. And the defect it hides
is specific: a query written correctly for the first row and fatally for every other row is the
single most expensive defect class in this domain, and no amount of SQL review finds it. *Why:*
sampling felt proportionate. *Do instead:* sweep — fetch every route and every subject page.
*Where:* `docs/15_DEPLOYMENT.md` §11, `docs/00_REPLICATION_RUNBOOK.md` phase 3.

**11.13 Treating a 200 as proof.**
*What happens:* a smoke run passes against error boundaries, empty states and login redirects, all
of which return 200. *Why:* the status code was the assertion. *Do instead:* assert a known marker
in the body of every page. *Where:* `docs/15_DEPLOYMENT.md` §11.

**11.14 A model call inside the interactive request path.**
*What happens:* the latency budget is blown and every provider timeout becomes a user-visible
error. *Why:* it was one call, and it was fast in development. *Do instead:* queue it; the
interactive path reads results. *Where:* `docs/11_AI_PIPELINE.md` §12.

**11.15 Model ids or endpoint URLs as literals.**
*What happens:* a provider swap becomes a search-and-replace and somebody misses a call site.
*Why:* there was only one call site at the time. *Do instead:* everything through the single
inference seam — base URL and the two model tiers — and a degraded mode that is a supported,
tested state. *Where:* `docs/11_AI_PIPELINE.md` §12, `_KIT_CONTRACT.md` §4.

**11.16 Calling the application's own HTTP API from inside the application.**
*What happens:* it passes in development and is rejected in production, because the auth differs
per environment. *Why:* the endpoint already existed. *Do instead:* call the library function
directly; routes export handlers and config only. *Where:* `docs/11_AI_PIPELINE.md` §12.

**11.17 Hardcoded absolute storage paths.**
*What happens:* a host migration or a residency change becomes a code change, and a residency
commitment stops being credible. *Why:* one convenience constant in one module. *Do instead:* a
configured storage root with relative keys, and a traversal-proof join used by every path-building
call. *Where:* `docs/09_DMS.md` §9.

**11.18 A freshly seeded database has no statistics.**
*What happens:* the install completes, the data is correct, and the analytics screens hang — one
view answers in under two seconds on a laptop and not at all on the machine that was just seeded.
*Why:* every table was empty when the planner last looked and autovacuum has not been round yet,
so it estimates one row for everything and picks a nested loop that re-evaluates a whole subquery
per outer row. Nothing is wrong with the query; the plan was built for a table that no longer
exists. *Do instead:* `ANALYZE` at the end of the seed, in the seed script, after the commit — not
as housekeeping and not left to a schedule. Measure a view before concluding the analytics layer
is slow. *Where:* `docs/14_SEED_AND_SYNTHETIC_DATA.md` §10, `docs/15_DEPLOYMENT.md` §9.

---

## 12. Rendering and the second reader

*Everything below is correct in the browser the developer used and wrong on paper, on a projector,
in greyscale, or to a reader who cannot distinguish two of the colours.*

**12.1 A client-only chart renders as an empty box in the export.**
*What happens:* the report is produced, and one chart is blank. *Why:* an effect that sets
geometry state, a viewport read, or a locale-dependent format produces nothing in a headless
renderer — and the export still succeeds. *Do instead:* pure, server-renderable components, with
interactivity added by a thin wrapper. *Where:* `docs/07_VISUALISATION.md` §9.

**12.2 A component reading a CSS custom property at render time.**
*What happens:* marks come out in a default fill in the export, and preview and PDF diverge in a
way nobody catches until someone is holding the printout. *Why:* the export renderer receives no
stylesheet, so a computed-style read returns an empty string. *Do instead:* charts receive
resolved colours as props, from the chart token module. *Where:* `docs/13_DESIGN_SYSTEM.md` §11.

**12.3 A colour defined only inside a media query.**
*What happens:* a black-on-black card that never appears on the developer's machine. *Why:* the
token's only definition lived in the dark-scheme block. *Do instead:* define every token on the
bare root first, then redefine it in the override. *Where:* `docs/13_DESIGN_SYSTEM.md` §11.

**12.4 A hex literal in a component.**
*What happens:* it survives a rebrand and a framework edit, and the chart is the one thing still
in the old palette. *Why:* it was faster than adding a token. *Do instead:* every colour through
the token module; competency colours are data and change with an update statement. *Where:*
`docs/07_VISUALISATION.md` §9, `docs/13_DESIGN_SYSTEM.md` §11.

**12.5 Colour as the only channel.**
*What happens:* a state is invisible in a monochrome printout, ambiguous to a colour-blind reader
and meaningless in a screen reader. *Why:* the colour was legible to the author. *Do instead:* a
second channel on every meaningful encoding — the numeral, the band word, the shape or the hatch.
Every state carries its word. *Where:* `docs/07_VISUALISATION.md` §9, `docs/13_DESIGN_SYSTEM.md`
§11.

**12.6 A hover-only tooltip.**
*What happens:* the information does not exist in the export and cannot be reached by keyboard.
*Why:* hover was the natural interaction. *Do instead:* every tooltip has a static counterpart — a
printed label, a table row or a footnote. *Where:* `docs/07_VISUALISATION.md` §9.

**12.7 A colour-only legend, and a heatmap without printed values.**
*What happens:* the reader cannot recover a number from a ramp, and a legend forces a lookup for
every mark. *Why:* the encoding was designed to be looked at rather than read. *Do instead:* label
series at their last point or print the code in the mark; print the value in every heatmap cell
and state the ramp's centre in the legend. *Where:* `docs/07_VISUALISATION.md` §9.

**12.8 A missing clip path.**
*What happens:* panning draws series and reference lines over the axis labels and past the card
edge. *Why:* nothing constrained the plot rectangle. *Do instead:* a clip path over the plot
rectangle wrapping reference lines, whiskers, paths and dots. *Where:* `docs/07_VISUALISATION.md`
§9.

**12.9 Conditional rendering of interactive marks.**
*What happens:* the click never lands, because the element was unmounted between pointer-down and
pointer-up. *Why:* the mark was rendered from hover state. *Do instead:* keep marks mounted; track
movement in a ref, not in state; use pointer events so mouse, touch and pen take one path, and
keep the page scrollable on tablets. *Where:* `docs/07_VISUALISATION.md` §7, §9.

**12.10 Scaling values without scaling thresholds.**
*What happens:* a healthy series turns red. *Why:* a display denominator was applied to the
plotted values while the reference lines stayed on proportions. *Do instead:* keep everything on
proportions until the render step, then scale values and reference lines together, in one place.
*Where:* `docs/07_VISUALISATION.md` §9.

**12.11 Zero-filling a null.**
*What happens:* a missing grade is drawn at the axis and reads as the worst possible outcome.
*Why:* the chart wanted a continuous line. *Do instead:* skip nulls and break the line. *Where:*
`docs/07_VISUALISATION.md` §9.

**12.12 A blank plot area.**
*What happens:* an empty chart reads as "everything is fine" rather than "nothing is known".
*Why:* there was one rendering path and no data. *Do instead:* explicit states — no data,
insufficient data, suppressed, and populated — each with its own words. *Where:*
`docs/07_VISUALISATION.md` §4, §9.

**12.13 Two counts in one sentence.**
*What happens:* a reader takes them as a ratio. *Why:* a grade count and a record count sat side
by side in a header. *Do instead:* label and footnote each count, and never place a grade count
adjacent to a record-denominated rate without saying so. *Where:* `docs/07_VISUALISATION.md` §9,
`docs/06_ANALYTICS.md` §18.

**12.14 Two display denominators labelled with one unit string.**
*What happens:* one series is overstated by roughly the number of competencies per record, and
both sit on one axis. *Why:* "per N" looked like a unit. *Do instead:* the formatter returns unit,
label and denominator together, and the two series never share an axis. Give the estimation sample
size and the display denominator deliberately different values, described in different sentences,
so a shared number cannot conflate them. *Where:* `docs/06_ANALYTICS.md` §18.

**12.15 An indicator with its baseline off screen.**
*What happens:* nobody can audit why a point is flagged. *Why:* the base window, base rate and
spread were inputs, not output. *Do instead:* print the base window, base rate, spread and config
version in the indicator's header. *Where:* `docs/07_VISUALISATION.md` §9.

**12.16 A value invented between the scale steps.**
*What happens:* within a month there are four type sizes between two of the defined ones, and the
ad-hoc value is the one that fails the next contrast check. *Why:* "just 13 pixels here", copied
onto the next screen. *Do instead:* only the steps; emphasis comes from the scale, never from
overriding a passing base style with a second ink, size or border weight. *Where:*
`docs/13_DESIGN_SYSTEM.md` §7, §11.

**12.17 A filter held in client state.**
*What happens:* a screen that cannot be linked, cannot be reproduced from a support report and
cannot be fetched by the smoke sweep. *Why:* it was one useState. *Do instead:* filters live in
the URL. *Where:* `docs/13_DESIGN_SYSTEM.md` §11.

**12.18 An editor that allows arbitrary nesting.**
*What happens:* definitions nobody can read and previews nobody trusts. *Why:* nesting was free to
implement and felt general. *Do instead:* sections and one level of grouping, and a preview that
renders the whole definition in plain language. *Where:* `docs/05_TEMPLATES_AND_BUILDER.md` §9,
`docs/08_QMS.md` §7.

**12.19 A minimum target too small to hit.**
*What happens:* an interactive mark cannot be used on a tablet. *Why:* the mark's size was chosen
for the printed page. *Do instead:* a 24-pixel minimum target, with an invisible hit rectangle
where the mark itself is smaller. *Where:* `docs/07_VISUALISATION.md` §8.

---

## The ten that cost the most

If you have five minutes, these are the ones. They are ranked by what they actually cost — days
lost, figures published wrong, or evidence that could not be produced when it was asked for — not by
how likely they are.

| # | Trap | Entry | What it costs |
|---|---|---|---|
| 1 | Keying on a competency name | 1.1 | a rename becomes a fourteen-table, six-figure-row migration, and until it is done every join returns quietly fewer rows |
| 2 | Keying answers to an element row id an editor can regenerate | 1.2, 1.3 | one template save destroys the grades recorded against it, with no error and no way back except a restore |
| 3 | Reading one source home | 2.1 | a dashboard that reports zeros for an entire population, believed for months |
| 4 | Last attempt read as history | 6.2 | below-standard counts at roughly half their true value — the figure most likely to be quoted outside the organisation |
| 5 | A check that cannot fail | 4.1, 4.3, 4.5 | a suite that is green for reasons unrelated to correctness, which is worse than no suite because it is trusted |
| 6 | A model producing a figure | 2.7 | a report sentence that is close to right, believed by the reader, and indefensible under review |
| 7 | A list endpoint assumed to return everything | 3.1 | duplicate people, a corrupted roster, and a week spent on the wrong hypothesis |
| 8 | Two derivations of one concept | 2.2 | two screens disagreeing about the same person, with no way to say which is wrong |
| 9 | A backup that has never been restored | 11.9 | discovered during the first real incident, at full volume, when there is no second chance |
| 10 | A widest-scope collapse in the permission resolver | 10.1 | access that is inconsistent per page, reported as a caching bug, and either over-permissive or under-permissive for a long time |

Two runners-up worth the eleventh and twelfth minutes: **7.1** (config loaded after the things that
read it — every number wrong, no test notices) and **11.1** (one image tag shared by two
environments — a restart promotes the wrong build).

---

## How to add to this file

**The shape.** Four parts, in this order, and nothing else:

```
**N.M A short name in the imperative or the diagnostic.**
*What happens:* the symptom, as the person meeting it for the first time would describe it.
*Why:* the mechanism, one or two sentences. Not blame, not history.
*Do instead:* the rule, stated so it can be checked.
*Where:* the doc and section that owns the detail.
```

Four lines of prose or fewer. If it needs more, the detail belongs in the module doc and this entry
is a pointer to it.

**The bar for inclusion.** A trap earns an entry only if it has **actually happened** — in this
platform or in the system it was distilled from — or is **structurally guaranteed** by something in
the design: a foreign key that is deliberately absent, an ordering that nothing enforces, a default
that returns success. A thing that merely *could* go wrong is not a trap; it is a risk, and risks
belong in the module doc. This file loses its value the moment it becomes a list of everything
imaginable, because then nobody reads the classes.

**Where it goes.** By failure class, never by module. If you cannot decide which class, that usually
means you have described the symptom rather than the mechanism — ask what the wrong line of code
believed, and the class follows. If it genuinely belongs in two, write it in one and cross-reference
from the other; a mechanism appears here exactly once.

**When you add one.** Add the entry here, add the module-flavoured version to that doc's own Traps
section, and add the doc to the index table above if it is not already there. Number the entry with
the next free number in its class; numbers are never reused, because module docs cite them.

**When you remove one.** Only when the design change that makes it impossible has actually shipped —
a constraint added, a path deleted, a default reversed. Say so in the module doc. A trap that has
merely stopped happening has not stopped being possible.
