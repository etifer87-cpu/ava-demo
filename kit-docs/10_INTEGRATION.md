# 10 · Integration layer

Purpose: every interface across the platform boundary, and what each one promises.
Status: spec + scaffolded (migrations 0120–0139)
Version: v1.0 · 2026-08-26

---

## 1. Principles

**API-first.** Everything an external consumer will use runs internally through the same contract
first. Integration is therefore proven inside the platform before it is exposed, and an outward API
is a permission change rather than a new codebase. The automation engine is a connector, never a
side channel with its own rules.

**Counterparties are roles, not products.** Every interface below is described by what the other
side *is* — the LMS, the crew-scheduling system, the identity provider, the BI tool, the external
consumer, the tablet client. Nothing in this kit names a vendor, and nothing in the schema encodes
one: `external_refs.system` is a configured code, not an enum.

**Calendar time here is driven by third-party access, not by coding.** Every planned interface below
is gated on someone else granting an export, an account or a firewall rule. Say so in any plan; a
schedule that assumes otherwise will be wrong by months.

**No design decision depends on an external API existing.** Every inbound feed has a manual and a
file-drop fallback, and manual rows always win over synced ones.

**The spine.** All of it hangs off one event chain:

```
session signed (ETR, human)
  -> record filed (DMS, automatic)
  -> completion certificate generated (DMS, automatic, restricted)
  -> qualification rules evaluated (QMS, automatic)
  -> grant alert raised (QMS, automatic)
  -> human approval -> qualification granted (QMS, human)
```

Each step is configurable as automatic or manual. The default is semi-automatic with human approval
at the grant, for the reason in `docs/08_QMS.md` §1.

Tables: `external_refs` · `sync_runs` · `api_keys` · `webhook_deliveries` · `dispatch_rules` ·
`dispatch_notices`. DDL in `scaffold/db/migrations/0120`–`0129`.

## 2. Common machinery

**`external_refs`** is the identity bridge: `(system, entity_kind, external_id) -> (local_table,
local_id)`, plus `natural_key`, `payload_hash`, `first_seen_at`, `last_seen_at`. Every inbound
record resolves through it. Nothing matches on a display name at write time.

**`sync_runs`** is one row per execution of any feed: `interface`, `direction`, `started_at`,
`finished_at`, `state ∈ running|succeeded|failed|partial`, `cursor_before`, `cursor_after`,
counts (`fetched`, `created`, `updated`, `held`, `skipped`, `failed`), `error`, `params JSONB`.
The cursor advances **only** when the load exits successfully, and it lives in this table — not in a
file inside a container, where a redeploy resets it.

**Idempotency** is a stored key per interface, unique where not soft-deleted. Re-running a feed must
be free. Two rules that are absolute:

1. **An inbound feed never updates and never deletes.** It inserts, or it holds. A re-run cannot
   lose data. Corrections are separate, deliberate, audited operations.
2. **Manual and imported rows are never overwritten by a later sync.** Every syncable row carries
   `source ∈ manual|import|ingest|external` and `external_ref_id`. A conflict goes to a
   reconciliation queue for a human to accept or reject, one difference at a time.

**Bulk reads paginate, always, with a key.** Two production incidents come from this: a row cap on a
list endpoint returning a partial roster so existing people looked new and the loader crashed on
duplicate keys; and offset pagination without a total ordering returning the same rows twice,
inflating a duplicate report by an order of magnitude. Use keyset pagination (`id > last`, ordered),
never offset, and never assume a `limit` parameter is honoured.

**Every interface degrades to a documented manual path.** Watched-folder file drop parsed into
proposed rows, or a paste-from-spreadsheet screen, with a human confirming. This is not a courtesy;
it is what allows the platform to go live before the counterparties do.

## 3. Interfaces

### 3.1 LMS course-completion feed

| Aspect | Detail |
|---|---|
| Direction | Inbound, pull |
| Transport | Scheduled job -> counterparty list/detail endpoints -> normalised JSON -> loader |
| Payload | course code, course title, subject external id, completion date, result, score, attempt, certificate reference |
| Consumed by | QMS `lms_course_completed` conditions; DMS certificate filing |
| Idempotency key | `(system='lms', subject_external_id, course_code, completion_date)` |
| Auth | credentials from `LMS_USERNAME` / `LMS_PASSWORD`, session established per run |
| Failure | run marked `failed`, cursor not advanced, alert raised; partial runs record what loaded |
| Backfill | `--since` with a bounded default window; a separate one-shot backfill run with an explicit range, which sets only null fields on existing rows |

Prefer credentials over any static cookie or token pasted into a schedule: an expired cookie breaks
the feed silently and looks identical to a permissions change.

Two authentication traps generalise beyond any one counterparty. First, origin, referer and
user-agent headers may be **mandatory**, and their absence can produce a server-side null reference
returned as 401 — indistinguishable from bad credentials, and the first hour of debugging goes to
the wrong place. Second, a session may not arrive as a cookie at all: the counterparty may return an
identity object in the body which its own browser client turns into cookies, and the feed has to
replicate that construction. Capture both in the connector's notes.

Payload rule: capture the **whole** record, not just the grades. Header fields, facility, instructor
identity, narrative sections and per-item detail all matter later, and a feed that skipped them
cannot be repaired without a full re-pull. Locate fields **by field type, not by section title** —
templates vary between courses and section titles are not stable.

**Hold, do not import**, and log the reason: a record whose subject and assessor are the same
person; a record with no task grades, no competency grades and no narrative. That filter removes
test rows while still admitting narrative-only records, which are real.

### 3.2 Crew-scheduling roster and experience feed

| Aspect | Detail |
|---|---|
| Direction | Bi-directional |
| Transport | Scheduled pull for roster and experience; scheduled push for status; file-drop fallback both ways |
| Inbound payload | roster duties, training duties, crew profile and external id, flight hours, sectors, landings, recency dates |
| Outbound payload | qualification status and expiry dates, suspended or restricted status, training-record completion, warnings for crew control |
| Consumed by | QMS `flight_experience` and `recency_window` conditions; the training plan |
| Idempotency key | `sector_hash = hash(subject_external_id, duty_date, flight_ref, departure, arrival)` |
| Auth | mutual TLS or a bearer credential from `SCHED_API_TOKEN`; outbound push carries an `api_keys` credential issued by the counterparty |
| Failure | reconciliation queue, not a retry loop; unresolved differences surface on a daily report |
| Backfill | bounded date-range pull producing proposed rows, each confirmed by a planner |

Scheduling stays in the crew-scheduling system. The platform does not duplicate rostering; it
consumes duty and experience facts and returns qualification truth.

**Daily reconciliation** is part of the interface, not an operational extra: successful and failed
updates, missing records, mismatched expiry dates, suspended qualifications, retry state, and an
automated cross-check of event date and asset registration with exception alerts.

The idempotency seam is designed manual-first: a planner can enter every sector by hand today; the
feed later proposes rows that carry `source='external'` and never overwrite a manual row.

### 3.3 Single sign-on

| Aspect | Detail |
|---|---|
| Direction | Inbound authentication |
| Transport | OIDC authorisation-code flow with PKCE against the corporate identity provider |
| Payload | id token: subject, email, groups or roles claim, org unit |
| Idempotency | `external_refs(system='idp', entity_kind='user', external_id=sub)` — the `sub` claim, never the email, which is reassignable |
| Auth | `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI` |
| Failure | fall back to local password login, which remains available for break-glass admin accounts |
| Backfill | a one-time match of existing users to identity-provider subjects by external id, reported as an exception list, never auto-matched by name |

Group claims **propose** roles; they do not grant them. A claim maps to a role only through a
configured mapping table, and platform capabilities remain resolved by the platform's own resolver.
Never let an external claim carry a capability. Multi-factor arrives with SSO; until then privileged
actions are protected by password re-authentication (`docs/17_GOVERNANCE.md`).

### 3.4 BI and warehouse export

| Aspect | Detail |
|---|---|
| Direction | Outbound, pull by the BI tool |
| Transport | a read-only database role reading the curated `av_*` view layer, or a scheduled file export of the same views |
| Payload | the analytics views only, never base tables |
| Idempotency | not applicable; the export is a full read of a deterministic view |
| Auth | dedicated read-only role with `SELECT` on the view schema and nothing else; credentials from `BI_READONLY_URL` |
| Failure | the BI tool retries; the platform is unaffected |
| Backfill | inherent — views are recomputed from source on every read |

The curated view layer is the contract (`docs/06_ANALYTICS.md`). Exposing base tables to a BI tool
makes every future migration a breaking change for someone else, and the platform loses the ability
to filter. Personal data in the export is minimised: identifiers, not names, wherever a figure does
not need a name. Restricted and hidden documents and any figure derived from them are excluded at
the view, not at the BI tool.

### 3.5 Outward REST API for external consumers

| Aspect | Detail |
|---|---|
| Direction | Inbound requests, outbound data |
| Transport | HTTPS, `/api/v1/*`, JSON, ISO-8601 UTC |
| Resources | `/subjects`, `/records`, `/qualifications`, `/expiry`, `/documents` — read first; writes only after a consumer needs one |
| Idempotency | writes require an `Idempotency-Key` header, stored per key with the first response, replayed on repeat |
| Auth | `api_keys`: 32 random bytes shown once, SHA-256 hash stored, scoped to capabilities and org units, with expiry and revocation |
| Failure | stable machine-readable error codes, documented rate limits, `Retry-After` on 429 |
| Backfill | cursor pagination with a stable ordering and an `updated_since` filter so a consumer can rebuild its own copy |

Hard rules:

- **No personal or sensitive data in a URL, ever** — not in a path segment, not in a query string.
  Identifiers are opaque; filters that name a person go in a POST body.
- Versioned from the first release. Additive changes within `v1`; anything breaking is `v2`.
- Every key is scoped. A key that can read everything is a finding.
- An **integration error dashboard** is part of the deliverable: failed messages, retry state, root
  cause, and a named owner per interface. The automation engine's execution log is the raw material,
  not the answer.

### 3.6 Tablet API and the offline sync contract

Base `/api/mobile`, JSON in and out, ISO-8601 UTC. `external_id` is the business key for people;
session and template ids are UUIDs; the internal user id appears only in the auth payload.
Additive-only within v1.

**Two-layer bearer auth.** The edge checks that every path except login carries a bearer token of
the right shape (401 `missing_bearer_token`); the route hashes it and looks it up, rejecting expired,
revoked and unknown tokens (401 `invalid_token`). On success the route receives a session object
**shape-identical to the web session** — that identity is what stops the two clients drifting.
Tokens are 32 random bytes, shown once, hash-only at rest, 30-day TTL. Refresh **issues the new
token before revoking the old**, so a failed refresh leaves the user logged in.

Endpoints: `POST /auth`, `/auth/refresh`, `/auth/logout` · `GET /templates?session_id=` (header,
roster, ordered elements, the framework's competencies and observable behaviours, grade and result
vocabularies) · `GET /my-sessions` (server-enforced to the caller's own assessor identity; a bare
array, empty when the caller has no person record) · `GET /subject-snapshot?subject_id=` ·
`POST /session-upload`.

**Upload idempotency and locking**, keyed on a client-generated `client_session_uuid`:

| Server state for this uuid | Result |
|---|---|
| none | create, **201** |
| exists, not signed or finalised, owned by the caller | re-sync: replace roster and grades, re-apply header, **200** |
| exists, signed or finalised | **409 `locked_on_server`** |
| exists, owned by another assessor, caller not privileged | **403 `forbidden`** |

A 409 on the client's own uuid is **not an error to surface**. It is the transition to local
read-only, and the client shows the record as signed. Corrections are server-side only: a manager
unsigns, the assessor edits the server copy online and re-signs. **An offline copy can never
overwrite an unsign.**

Race safety: creation is guarded by a unique index on `client_session_uuid`; the unlocked-update
write is a conditional statement whose filter carries the not-locked predicates, so the lock check
and the write are one atomic operation. Validation returns **422 `invalid_grades`** with a per-item
detail array, checked **before any write** — nothing persists on a 422.

**Sync policy:**

- **Push is automatic; pull is always explicit.** Completed records upload themselves whenever the
  device is online. Templates and snapshots are pulled only by a deliberate action before a session.
  There is no background pull, ever: a silent refresh mid-session is how an assessor loses work.
- **Signed and uploaded means local read-only.** The device keeps the record for reference and
  refuses every edit path.
- Per-session status is exactly three values: `synced` | `pending` | `conflict`. Conflict is
  surfaced in the UI even though the lock semantics make it near-impossible; a state that cannot be
  displayed cannot be diagnosed in the field.
- The offline store holds only pulled templates, pulled snapshots and locally drafted records
  pending upload. It is encrypted at rest and purged on successful sync or after a retention window.

**Visibility law — what a tablet payload never contains, for any role including admin:** concern
levels and overrides, watch-list membership, analysis reports, model-generated output, assessor
analytics, restricted notes, psychometric data. Restricted documents are filtered, and figures
derived from them are not leaked into a self-view.

Accepted debt to plan around: tablet uploads are data-only in v1, so the projected record has no
rendered file yet. Every read path degrades gracefully (404 for the file, nothing throws) and
everything the renderer needs is persisted so a later backfill can produce the PDF.

**Error model:** 400 malformed · 401 missing or invalid token · 403 not permitted · 404 not found ·
409 locked · 422 invalid grades · 500 server. Every body is `{"error": "<machine_code>", ...}` with
stable string codes. Codes are part of the contract and are never reworded.

### 3.7 Webhook delivery

| Aspect | Detail |
|---|---|
| Direction | Outbound push |
| Transport | HTTPS POST, JSON, one event per delivery |
| Payload | `{ id, event, occurred_at, data: { ... } }` — ids only, never a document body, never a grade narrative |
| Idempotency | the `id` is stable across retries; consumers deduplicate on it |
| Auth | HMAC-SHA256 of the raw body in a signature header, with the timestamp inside the signed string; secret per subscription |
| Failure | exponential backoff with jitter, bounded attempts, then `dead` and an alert; every attempt recorded |
| Backfill | consumers replay from the outward API with `updated_since`; webhooks are a notification, never the system of record |

`webhook_deliveries` records one row per event per subscription: `event`, `payload JSONB`,
`endpoint`, `attempts`, `queued_at`, `delivered_at`, `failed_at`, `next_attempt_at`,
`response_status`, `error`. `delivered_at` null with `queued_at` set is the queued state; that
single nullable timestamp is the whole delivery record.

Events published: `record.signed`, `record.unsigned`, `qualification.alert_raised`,
`qualification.granted`, `qualification.expiring`, `qualification.expired`, `document.approved`,
`document.expiring`, `sync.failed`.

### 3.8 Dispatch: internal notice delivery

`dispatch_rules` and `dispatch_notices` are the in-platform notification layer that the interfaces
above feed. A rule matches an event kind and a severity and names an audience by capability and
scope; a notice is one addressed instance of it.

Severity vocabulary, used identically here and in every rules engine in the platform:

| Severity | Meaning |
|---|---|
| `hard` | blocks the action (publish, progression, session creation) |
| `soft` | warns, allows, records the reason |
| `consent` | blocks until a matching live attestation exists — not soft, because publishing past it silently would be wrong; not hard, because it is permitted with agreement |
| `info` | never blocks |

A **disabled rule is still computed and still displayed as information**. That is how a
not-yet-mandatory minimum stays visible and accrues evidence before it becomes binding.

Two storage rules: a notice is **stored for its addressee whether or not that person has a login
yet**, so nothing is lost when accounts are provisioned later; and channels are pluggable, with
in-app built and outbound channels (mail, calendar feed) deliberately deferred behind the same
delivery record. `dispatch_notices` carries `queued_at` / `delivered_at` / `failed_at` / `attempts`
for the same reason `webhook_deliveries` does.

## 4. Traps

Each of these also appears in `docs/16_TRAPS.md`.

**Assuming a list endpoint returns everything.** What happens: a roster read silently returns the
first page, existing people look new, and the loader dies on duplicate keys — or worse, creates
duplicates. Why: a server-side row cap that ignores the requested limit and reports no error. What
to do instead: every bulk read paginates by key, and the loader asserts that the count it processed
matches the count the run claims.

**Offset pagination without a total ordering.** What happens: rows are returned more than once and a
duplicate report inflates by an order of magnitude, sending someone hunting a data-quality problem
that does not exist. Why: without an ORDER BY the server may reorder between pages. What to do
instead: keyset pagination on a unique ordered key.

**A cursor stored inside the container.** What happens: a redeploy resets the checkpoint and the
feed re-fetches the entire backlog, or skips a window. Why: a file written next to the script. What
to do instead: the cursor is a column in `sync_runs`, advanced only after a successful load.

**A sync that updates.** What happens: a re-run overwrites a corrected record with the counterparty's
stale copy, and the correction is gone with no trace. Why: an upsert written for convenience. What to
do instead: inbound feeds insert or hold; manual and corrected rows carry `source` and are excluded
from sync writes; conflicts go to a reconciliation queue.

**Matching people by name.** What happens: two people with the same name merge, or one person with a
changed name splits into two records, and grades land on the wrong subject. Why: the external id was
missing on some rows and name matching was the fallback. What to do instead: `external_refs` and the
external id; unmatched rows are held and reported, never guessed. Normalise homoglyphs and collapse
double spaces on import, or one code silently splits into two.

**Mandatory headers absent, reported as 401.** What happens: hours spent on credentials that are
correct, because the counterparty's null reference surfaced as an authentication failure. Why: the
server assumed browser-supplied headers. What to do instead: send origin, referer and user-agent on
every connector call, and record in the connector notes which of them the counterparty requires.

**A background pull on a tablet.** What happens: a refresh lands mid-session and replaces the
template or the roster under an assessor who is part-way through grading. Why: the pull was made
automatic for symmetry with the push. What to do instead: push automatic, pull explicit, and a
visible "last pulled" timestamp.

**Treating a 409 as a failure on the tablet.** What happens: the client shows an error and retries
forever against a record that is correctly locked, and the assessor believes their work is lost.
Why: 409 was mapped to the generic error handler. What to do instead: on the client's own uuid a 409
is the transition to local read-only, displayed as "signed on the server".

**Personal data in a URL.** What happens: names and identifiers land in access logs, proxy logs,
browser history and third-party error reporting, outside every retention rule the platform enforces.
Why: a GET was easier than a POST. What to do instead: opaque ids in paths, filters in bodies, and a
route-level check that refuses to build a URL containing a name field.

**Webhooks treated as the system of record.** What happens: a consumer misses a delivery during an
outage and its copy is permanently wrong, with nothing to reconcile against. Why: no replay path.
What to do instead: webhooks notify; the outward API with `updated_since` is the source of truth, and
that is stated in the consumer documentation.
