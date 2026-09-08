# 03 · Demo script — fifteen minutes with Avianca Training

This script is the build specification. Every screen it names is built; every screen it does not
name is not. Each step lists what is on screen, the one sentence that carries it, and the slice
that produces it. Timings are targets for the rehearsal.

Audience: Head of Training, Training Standards, Fleet chief pilots. Presenter: Esteban.
Persona logged in: **Camila Restrepo — Training Standards Manager** (role `training_manager`).

---

## 0 · Before the room (not shown)

- `npm run reset` on the server the morning of the demo; `npm run smoke` green; `/api/health` shows
  `inference: hosted` with the API key set for the day, `subjects: 48`.
- Local fallback running on the laptop at `http://localhost:3100`, same seed.
- Browser tab pre-opened through Cloudflare Access, already signed in.

## 1 · Landing — the fleet at a glance (1 min) — slice: Analytics overview

On screen: Avianca-branded header, fleet overview — subjects by fleet (A320 · A330 · B787), screening
bands (standard / monitor / attention / priority / insufficient), qualification expiries in 30 days,
last analysis run. Language toggle EN/ES visible top-right.

Sentence: *"Every figure on this page is computed from signed training records. Nothing here was typed
in, and nothing here was written by an AI."*

## 2 · Program Builder — authoring a programme (3 min) — slice: Builder

Open **Programmes → A320 EBT Recurrent · Module 3** (published v2). Show the canvas: phases,
events, the malfunction grid. Click one event → the inspector shows its competency targets and
observable behaviours from the ICAO catalogue. Add a target to an event (the competency picker).
Run compliance → one finding appears, click-to-locate. **Publish as v3** → password re-auth → the
version is immutable; v2 records are untouched.

Sentence: *"Your programme is data, not a PDF. When you change it, the records already signed
against the old version do not move."*

## 3 · ETR — grading and signing a session (4 min) — slice: ETR grading + sign + PDF

Switch persona to **Instructor Andrés Mejía** (`view as instructor`). Open today's session for
**FO Valentina Ochoa**, A320 EBT Recurrent v3. The grading screen shows one event at a time:
observable behaviours ticked, competency grade proposed from the three dimensions, instructor
confirms or overrides. Grade two events, one with a non-standard outcome. **Review & Sign** →
content hash shown → sign. The record freezes. **Export PDF** → the signed record renders.

Sentence: *"The instructor decides; the system proposes and remembers why they disagreed. Once
signed, the record cannot change, and the PDF is the signed page, not a second document."*

## 4 · Subject profile — one pilot over time (2 min) — slice: Analytics subject

Back as Camila. Open **Valentina Ochoa**: KPI tiles, competency radar (nine spokes), trend
sparklines, record list with today's session at the top, screening band `monitor` with the reason.

Sentence: *"This is the same nine-competency model your regulator uses, and every band has a
threshold you can see and change."*

## 5 · Analysis — narrative that is checked (2 min) — slice: AI narrative

Open **Analysis → Valentina Ochoa**. Show three runs: one **complete** (provenance 1.000, every
figure cited), one **pending**, one **rejected** — the narrative named a number the deterministic
core never produced, and the gate refused it. Open the complete one; hover a figure → its source.

Sentence: *"The model only narrates. If it says a number we did not compute, the report is
rejected — you will never read an invented figure."*

## 6 · QMS — qualifications and expiries (1.5 min) — slice: QMS dashboard

Open **Qualifications**. Expiries grouped per qualification type, filter by fleet **B787**, sort by
days remaining. Click one definition (**A320 Line Check**) → its rule in plain language and the
pilots it currently applies to.

Sentence: *"Expiry is derived from records, not typed into a spreadsheet — when a check is signed,
the expiry moves by itself."*

## 7 · DMS — documents and ingestion (1 min) — slice: DMS

Open **Documents**. Library grouped by type (manuals, regulatory, training records). Upload
`Avianca_EBT_Programme_Manual_v1.pdf` (synthetic) → status `pending` → `embedded`, chunk count
shown. Show one record document linked to the signed session from step 3.

Sentence: *"Every document that entered the system has a status you can see, and every record
knows which documents it came from."*

## 8 · Governance — who did what (0.5 min) — slice: Platform

Open **Audit**. Filter to the last 15 minutes: the publish, the signature, the upload. Roles list.
Toggle **ES** → the header and navigation switch; note that full translation is a roll-out item.

Sentence: *"Nothing is deleted, everything is audited, and it already speaks Spanish."*

## 9 · Close

Return to the landing page. Offer: a pilot on their own programme documents.

---

## Build implications (in build order)

1. Analytics overview + subject profile — kit shell already has subject list/profile; add fleet
   overview tiles and the expiry tile.
2. Program Builder — canvas, inspector, competency picker, compliance findings, publish with re-auth.
3. ETR grading screen, review & sign with hash, freeze, PDF via headless Chromium.
4. AI narrative — analysis runs table, three seeded states, provenance gate visible.
5. QMS dashboard + one definition view.
6. DMS library + upload + status.
7. Audit view, roles, EN/ES toggle, brand.

Data the script depends on (see `04_SEED_DATASET.md`): Camila Restrepo, Andrés Mejía, Valentina
Ochoa; programme *A320 EBT Recurrent · Module 3* at v2; three analysis runs in three states for
Ochoa; B787 expiries within 30 days; the synthetic manual PDF.
