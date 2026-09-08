# 09 · DMS — document management

Purpose: where evidence lives, who may see it, how it is versioned, and how it leaves.
Status: spec + scaffolded (migrations 0080–0099)
Version: v1.0 · 2026-08-26

---

## 1. Scope

DMS owns the file and its metadata. It does not grade (ETR) and it does not decide authorisation
(QMS) — it is the evidence store both of those reason over. Fed by ETR (signed records, generated
certificates), by direct upload, and by ingestion (`docs/10_INTEGRATION.md`). Read by QMS through
`document_valid` conditions.

Rules that hold everywhere in this module:

- **The database holds metadata and a relative path; the bytes live on a storage root.** One env
  var, `DMS_STORAGE_ROOT`, is the only absolute path in the system. Host or residency migration is
  then an environment change, not a code change — which is what makes a residency commitment
  credible.
- **No absolute path is ever hardcoded, and no path ever reaches the client.** Files are served
  only through a route that resolves the path server-side from a document id.
- **No hard delete, anywhere.** Every delete path moves the object to the retention store and sets
  `deleted_at`. There is exactly one implementation of that move and no direct unlink call exists
  in the codebase.

Tables: `doc_folders` · `documents` · `document_versions` · `document_access` · `retention_rules`.
DDL in `scaffold/db/migrations/0080`–`0086`.

## 2. Folder taxonomy

Two scopes, one table.

| Scope | `owner_kind` | Rooted at | Example |
|---|---|---|---|
| Subject-scoped | `subject` | one folder tree per person in `people` | a subject's licences, simulator records, certificates |
| Library-scoped | `library` | one tree per org_unit or global | manuals, syllabi, forms, policy, authority correspondence |

A subject tree is created idempotently when the person record is created, from a **single seeded
skeleton** in `retention_rules`-adjacent config (`scaffold/config/dms_taxonomy.yaml`), never by ad
hoc `mkdir` at upload time. Every folder carries `path_template` and `slot_key`; year folders are
created on demand from the record's **own event date**, never the ingestion date.

Recommended subject skeleton, expressed as slots rather than an operator's own labels:

```
{subject_key}/
  personal/                  identity, contracts, correspondence
  licences/                  licence, medical, language proficiency, ratings
  simulator/{check_kind}/{YYYY}/
  line/{YYYY}/
  ground/{YYYY}/
  crm/{YYYY}/
  qualifications/{category}/            + /archive/   + /rejected/
  reports/{YYYY}/
  inbox/                     upload staging and anything unrouted
  retained/                  the only destination of a delete
```

**Routing** maps an incoming document to a slot by matching on its declared type, then on the
session template code, then on extracted text, in that order, case-insensitively. Two rules:

1. **The most specific matcher wins and is tested first.** Where one document can satisfy two check
   kinds, the combined form files under the more specific of the two, once, and the routing table
   is ordered so that this is not left to regex luck.
2. **Anything unrouted lands in `inbox/` and raises a warning.** It must never fail silently and it
   must never be dropped. The absence of that warning is how files sit stranded in staging for
   weeks with a null path.

Filing is configuration: `retention_rules` and the taxonomy config drive slots per record class and
per population, so a second population (cabin crew, dispatch, operations control) gets its own
template set without code. A change to a `path_template` requires a documented one-time re-filing
pass; it is not applied lazily, or the estate ends up in two layouts at once.

## 3. Metadata

`documents` columns, all of them deliberate:

| Column | Purpose |
|---|---|
| `subject_id` / `org_unit_id` | exactly one is set, matching `owner_kind` on the folder |
| `folder_id` | resolved slot |
| `doc_type` | catalogue code, referenced by QMS `document_valid` conditions |
| `record_class` | drives retention: `training`, `medical`, `licence`, `certificate`, `report`, `correspondence`, `submission` |
| `issuing_authority`, `certificate_number`, `issued_on`, `valid_from`, `valid_until`, `limitations` | evidence facts, all nullable |
| `file_name` | canonical generated name, built **server-side** at ingestion |
| `storage_key` | relative to `DMS_STORAGE_ROOT`, forward slashes, never absolute, never sent to a client |
| `checksum_sha256`, `byte_size`, `mime_type` | integrity and dedup |
| `version_no` | current version number; the full history is in `document_versions` |
| `review_state` | `draft`, `pending`, `approved`, `rejected`, `superseded` |
| `finding_state` + `open_finding_count` | the paired status/count columns of §8 |
| `is_restricted` | hidden from the subject and from assessors; visible to records roles only |
| `legal_hold_at`, `legal_hold_reason`, `legal_hold_by` | see §7 |
| `retention_rule_id`, `retain_until` | computed at approval from `record_class` |
| `deleted_at`, `deleted_by`, `retained_key` | soft delete; `retained_key` is where the bytes went |
| `created_at`, `created_by`, `source` | `app` / `import` / `ingest`, matching `records.source` |

Canonical file name, built server-side from the document's own facts, never supplied by a client or
by an automation workflow: `{yyyy_mm_dd}_{doc_type}_{subject_key}[_{n}].{ext}`. The date is the
event date. The `_{n}` suffix is a collision counter, not a version.

## 4. Versioning and supersede

`document_versions` is append-only: one row per stored byte-stream, with its own `storage_key`,
`checksum_sha256`, `version_no`, `created_at`, `created_by`, and `supersedes_version_id`.

Approving a replacement is a supersede, not an overwrite:

1. The new upload is a `document_versions` row on the **same** `documents` row.
2. `documents.version_no` increments; the current pointer moves.
3. The previous version's bytes move to the folder's `archive/` slot. They are never deleted.
4. `qms_events(kind='superseded')` and an `audit_log` row are written in the same transaction.
5. Any QMS holding backed by the document is updated **in place**; it is not re-granted, and its
   approval history is untouched.

A rejected upload moves to `rejected/` with a mandatory `reject_reason` and stays visible in the
timeline. Rejection is evidence too.

## 5. Review, approval, expiry

Review is a configurable chain, defaulting to one level: `draft -> pending -> approved | rejected`.
Multi-level chains are expressed as ordered `document_access` rows with `role`/`capability` and a
step index; the chain is data, not code, for the same reason QMS approvals are.

- The approver holds `dms.documents.approve` at a scope that includes the subject.
- The approving user's own password is re-verified server-side on approval of a `medical`,
  `licence` or `certificate` class document. Fail closed, 403. See `docs/17_GOVERNANCE.md`.
- Approval computes `retain_until` from the matching `retention_rules` row and freezes it on the
  document. A later change to the rule does not silently move the retention date of records already
  approved under the old one.

**Expiry** is a document fact, not a status: `valid_until` plus the class's warning lead time.
A scheduled evaluation reads it and raises a QMS expiry alert; the document itself does not carry
an "expired" flag, because expiry is a function of the current date and derived on read for the
same reason qualification status is (`docs/08_QMS.md` §6).

**Certificates** are generated documents: one template per session template, populated from the
record's own fields, rendered by the headless PDF service, filed into the certificate slot with an
automatically-issued unique `certificate_number`. Completion certificates are **restricted by
default** (`is_restricted = true`): visible to records roles and the authority, never to the
assessor or the subject, on any surface including the tablet API. That restriction is a policy
hard-gate — the capability that reads them is `is_overridable = false` and an attempt to grant it
by per-user override is refused.

## 6. Ingestion, chunking and retrieval

Ingestion path: upload or feed lands in `inbox/` -> extraction produces `doc_type`, event date,
title and, where relevant, subject match -> the server builds the canonical name, **moves** the
file to the routed slot, and writes the name, `storage_key`, `checksum_sha256` and metadata in a
**single statement**. The response states explicitly whether the metadata write persisted; a
write-back failure must be visible in the run log, not inferred later from a null path.

Automation authenticates with an internal-token header checked at the edge, never with a user
session or cookie. The most consequential ingestion failure on record is that header missing on the
rename call: every ingested file stranded in staging with a null path, silently, for weeks.

**Chunking for retrieval** (library-scoped documents, and any subject document explicitly enrolled):

| Step | Rule |
|---|---|
| Extract | text plus page/section anchors; a scanned page with no text layer is OCR'd, and its chunks are marked `is_ocr` so a retrieval answer can say so |
| Chunk | semantic sections first, falling back to ~800-token windows with ~15 percent overlap; never split a table row or a numbered procedure step across chunks |
| Key | every chunk carries `document_id`, `version_no`, `slot_key`, page anchor and `checksum_sha256` of its source version |
| Version | chunks belong to a **version**, not to a document. A supersede re-chunks and retires the previous version's chunks; it never edits them in place |
| Scope | retrieval is filtered by the caller's effective document visibility **before** the search, never after. A restricted or subject-scoped document must not be reachable through a library query |
| Cite | every retrieved passage returns document id, version, page anchor. A retrieval answer with no citation is not shown |

Embeddings and the index live outside these tables and are treated as a rebuildable cache: they
carry the source checksum, and a checksum mismatch invalidates rather than serves.

## 7. Access control, retention, legal hold, deletion

**Access.** Scope resolution is the platform resolver (`docs/12_ROLES_AND_PERMISSIONS.md`), not a DMS
invention. `document_access` carries explicit grants and denials per document or folder, per role
or per user, optionally time-boxed. Three rules worth stating in this module:

- Files are served only through the resolving route. Storage keys never leave the server.
- **Export is a separate capability from view**, with no `own` carve-out: a subject or an assessor
  who may read a document on screen may not download or export it. Bulk cross-person export is a
  further, admin-only capability.
- Restricted documents are filtered server-side on every surface, including the tablet API and
  including any derived figure. A grade point sourced from a restricted document must not leak into
  a chart a subject can see.
- Every read of a `medical`, `certificate` or restricted document writes an access row. Access
  logging is a requirement for these classes, not an option.

**Retention.** `retention_rules(record_class, min_retain_months, max_retain_months, basis, legal_ref,
review_required, effective_from)`. `basis` is what the clock starts from: `issue`, `expiry`,
`separation` (the subject leaving the organisation), or `event`. A rule is versioned by
`effective_from`; documents freeze their `retain_until` at approval.

**Legal hold** overrides retention in one direction only: while `legal_hold_at` is set, nothing may
be purged, superseded out of reach, or moved out of the retention store, and `retain_until` is
ignored. Setting and clearing a hold both require a reason and are audited. A hold on a subject
propagates to every document owned by that subject.

**Deletion is a move.** One shared implementation, used by every path — single delete, batch delete,
record delete, session delete, whole-subject removal:

1. Refuse if a legal hold is set.
2. Move the bytes to the retention store, key `retained/{yyyy}/{mm}/{document_id}_{file_name}`,
   collision-safe.
3. Set `deleted_at`, `deleted_by`, `retained_key`. The row stays; every FK stays valid.
4. Write `audit_log` with the actor, the subject, the original slot and the reason.
5. Removing a whole subject moves the entire tree to a retained subject archive. The person row is
   soft-deleted; child rows are removed in FK-safe order, sequentially and fail-loud, so a partial
   failure aborts before the parent goes.

**Physical destruction is deliberately outside the application**: a policy-gated manual action
against the retention store, with a written cadence and a named authoriser. That is a decision, not
an omission — but the cadence and the authorisation must be written down or it becomes an audit
finding. Erasure requests are therefore a two-step answer (application removal, then policy purge)
and the tension with the no-hard-delete rule has to be documented, not improvised.
See `docs/17_GOVERNANCE.md`.

## 8. Status must never contradict its count

A status column and a count column that describe the same thing will drift. In this module the pair
is `documents.finding_state` (`clear` | `open`) and `documents.open_finding_count`. The invariant is
symmetric:

```
finding_state = 'clear'  <->  open_finding_count = 0
finding_state = 'open'   <->  open_finding_count > 0
```

Enforcement is a **deferrable constraint trigger** (`0086_dms_status_count.sql`) that fires on
insert and on update of **either** column and raises in **both** directions:

- a status of `clear` with a positive count raises `status_contradicts_count`;
- a status of `open` with a zero count raises the same error.

Deferrable and initially deferred, so a transaction that legitimately writes the two columns in two
statements commits, while one that leaves them inconsistent at commit time fails. A `CHECK`
constraint would work for the same pair, but a constraint trigger is used because it can be
deferred, it names the invariant in the error, and the same function is reused for any further
status/count pair added later. Never fix a contradiction by trusting one side and rewriting the
other in application code: recount from the source rows inside the same transaction.

## 9. Traps

Each of these also appears in `docs/16_TRAPS.md`.

**A status column drifting from its count.** What happens: a document shows clear while two findings
are open against it, and the compliance figure derived from the status is wrong in a direction
nobody notices. Why: two writes, one transaction, one of them conditional. What to do instead: the
deferrable constraint trigger of §8, checked in both directions, and recount from source rows rather
than repairing one column.

**The rename call without its internal-token header.** What happens: ingestion appears to succeed,
the file is moved, and the metadata write silently 401s. Files accumulate in staging with null paths
and nobody notices until a retrieval fails weeks later. Why: automation authenticates differently
from a browser and the header is easy to omit on one call out of five. What to do instead: the
move and the metadata write are one server-side operation returning an explicit persisted/failed
result, and the run log records which.

**Unrouted documents failing silently.** What happens: an unmapped type is dropped or filed flat
with no warning, and the estate quietly develops a shadow inbox. Why: a routing table with no
default branch, or a default branch that logs at debug level. What to do instead: unrouted lands in
`inbox/`, raises a warning-level event, and appears on the records dashboard as a count.

**Hardcoded absolute paths.** What happens: a host migration or a residency change becomes a code
change, and a residency commitment stops being credible. Why: one convenience constant in one
module. What to do instead: `DMS_STORAGE_ROOT` and relative `storage_key`, with a traversal-proof
join used by every path-building call.

**A path reaching the client.** What happens: an id-based fetch is replaced by a path-based one for
convenience and the storage layout becomes part of the public API surface, traversal included. Why:
the path was already in the row the API returned. What to do instead: `storage_key` is excluded from
every select list that serves a client, and files are fetched by document id through the resolver.

**Hard delete anywhere.** What happens: one unlink in one batch path destroys evidence that a
retention rule or a legal hold required. Why: the shared soft-delete helper was inconvenient in one
place. What to do instead: one implementation, no unlink call in the codebase, and a test that
greps for one.

**Chunks attached to a document rather than a version.** What happens: a superseded manual keeps
answering retrieval queries from the previous revision, with a citation that looks current. Why:
re-chunking updated rows in place instead of retiring them. What to do instead: chunks belong to a
`document_versions` row and carry its checksum; a supersede retires the old set.

**Retention computed at read time.** What happens: editing a retention rule silently changes the
retention date of every historical record approved under the previous one. Why: `retain_until`
derived on read from the live rule. What to do instead: freeze `retain_until` on the document at
approval and version the rules by `effective_from`.

**Export treated as view.** What happens: a subject or an assessor downloads a full record set that
policy allows them only to read on screen. Why: the download route reused the view capability. What
to do instead: `data.export` and `data.bulk_export` are distinct capabilities, checked at the
download route, with no `own` carve-out, and every export is audited with a record count.
