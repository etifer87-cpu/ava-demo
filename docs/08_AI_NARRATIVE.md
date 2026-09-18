# 08 · The AI narrative — decided architecture

Written 2026-09-15, as a decision record rather than a build. Nothing here is implemented yet, and
nothing here is in the 2026-09-29 demo: `docs/03_DEMO_SCRIPT.md` §10 lists the narrative as the first
cut, and the sentence we say out loud is that the gate is built and the screen is not. This document
exists so that when it IS built, the shape is already argued rather than improvised.

The kit's own specification is `kit-docs/11_AI_PIPELINE.md`. This file records where we depart from it
and why. It is also written to sit under the Corvanox Sovereign AI platform (CSA) rather than beside
it: where the two overlap, CSA's design principles win, and they are quoted where they do.

---

## 1 · The invariant, unchanged

**The deterministic core computes every figure. The model never computes, it only selects and
narrates. Every number that reaches a screen was produced by SQL or by a pure function, and can be
recomputed from the records.**

This is not a stylistic preference. Grades, indices, thresholds and alerts are the basis of decisions
about a pilot's licence privileges, and a regulator is entitled to ask how any of them was arrived at.
"A model said so" is not an answer. `lib/provenance.ts` is the enforcement, not the intention.

## 2 · Findings, not prose — the decision that matters most

**The model returns structured findings. The application renders the sentences.**

```
{ claim, competency, figures_cited[], severity, evidence_record_ids[] }
```

The model does the part only it can do: deciding what, in this pilot's figures, is worth a training
manager's attention, and how the pieces connect. The product does the part it must own: the words, the
house style, and the operator's vocabulary from `policy.yaml`.

Everything improves at once, which is how you know it is the right cut:

- **Quality.** A model asked to "write an analysis" drifts, editorialises and occasionally invents. A
  model asked to "return the three most notable findings and the figures supporting each" is doing
  classification, which it is far better at.
- **Speed.** Short structured outputs return in a second or two. There is no long generation to wait
  through, and nothing to stream just to hide latency.
- **The gate becomes exact.** Figures are DECLARED per finding rather than extracted from prose with a
  regex. `checkProvenance` stops being a text scanner and becomes a set comparison: no false
  rejections of correct reports, no near-miss matches on a number that happened to appear in a date.
- **Consistency.** The same figures produce the same report. A manager who reloads and sees different
  wording stops trusting the system. That is a quality requirement, and it is the real reason runs are
  keyed to a hash of their inputs — not to save a call.

## 3 · One call per question, run concurrently

Not one long call that writes everything. One call per analytical question — the trend, the competency
profile, instructor consistency, the recommended action — each given ONLY the figures that question
needs, all fired in parallel and assembled afterwards.

Four short focused calls beat one long one on latency and on accuracy, because a small prompt with a
small figure set has far less to go wrong with. It also means one weak answer can be re-run alone.

## 4 · The strongest model available, everywhere

No fast/deep tiering. Tiering is a cost optimisation and cost is not the constraint here; judging what
matters in a pilot's training history is exactly where model quality shows. `lib/inference.ts` keeps
both tiers because the seam is general, but the narrative uses the deep one.

"Available" matters, because the platform direction is a self-hosted open-weight model (see *Where it
runs*). An open-weight model in the 7-30B range is materially worse than a frontier model at writing
polished prose, and very nearly as good at returning a short structured judgement. That is not a
compromise forced on §2 - it is the second reason §2 is right. The architecture that produces the best
report from a hosted frontier model is the same one that survives being run on the customer's own
hardware.

## 5 · Verify rather than hope

A second pass checks each finding against the figure set independently of the pass that produced it.
Where two runs disagree about what is notable, that disagreement is surfaced to the training manager
rather than resolved silently — it is the most honest signal available that a case needs a human.

## 6 · Generated eagerly, never on the read path

A narrative is an artefact, not a page render.

- On finalisation of a record, the affected pilot's run is enqueued.
- A nightly pass covers the fleet.
- Every screen reads a stored run and renders instantly.
- A manager who presses "analyse now" gets a run queued at the front, with findings streamed in as
  they arrive.

Speed comes from the work already being done, not from the model being quick. It also means a slow or
unreachable endpoint degrades to "no narrative yet" instead of a spinner in front of a customer.

## 7 · Keyed to a hash of the inputs

The figure set is hashed; a run is stored under that hash. Same figures, same run, returned without
calling anything. The reasons are consistency and auditability first: a report that changes wording
between two readings of the same data is worse than no report.

## 8 · The payload is minimised and pseudonymised

Competency codes, figures, and dates. No names, no employee numbers, no licence numbers, and no
free-text remarks unless a finding genuinely needs them. Smaller is faster and safer, and it makes the
gate stronger: a model given only figures has less to invent from.

This is a requirement, not a nicety. Colombian habeas data (Ley 1581) governs the pilots in this
system, and an external inference endpoint is a transfer.

## 9 · The gate decides storage, not display

A rejected run is STORED, with its reason and its raw response. Rejected runs cost nothing to keep and
they are the evidence that the gate works — the thing to show a regulator, and the thing that makes
the claim credible instead of asserted. A run that was rejected is never rendered as a report.

## 10 · Anything that enters a record is a draft until a human approves it

A narrative displayed beside the figures is an observation. A narrative that becomes part of a
training record, or that is attached to a recommendation acted on, is a document about a pilot's
competence, and a person puts their name to it. The approval is explicit, recorded with the approver
and the time, and the unapproved draft is never printed, exported or shown to the pilot.

## 11 · Degraded is a supported state

Already true in `lib/inference.ts`: no endpoint configured, or an endpoint that cannot be reached,
returns a value the caller handles rather than an exception. Every figure, chart, table and export
still renders. The narrative is simply absent, and the screen says so.

---

## Where it runs

**The inference seam stays in the application.** `lib/inference.ts` is called directly: one
deployment, one language, one set of types, one thing to secure and to version at every airline that
installs this.

**A workflow orchestrator is a reasonable tool and an unreasonable dependency.** It earns its place when
non-developers need to edit a flow, or when a pipeline spans systems the app has no business knowing
about. For a product shipped to several operators, a second runtime is a second thing to install,
patch, back up, explain in a security review, and keep in step with the schema. If a queue is wanted
later, Postgres already holds one well at this volume.

The exception worth keeping open: **document ingestion**, if an operator ever needs training records
extracted from PDFs rather than created in the app. That is a genuinely different problem — file
handling, retries, partial failures — and the case for a workflow runner is much stronger there than
it is for narration.

**Local by default, hosted by exception.** The platform direction is the Corvanox Sovereign AI
platform (CSA): application, database and inference on the customer's own server, open-weight models
behind an OpenAI-compatible endpoint, nothing leaving the customer's infrastructure. `lib/inference.ts`
is already built to that contract - it speaks OpenAI-compatible over `LLM_BASE_URL` and nothing above
it knows the vendor - so pointing it at a CSA gateway rather than a hosted API is an environment
change and not a code change.

That inverts what an earlier draft of this document said. A hosted frontier model does write better
prose, but "your data never leaves your server" is the product's central claim, and a narrative
feature that quietly breaks it is worth less than the claim it costs. So: **local is the default**, and
an external endpoint is an admin-gated, per-task exception for non-sensitive workloads, with the
payload pseudonymised as in §8 - which is how CSA already describes it, off by default.

The quality gap is real and is handled by §2 rather than argued away: ask a local model for findings,
not for prose.

---

## Open questions

- **Which model, and hosted or local.** Decide with a real key and a real figure set, not in advance.
- **CSA, and how much of this it absorbs.** The Corvanox Sovereign AI platform (concept approved
  2026-07-25) already specifies a gateway carrying routing, guardrails, an audit log, a prompt library
  and tool execution, plus pgvector for RAG and per-customer LoRA adapters. Several things in this
  document are candidates to live there instead of here: the fan-out of §3, the verification pass of
  §5, and the prompt library. Two things are NOT candidates and stay in this application whatever CSA
  does - the deterministic core of §1, and the provenance gate of §9 - because they are what the
  regulator is shown, and they belong to the record rather than to the assistant. The house style of
  §2 is a third possibility: templates now, a LoRA adapter trained on approved reports later, which is
  CSA's own capability 5.
- **RAG over the operator's own manuals.** Not in this document at all, and a real gap: a
  recommendation assembled from the operator's own procedures is worth more than one written from
  general knowledge. CSA capability 4 describes it. Worth a section here once CSA has a shape.
- **Prompt as configuration.** The intent is `config/narrative.yaml`, versioned like `policy.yaml` and
  recorded on each run, so "why did this read differently in March" is answerable and a prompt change
  is a reviewable diff rather than a deploy. Not yet designed.

## Not in scope

Anything that would let the model write a grade, move a threshold, or change a record. It narrates
what the core computed, and it is checked before it is stored.
