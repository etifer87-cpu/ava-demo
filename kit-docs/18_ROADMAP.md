# 18 · Roadmap

Purpose: the order to build in, and what each phase is finished by.
Status: spec
Version: v1.0 · 2026-08-26

Phases are decision-gated, not date-gated. A phase ends when its gate passes, and the gate is a
demonstration, not an opinion.

---

## Phase A — foundations

Database, framework, roles and capabilities, auth, audit, config, the app shell, the seed and
synthetic layers, the verification gate.

**Gate:** `npm run reset` ends green on an empty database; the smoke sweep fetches every route and
every subject page; a viewer with a restricted role sees a navigation that omits — not disables —
what they cannot do.

## Phase B — assessment (ETR)

Template builder, session create and grade, signature and freeze, the record report, import.

**Gate:** an author publishes a template version; an assessor grades a session against it including
a repeat attempt; both parties sign; the record freezes with a snapshot; the report renders
identically on screen and in PDF; an import of the same record shape lands in the same tables and is
indistinguishable downstream.

## Phase C — analysis

The `av_*` layer in the product: dashboards, the subject profile, cohort comparison, assessor
standardisation, the narrative analysis with its provenance gate.

**Gate:** every figure on every screen traces to a view; the narrative is refused when it names a
number the deterministic core did not produce; a band that has never occurred is visible as
"insufficient", never as a zero.

## Phase D — compliance (QMS + DMS)

Qualification definitions and the six-step builder, the pure evaluation engine, approvals and
attestations, expiry and alerts; the document store, versions, review, retention.

**Gate:** a definition is authored, previewed against a real population, published with a change
note and a password confirmation; rules being met raises an alert and grants nothing; an approval
supersedes cleanly; a document expiring moves a qualification's status with no code change.

## Phase E — connections

The LMS feed, the crew-scheduling feed, SSO, the outward REST API, the BI export, the mobile/tablet
client and its offline sync contract, dispatch notifications.

**Gate, per interface:** an idempotent replay of a day's feed changes nothing; a conflicting mobile
push is refused rather than merged; every outward call is authenticated, rate-limited and audited.

**This phase is calendar-gated by other people's APIs, not by engineering.** Plan it as such: the
integration work is small and the access negotiation is not.

## Phase F — offline and scale

Tablet offline capture, background sync, and whatever the population growth demands: monthly
roll-ups instead of live aggregation, a read cache in the request path, jobs on a scheduler.

**Gate:** a device that has been offline for a week syncs without a conflict; the roster page
answers under a second at ten times the seeded population, with results identical to the live
computation to four decimal places.

---

## Sequencing rules

1. **Finish vertical slices, not layers.** Schema, library, route, screen, smoke check, doc update.
2. **Never build two modules at once.** The temptation is strongest exactly when the first one is
   almost done.
3. **A phase gate that cannot fail is not a gate.** Write the demonstration before the code.
4. **Retire the synthetic population from an environment the moment it holds real records.**
