# 03 · Demo script — fifteen minutes with Avianca Training

Rewritten 2026-09-13, against what is **built and working**, not against what was hoped for in Phase 0.
The first version of this file named people and screens that never came to exist; it was a wish list,
and a wish list is a bad build spec. This version names only fixtures that are in the database and
screens that are on the machine today, plus exactly **one** slice still to build (§1), which is called
out as such.

The rule has not changed: **this script is the build specification.** Every screen it names is built.
Every screen it does not name is not built for the demo, and §10 says what was cut and what we say
about it out loud.

Audience: Head of Training, Training Standards, fleet chief pilots. Presenter: Esteban.
Demo day: **2026-09-29**. Rehearsal: **2026-09-27**, on the server, start to finish, twice.

---

## 0 · Before the room (not shown)

Revised 2026-09-14, after walking it on the machine. **The commands below replaced `npm run reset`,
which is the KIT's reset** — it seeds four starter templates and the kit's synthetic roster, and
running it would replace this instance with sample data. `reset:clean` is the operator path.

**The full rebuild**, in the repo, in this order. It is destructive and it is meant to be: the
database is never copied, every environment is built by migrate → seed.

```powershell
npm run gen:roster            # writes data/roster/pilots.json
npm run gen:programs          # writes data/programs/*.json
docker compose --env-file .env -f deploy/compose.dev.yml down -v        # drops ava-dev-db-data
docker compose --env-file .env -f deploy/compose.dev.yml up -d --wait   # --wait, NOT up -d
npm run reset:clean           # migrate, config, framework, operator, library, programs, publish, roster, admin_av
npm run seed:history          # three years; ~9 000 sessions, ~70 s, refreshes the analytics itself
npm run verify ; npm run smoke
```

**`--wait` is not optional.** `up -d` returns when the CONTAINER starts, not when Postgres is ready
to accept a connection, and a fresh volume has to run initdb first. Without it the first migration
meets "Connection terminated unexpectedly", nothing is applied, and every step afterwards fails
complaining about a missing table rather than about the database that was not up. The compose file
declares a healthcheck; `--wait` is what reads it. A cold server is slower than a laptop, so this
matters more on cvx-hel1, not less.

**Why `gen:programs` first.** `seed:program` refuses to touch a published version — it prints
"version 1 is published; not touched" — so corrected programs only reach a database that is being
built from nothing. On the server this is the same sequence with the deployed compose file.

**The accounts are not seeded.** `seed:roster` writes roster rows and no accounts at all, so every
login below is created by hand after `reset:clean` and given a password the same morning:

```powershell
npm run user -- a.betancur instructor --fleet A320 --person "Andrea Betancur"
npm run user -- <manager> training_manager --person "<their roster name>"
npm run password -- admin_av
npm run password -- a.betancur
npm run password -- <manager>
```

**`--person` is not optional for the instructor.** An account and a roster row are different things —
an administrator has no roster row, and a pilot has a roster row long before anyone gives them a
login — but an instructor is NAMED ON SESSIONS as a person, so an instructor account without the
link is refused at `/sessions/new` with "This account is not linked to a roster row". The value is
the staff number (Andrea is AV20110) or the full name; a name matching more than one active person
is an error rather than a guess.

`reset:clean` creates `admin_av` itself, so only the other two are made by hand. Passwords must be
at least 12 characters, and the prompt is interactive - never put one on the command line, where it
lands in the shell history and in the npm log.

- `admin_av` — the operator's administrator, for §8 only;
- **the Training Standards Manager** — `training_manager`, unbound to any fleet, granted to one of
  the seeded roster pilots (chosen at the rehearsal and written into this line then). This is the
  persona logged in for most of the demo, because a manager's screens are the ones a manager buys;
- **Andrea Betancur** — `a.betancur`, `instructor` bound to **A320**, TRI, CP, base CLO, seniority
  110. The instructor of record, and a real roster row.

**The §3 session is created at set-up, dated the demo day.** Signed in as Andrea, `/sessions/new`
→ **EBT Module 2 - Session 1 - A320** → the crew below → today's date → device FFS-A320. Then grade
it up to the last two exercises, so §3 finishes it live rather than starting from nothing.

**Her "To grade" list is NOT empty, and this paragraph used to claim it was.** The generator seeds
work in the past as well as ahead: on 2026-09-20 she had **Type rating FFS 7 - A320, 2026-09-14,
Open · to grade** — dated five days before the build that produced it, so a rebuild on the demo
morning will leave something similar. The session created at set-up carries today's date and sits at
the top of the list; take that one, and do not be surprised by its neighbour.

**Naming the second pilot is what makes it a crew session.** The form takes one pilot by default and
a second, optional, below it; the second seat is the other seat by definition and is not a choice.
One session, flown once, with a record each. (Until 2026-09-15 the form took one pilot only and this
step was impossible as written — every crewed session in the instance had been written by the
seeder. See KIT_DEFECTS.)

**The crew**, both of them Andrea's own pilots, with a finalised session flown with her:

- **Pedro Marín** — CP, **PF**;
- **Javier Beltrán** — FO, **PM**.

They flew **EBT Module 2 - Session 1 - A320 with Andrea on 2026-08-10** — finalised, two records,
both pilots signed. That is the same program §3 creates and the same seat shape, so §3 and §4 are
the same two people and the same instructor. They are NOT booked with her again: Andrea instructs no
future session with this pair, so do not promise one in the room.

**Confirm the pair at the rehearsal** against `/sessions/mine` → **Finalised**. The seed is
deterministic, but a regenerated roster is a different roster — and that is not hypothetical. Until
2026-09-21 this paragraph named Andrés Marín Morales and Emilio Arango "with finalised history with
her from May". They are a real pair who fly together, but **they have no session with Andrea at
all**: their May 2026 EBT was with Daniela Vélez, and November is booked with Vélez, Lucas Guerrero
and Cristian González Prieto. The roster had been regenerated and nobody had re-run this check.
Guillermo Peña + Esteban Rojas (2026-07-27) are the same shape if this pair ever goes stale.

- `docker ps` shows `ava-db` and `ava-pdf` up — **the PDF step fails silently in rehearsal if the
  renderer is down**, so check it, not just the app. `PDF_URL` must be `http://127.0.0.1:3101`,
  never `localhost`;
- `/api/health` shows the framework at 9 competencies / 73 behaviours and the population counts;
- browser tab pre-opened and signed in as the manager; a second tab signed in as Andrea. **Leave
  Andrea's tab on `/sessions/mine`**, not on a manager's screen: she does not hold the analytics
  capability and would meet the refusal page.

Fallback: the same instance on the laptop at `http://localhost:3100`, same seed, plus PDF exports of
every screen in this script in a folder on the desktop. If Cloudflare or the network fails, the story
continues from the laptop without apology.

---

## 1 · The training picture (2 min) — built

`/analytics`, in the nav as **Training picture**. The first thing the room sees.

On screen: active pilots, records signed, the population mean competency grade with its band, the
share at or below the standard, sessions open, validity due or expired; then **the alert queue** —
"N things need a decision", every line a link to the screen that acts on it; then competency averages
with their bands, the grade distribution across the population, the twelve-month trend, validity by
policy item, and the by-fleet table.

Sentence: *"Every figure on this page is computed from signed training records. Nothing here was typed
in, and nothing here was written by a language model."*

That sentence is true of the page and not only of the story: every figure reads `records` and the
grades hanging off them. The one exception is the instructor-outlier list, which reads the refreshed
assessor views and says so on the page — which is why `analytics:refresh` is in §0.

Why the alert queue belongs here: the ETR already writes those alerts (an objection notifies the
configured role; a competency graded against the evidence raises a mismatch). Until something reads
them the loop is open, and a manager's landing page is where it closes.

## 2 · The program is data (3 min) — built

`/templates` → **EBT Module 1 - Session 1 - A320** → the builder canvas. (There is no program called
"A320 EBT Recurrent"; the EBT programs are Module 1/2 × Session 1/2 × fleet × year, 24 of them.)
Phases down the page, exercises in them, the malfunction grid on an exercise. Click an exercise → the
inspector shows its time, seat, automation, the competencies it grades and, behind one click, the
**observable behaviours from the ICAO catalogue** for each of them. The published version shows all of
it read-only and says so: *"This version is published. It is shown exactly as it was frozen; take a
new draft to change it."*

Then the check. The header carries the finding count — **Checks clear**, or red with the blockers —
and it jumps to the Findings card. The live beat: open the draft, untick the competencies on a graded
exercise, the header goes red with **1 blocker**, click it, click the element key in the finding, the
canvas jumps there, re-tick, the chip goes green. Nothing planted.

Then **publish a new version** and show that the published one is immutable and the records signed
against the old version do not move.

Sentence: *"Your program is data, not a PDF. When you change it, the records already signed against the
old version do not move."*

Have ready: the program's own **As instructor** tab, one click away — the same grading surface the
instructor will use, driven here with nothing recorded, and a banner that says so. It answers "what
will my instructors see" before anyone asks.

## 3 · The ETR, end to end (5 min) — built. The centre of the demo.

Switch to Andrea's tab. `/sessions/mine` → **To grade** → the session created in §0.

**It is a crew.** Javier flies PM, Pedro flies PF, and the surface carries a tab per pilot plus a
tab for the session. Say it early, because a room of chief pilots counts the seats: *"Every graded
element is graded per pilot, in the seat they flew."*

1. **Grade the last two exercises, for both pilots.** A grade is written on the click — no Save
   button; the line at the top says what was written and when. Click a grade again to clear it.
2. **The proposal.** Grade the competencies and let the room see *"the tasks so far propose 4"* — then
   enter 3 instead, and the surface asks for the reason in the comment. Say why that pairing exists.
3. **Repeat an exercise.** The first grade stays on the record as attempt 1.
4. **Try to go to Review before finishing.** It refuses and lists what is missing, each one a button
   that jumps to it. The count is per pilot.
5. **Review and sign.** The content hash is on the page. Andrea signs once, with **her own password**,
   and that one signature freezes the content for both pilots — each against their own hash, because
   each flew a different seat and earned different grades. The session locks: the surface does not
   disappear, it goes read-only and says why.
6. **Hand over, twice.** Javier signs on the same screen, then Pedro. Each signs as themselves.
   Where a pilot has no account the fallback is their employee id, and the record says which of the
   two actually happened — say that out loud, and say that on a live system every pilot who signs has
   an account.
7. **Finalise.** Two records are frozen, one per pilot, and **the PDF is rendered as part of
   finalising** — open both.
8. **Then show that the two hashes differ, and that each PDF's footer matches its own record.** One
   session, two records, two signatures, two hashes.

Sentence: *"The instructor decides; the system proposes and remembers when they disagreed. Once it is
signed, the record cannot change — and if anybody changes it, the hash says so."*

Outcome vocabulary here is EBT: PROFICIENT / NOT PROFICIENT. OPC and LPC templates use PASS / FAIL, and
the check is chosen when the session is created.

## 4 · One pilot over time (2 min) — built

Back to the manager's tab. `/subjects/<Pedro Marín>`: the nine-spoke competency radar,
band-coloured averages, the 3×3 trend grid, and the record list with the session from §3 at the top
and his **EBT Module 2 Session 1 from 2026-08-10, signed by Andrea**, beneath it — same pilot, same
instructor, real history. Open one — the record pop-up renders the frozen snapshot, not a template
lookup. **Open the PDF from there too.**

He carries **32 records back to 2015 and 225 competency grades**, so the radar is dense and the
trends have something to show; he is also a **TRI**, which is worth one sentence — an instructor is
checked like everybody else, by somebody else. What he does NOT have is a failure in recent history:
the pilot this section used to name had a failed line check to point at, and this one does not. If
the section needs that beat, take it from the alert queue on §1 instead.

Sentence: *"This is the same nine-competency model your regulator uses, and every band has a threshold
you can see and change in a configuration file, not in our code."*

## 5 · Where every pilot stands (1.5 min) — built

`/subjects/status`. Line-pilot validity per policy item, and the **initial-training board**: a column
per stage, a lane per course, each card placed by the last milestone actually signed. Click a counter to
filter. Open a card → the milestone timeline and the sector-by-sector LFUS table, each sector its own
record.

Sentence: *"Nobody moves a card. The board reads the signed records, so it cannot disagree with them."*

This is the expiry story as well, which is why the QMS dashboard is not in this demo (§10).

## 6 · Are we grading the same way? (2 min) — built. The differentiator.

`/instructors` → the bench, then **Analysis**.

**Open on the number that is not there.** The bench card reads **Outside the band 0**, and the queue
below the scatter says so in words: *nobody on this bench sits outside ±0.5 grade points once their
roster is accounted for*. Say it out loud before anyone asks — **this screen is not accusing anybody
today**. A room of chief pilots arrives expecting a witch-hunt, and the fastest way to get the next two
minutes listened to is to answer that first.

Then the three pictures: the standardisation index across the bench, the leniency scatter banded
outward from zero, the competency grid labelled RAW.

**Then the one who leans.** `/instructors/<id>/analysis` for **Sergio Sierra Bermúdez** — TRE TRI,
A320, CLO. Adjusted leniency **−0.39, leans strict**, on 2 452 grades across 301 records and 162
pilots; standardisation index **85, green**; **check versus training −0.03, no difference** — he grades
a check the way he grades training, and the interval spans zero, so the surface says so rather than
implying a finding. The index breakdown shows where the 14.8 points went: 11.8 of them to the leniency
term alone, and **0.0 lost on justification — 368 of 368 low grades carry a remark**. Then the mismatch
alert queue, where a decision needs a reviewer's note.

**The point of the walk**: the system found a real leaning, measured it against what the same pilots
earned from everybody else, put an interval on it — and still did not flag him, because −0.39 is inside
the band the operator set. That is the product.

Sentence: *"This does not compare an instructor to an average. It compares their grades to what the
same pilots earned in the same competencies with everybody else — which is the only comparison that
survives the fact that instructors do not get the same pilots."*

Second sentence, on the band: *"Nobody here is outside it. When somebody is, this is an invitation to a
standardisation conversation — not a finding against anyone, and the screen says so in those words."*

Say plainly: an instructor cannot open their own page here. The capability excludes the holder.

**Confirm at the rehearsal.** Sergio is the generator's planted strict examiner — `policy.yaml`
`history.patterns.strict_bias`, applied to one A320 examiner picked by the seed — so a regenerated
roster puts a different name here. Open `/instructors/analysis`, read the competency grid bottom-up for
the row furthest below the peer mean, and write that instructor and their figures into this section —
the same check §0 asks for on the crew.

## 7 · Roles, and who may do what (1 min) — built

`/admin/roles`: the role × capability matrix read from the database, with a scope on every capability.
Show that `operator_admin` is not editable, and that you cannot remove your own right to assign roles.
Then `/admin/users/<Andrea>`: her grant bound to **A320** — change it to *every fleet* and back with one
dropdown, in place.

Sentence: *"Permissions are rows, not code. A fleet binding narrows every screen at once, and nobody can
lock themselves out of their own administration."*

## 8 · Nothing is deleted, everything is logged (1 min) — built. Sign in as `admin_av`.

`/admin/audit` — filter to the last twenty minutes: the publish from §2, the signature and the
finalisation from §3, the grant change from §7. Note what is **not** there: a line per grade. Say why —
the grade rows carry who graded and when, so the log keeps the acts a reviewer looks for.

Then `/admin/tickets` in one sentence: an instructor reports a problem from any screen and it lands here.

Sentence: *"Nothing is deleted, and everything that matters is audited — including a signature that was
removed, and the reason given for removing it."*

## 9 · Close (0.5 min)

Back to §1. Two offers: a pilot with one fleet and their own programs; and the roadmap in §10, said as
roadmap and not as product.

---

## 10 · What is NOT in this demo, and what we say about it

Said out loud at the close, as the next phase — never implied to be working:

| Cut | State today | What we say |
| --- | --- | --- |
| **AI narrative with the provenance gate** | The deterministic core, the provenance checker and `analysis_runs` exist; there is no runs UI and the inference seam is in degraded mode | *"The analysis text is written by a model that may only narrate figures we computed. If it states a number the core did not produce, the report is rejected rather than shown. That gate is built; the screen that displays the runs is the next slice, and we will not demo a narrative we cannot yet prove to you."* |
| **QMS qualification dashboard** | Stub. Validity is shown per pilot on `/subjects/status` (§5) | *"Expiries are derived from records today, per pilot. The per-qualification-type dashboard is a view over the same data."* |
| **DMS library and ingestion** | Stub | *"Documents are the next module. The record's own PDF is already stored with the record."* |
| **Spanish** | English only | *"The vocabulary is configuration, so Spanish is a translation file, not a rebuild."* |
| **Dispatch / e-mail** | Alerts are queued in the database and read in the app (§1) | *"Notifications go where the work is. Mail is an integration we add when you tell us which system."* |

§1 is built, so the fallback it used to carry is gone. What is still open on **2026-09-21** is
whether the demo OPENS on `/analytics` or on `/subjects/status` — a manager's picture, or where every
pilot stands. Decide it then, not on the 27th.

---

## Build order for what remains (14 → 21 Sep)

1. ~~`/analytics` — the manager's landing (§1)~~ — **built** (13 Sep).
2. **Re-walk §2 to §8 on the machine, fixing what the walk finds. This is a build step, not a check.**
   §2 and §3 walked on 14 Sep; §4 to §8 still to walk. What the walk has found and fixed so far:
   the published inspector was empty and now carries the whole element read-only with the ICAO
   behaviours; one click on an exercise name renamed it instead of selecting it; the findings bar had
   no count in the header and three rules missing; **the second pilot of a crewed session could never
   sign**, because the content hash was stored per session and compared per pilot (migration 0153);
   every briefing and debriefing graded competencies on a different scale from the exercises, which
   no instructor could have delivered; and a page refused for a missing capability answered 500
   instead of saying so.
3. Rebuild the instance with the §0 sequence, so the corrected programs are the published ones, and
   re-walk §3 end to end on a crewed session: two records, two signatures, two hashes, two PDFs.
4. `docs/04_SEED_DATASET.md` still describes the Phase-0 fixtures; rewrite it to describe what
   `reset:clean` + `seed:history` actually produce, because it is what the rehearsal is set up from.
5. Then deployment (`docs/02_DEPLOY_PATH.md`), from 22 Sep, with the rehearsal on the 27th.

## Fixtures this script depends on

In the database after the §0 rebuild sequence:

- **Andrea Betancur** — CP, A320, base CLO, seniority 110, TRI; account `a.betancur` holding
  `instructor` bound to A320, created by hand and password-set that morning;
- **Pedro Marín** (CP, TRI) and **Javier Beltrán** (FO) — the crew of §3 and the subjects of §4,
  with a finalised EBT Module 2 Session 1 flown with Andrea on 2026-08-10, two records, both
  signed. §4 opens on Pedro;
- the Training Standards Manager account of §0, created before the rehearsal;
- 48 published programs, the EBT ones named **EBT Module 1/2 - Session 1/2 - <fleet>** by year, plus
  the LFUS sector program and the line check;
- three years of history: ~9,000 sessions and ~11,000 records, with the planted patterns the bench
  pages in §6 depend on — three declining pilots, a strict examiner, a lenient instructor, two
  instructors with an observable-behaviour habit;
- initial-training courses in progress, for the board in §5;
- the §3 session, created at set-up and dated the demo day, graded up to its last two exercises.

Nothing in this list is a real person, and no material from any other engagement appears anywhere in
this instance.
