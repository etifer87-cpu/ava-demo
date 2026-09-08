# 17 · Governance, audit and records

Purpose: what the platform must be able to prove, and to whom.
Status: spec (audit and signature scaffolded in migrations 0001–0019 and 0020–0039)
Version: v1.0 · 2026-08-26

---

## 1. Posture

Framework-generic by construction. The platform is built against the ICAO competency framework
(`docs/03_COMPETENCY_FRAMEWORK.md`) and an EASA-style Part-ORO / Part-ORA reference model, with the
operator's own authority as the primary requirement set. **No single country's law is encoded
anywhere.** Jurisdictional facts — retention periods, breach-notification deadlines, the lawful
basis for processing, cross-border transfer conditions — are configuration in
`scaffold/config/governance.yaml` and rows in `retention_rules`, with a `legal_ref` free-text field
the operator fills in. Changing jurisdiction must never be a code change.

Three commitments the design has to be able to keep:

| Commitment | What makes it credible |
|---|---|
| Data residency | one storage root and one database URL, both environment variables; a host move is an environment change |
| Attributable action | every consequential write carries an actor and a timestamp in the same transaction |
| Reproducible record | a signed record renders identically years later, from its own snapshot, after its template is retired |

## 2. Audit log

### 2.1 Shape

```sql
audit_log (
  id            BIGSERIAL PRIMARY KEY,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_user_id UUID NULL,          -- null only for system and break-glass actors
  actor_label   TEXT NOT NULL,      -- resolved at write time; survives a later rename
  action        TEXT NOT NULL,      -- dotted namespace, see 2.2
  target_kind   TEXT NULL,
  target_id     TEXT NULL,
  org_unit_id   UUID NULL,
  capability    TEXT NULL,          -- which capability authorised this
  reason        TEXT NULL,          -- mandatory for destructive and override actions
  request_id    TEXT NULL,          -- ties an entry to a request and to module event rows
  ip            INET NULL,
  user_agent    TEXT NULL,          -- truncated
  details       JSONB NOT NULL DEFAULT '{}'::jsonb
)
```

Two supporting stores, deliberately separate: **`qms_events`** and any other module event table hold
the per-record version timeline in the module's own vocabulary; the audit log holds the cross-cutting
who-did-what. They are joined by `request_id`, not merged. A module timeline is read by operators; the
audit log is read by auditors.

`actor_label` is resolved and stored at write time. Joining to `users` at read time means a person
who left the organisation makes their own historical entries unreadable.

### 2.2 What must be logged

| Prefix | Actions |
|---|---|
| `auth.` | `login_success` (with a break-glass flag), `login_failed` (outcome `bad_password` / `unknown_user` / `inactive_user`), `logout`, `password_changed`, `token_issued`, `token_revoked` |
| `user.` | `create`, `update`, `roles_change`, `password_reset`, `activate`, `deactivate`, `delete` |
| `perm.` | `override_grant`, `override_revoke`, `role_capability_change`, `override_refused` |
| `grade.` | `create`, `update`, `delete` — every attempt is its own event |
| `record.` | `sign`, `unsign`, `finalize`, `reopen`, `amend`, `import` |
| `qual.` | `alert_raised`, `approval_opened`, `approval_step`, `granted`, `rejected`, `waived`, `suspended`, `reactivated`, `override_set` |
| `doc.` | `upload`, `approve`, `reject`, `supersede`, `view_restricted`, `download`, `delete`, `hold_set`, `hold_cleared` |
| `export.` | `single`, `bulk`, `report` — each with the capability used, the subject ids and the **record count** |
| `config.` | `version_published`, `threshold_change`, `retention_rule_change`, `taxonomy_change` |
| `sync.` | `run`, `imported`, `held`, `error`, `reconciled` |
| `mobile.` | `session_upload` with the client uuid, ids and outcome |

Coverage rule: **if an action changes what a person is authorised to do, what a record says, or who
can see it, it is logged.** Grades, signatures, qualification approvals and restricted-document
access are the four most commonly missed, and they are exactly the four an audit samples first.

### 2.3 Three deliberate rules about the login log

- The submitted password is **never** logged, in any form, on any path, including failure paths.
- The failure `outcome` **never reaches the client**. The response is one generic "invalid username
  or password" whether the account is unknown, deactivated, or the password was wrong. The
  distinction exists only in the admin-only log; returning it enables username enumeration.
- The username typed on a failed attempt is stored **as typed**, so the log will contain typos and
  sometimes another person's name. That is inherent to a failed-login log, and it is precisely why
  the login log needs its own retention period.

Client IP comes from the edge-set connecting-IP header, which the client cannot forge, falling back
to the first forwarded-for entry only for direct network access — that fallback is client-supplied
and spoofable, and should be marked as such in `details`.

### 2.4 Integrity

1. **Atomic, not best-effort.** The audit write is in the same transaction as the action, via a
   trigger or a function. An audit write that logs to console on failure guarantees that the record
   and its trail will eventually diverge, and the divergence will be silent.
2. **Append-only in the database, not by convention.** `REVOKE UPDATE, DELETE ON audit_log` from
   every application role; writes go through a restricted role or a `SECURITY DEFINER` function.
   Append-only by convention is not append-only.
3. **Fail loud.** A state-changing write that does not persist must return an error. Never swallow a
   database error on sign, unsign, finalize, delete or extraction: the user is told it happened, the
   record says it did not, and only the trail can tell them apart — if the trail was written.
4. **Absence of early rows is not evidence of absence of activity.** The log has no history before
   the feature shipped. State that in the audit pack rather than letting an auditor infer coverage
   that never existed.
5. Logging makes brute force **visible**, not **stopped**. Rate limiting and lockout are separate
   controls and must exist independently.

## 3. Electronic signature

**Identity assertion.** A signature asserts that a named, authenticated human, holding the capability
to sign that record at that scope, affirmed its contents at a stated time. It is stored as:
`signer_user_id`, `signer_label`, `signer_role`, `signed_at`, `capability`, `signature_scope`
(`assessor` | `subject` | `verifier`), `content_hash` over the frozen record snapshot, and the
request context. The hash is what makes the assertion mean something: it binds the signature to the
exact content that was on screen.

Signing requires **re-authentication with the signer's own password**, verified server-side against
the signer's own hash, fail-closed 403. Note the corrected defect worth naming: an early
implementation of a destructive path verified the *target's* password rather than the *caller's*.
Re-authentication always verifies the acting user.

**First-signature lock.** The first signature on a record freezes it. Grades stop being editable,
the snapshot is written, and every later signature (a second party, a verifier) attaches to the
frozen content and re-hashes against the same snapshot. A record that can still change after it is
signed has an unfalsifiable signature.

**Unsign is the only amendment path.** There is no edit-in-place on a signed record and no
silent correction.

1. A user holding the unsign capability at the record's scope unsigns, with a **mandatory reason**
   and password re-authentication.
2. The record returns to editable. Every prior signature is **retained**, marked `superseded_at`,
   never deleted.
3. The corrected record is re-signed, producing a new signature and a new content hash.
4. `record.unsign` and `record.sign` both appear in the audit log, and the record's own timeline
   shows the full sequence.
5. **An offline copy can never overwrite an unsign.** The tablet contract makes a signed record
   locally read-only and returns 409 on any upload against it (`docs/10_INTEGRATION.md` §3.6).

Signing is `own`-scope: an assessor cannot sign another assessor's record. That is an objectivity
requirement, not an access convenience.

**Rendering.** The PDF states, per party, "Signed electronically on `<date>`" or "Not signed", plus
a banner naming the system, the signer identity and the timestamp. The on-screen preview and the PDF
come from one template module and can never diverge.

**What an imported historical record may claim.** A record ingested from a legacy system or a
counterparty **must not assert a platform signature**. It carries `source IN ('import','ingest')` and
a distinct `attestation_kind = 'imported'` with:

- who imported it, when, and from which system and run (`sync_runs.id`);
- the signature evidence *as recorded in the source* — a name, a date, a scanned page reference —
  stored as **claimed** attributes, clearly labelled;
- no `content_hash` claim over content the platform never displayed to the signer.

The rendered record says "signed in the originating system on `<date>` per imported record",
never "signed electronically". Conflating the two is the fastest way to lose the credibility of
every real signature in the store.

## 4. Retention and data-subject rights

**Retention classes** are configuration (`retention_rules`, `docs/09_DMS.md` §7): per record class, a
minimum and maximum period, a basis (`issue` / `expiry` / `separation` / `event`), a legal reference
and whether review is required before disposal. Classes that must exist before the store holds real
data: training records, competency evidence, medical, licence, certificates, analysis reports,
integration payload logs, login and audit logs, and **user-submitted content**.

User-submitted content earns its own class and is easy to forget. Any free-text or attachment
surface — support tickets, notes, uploaded screenshots — is entered by ordinary users and will
incidentally contain other people's names, grades and records. Treat it as access-restricted:
admin-only triage, a defined retention period for resolved items and their attachments, and a
redaction step before anything is shared outside that group.

**Login logs hold IP addresses, which are personal data.** A login log with no retention period is
an open compliance gap, not a neutral default. Set a period, document the purge procedure, and name
it in the privacy notice.

**Soft delete versus erasure.** The platform never hard-deletes. Deletion moves the object to a
retention store and sets `deleted_at`. An erasure request is therefore **two steps** — application
removal, then a policy-gated physical purge outside the application — and the tension between the
no-hard-delete rule and an erasure right must be written down in the retention policy, not improvised
at the first request. Legal hold overrides both.

**Deletion integrity.** Removing a person removes the person's children in FK-safe order,
sequentially and fail-loud: a child failure aborts before the parent row is touched, so a request can
never leave orphaned personal data behind. The document tree is soft-archived, not purged.

**Data-subject rights, and the gaps to close before go-live:**

| Right | Implementation | Watch |
|---|---|---|
| Access | an audit-pack builder produces the subject's own records, documents and qualification history | must include user-submitted content, which is the surface most often missed |
| Rectification | unsign, correct, re-sign; the history remains | never a silent edit |
| Erasure | soft delete plus policy purge; refused where a retention rule or legal hold applies, with the reason given | the refusal must be documented and citable |
| Restriction | `status_override = 'inactive'` and restricted-document flags | not a delete |
| Portability | export of the subject's own structured records | export is a separate capability from view, and by design a subject cannot self-export; decide the answer **before** the first request, not after |
| Objection / automated decisions | no qualification is ever granted automatically (`docs/08_QMS.md` §1); no figure in a report originates in a model | this is the strongest answer the platform has — state it plainly |

**Minimisation is a coding rule:** never place personal or sensitive data in a URL, query string or
API parameter (`docs/10_INTEGRATION.md`).

**Sensitive categories.** Medical evidence and psychometric or selection-assessment data are handled
more strictly than training records: restricted by role **and** module, encrypted at rest, every read
logged, a shorter and separately-stated retention period, and an explicit cross-border decision
before any contractor or remote staff member can reach them. Assessor analytics are shown against
anonymised peers, and assessor self-view is removed — those analytics are a privileged management
surface, not a personal dashboard.

**Cross-border transfer** is decided explicitly and recorded: where the data rests, where it is
processed, and from which jurisdictions staff and contractors access it. Encrypted transit through an
edge relay is not a transfer of the data at rest; access from another jurisdiction is.

## 5. Change control and versioning

- **Everything consequential is versioned data, not code.** Templates
  (`session_template_versions`), qualification rules (`qual_type_versions`), thresholds and bands
  (`scaffold/config/*.yaml` with `config_versions` rows), retention rules (`effective_from`), and the
  competency framework itself. A change is an INSERT with an effective date and an actor.
- **Published is immutable.** A change produces a new version with a computed diff and a mandatory
  reason; publishing re-authenticates the acting user. An in-place edit behind a password prompt
  gives a log entry but no artefact, which is not the same thing.
- **Snapshot the rule set into the artefact at publish time.** Raising a minimum in one month must
  not retroactively turn a previous month's compliant work red.
- **Rollback tag before every breaking change**, and separate development and production stacks with
  a short-lived parallel rollback stack retained across a deploy.
- **Migrations are forward-only, numbered, idempotent** (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`),
  include their GRANTs, and are run with error-stop plus a before/after verification. Enum value
  additions commit in their own step before anything inserts using them.
- Production bundles are **rebuilt** after a code change; a stale bundle is the classic false
  negative when testing a permission fix.
- Version and date every document in `docs/`; append decisions, never overwrite them.

## 6. Backup and restore

| Expectation | Standard |
|---|---|
| Database dump | nightly, plus an on-demand dump immediately before every migration and deploy |
| File store | rolling snapshots of the storage root on the same or a tighter schedule than the database |
| Retention of backups | a stated rolling window, with the backup set itself covered by a retention rule |
| Encryption | at rest and in transit, with the key held separately from the backup |
| RPO / RTO | **must be stated numerically** and agreed with the operator; an unstated RPO is not a target |
| Restore test | a full restore into an isolated environment on a documented cadence, and a mandatory restore rehearsal at real data volume as a cutover gate |
| Consistency | database and file store restored to the same point; a document row whose bytes are missing is a corrupt record, not a warning |

**A backup that has never been restored is not a backup.** Record the date, the operator and the
outcome of each restore test; that record is itself an audit artefact.

## 7. What an authority audit will ask for

Expect these, and be able to produce each without an engineer:

1. **A named human accountable for every qualification held**, with the evidence they approved
   against and the date. This is what the no-auto-grant rule exists to answer.
2. **Full qualification history for a subject**, including overrides, suspensions, waivers and the
   supporting documents, with dates.
3. **Compliance by population** — per org_unit, asset class and group: held, missing, expiring,
   expired, waived — as a fraction, since absence of a record is itself a finding.
4. **A complete record for a named session**, rendered as it was signed, with signature evidence.
5. **The rule in force on a given date**: which qualification definition version, which template
   version, which thresholds — and the diff to the version before it.
6. **Access history for a sensitive document**: who opened it, when, under which capability.
7. **Exception reports**: incomplete, unverified, missing and expired documents per subject.
8. **The integration position**: which records came from which counterparty, which were held and why,
   and the reconciliation state.
9. **Waivers and overrides**, listed separately from compliant grants, with reasons and authorisers.
10. **Retention and disposal evidence**: the schedule, what was disposed of, when, and by whom.

An **audit-pack builder** assembling these by person, org_unit, asset class, qualification, date
range, assessor or ad-hoc criteria — each pack itself audit-logged — is the deliverable. A pile of
per-person exports is the interim answer, not the target.

## 8. Traps

Each of these also appears in `docs/16_TRAPS.md`.

**Best-effort audit writes.** What happens: the action succeeds, the audit write fails to a console
line nobody reads, and the record and its trail diverge permanently and silently. Why: the audit call
was made non-blocking so it could never break a request. What to do instead: write the audit row in
the same transaction, through a trigger or function, and let a failure fail the action.

**Append-only by convention.** What happens: a cleanup script or an ORM cascade edits or removes
audit rows, and the log's value as evidence is gone with no way to detect it. Why: nothing in the
database prevented it. What to do instead: `REVOKE UPDATE, DELETE` from every application role and
write through a restricted path.

**Returning the failure reason to the login client.** What happens: an attacker enumerates valid
usernames, and deactivated accounts are identifiable from outside. Why: a helpful error message. What
to do instead: one generic message to the client, the specific outcome in the admin-only log.

**Editing a signed record.** What happens: content changes under a signature and every signature in
the store becomes deniable, including the honest ones. Why: an "admin can fix it" path was left open.
What to do instead: first signature locks; unsign with a reason is the only amendment path; prior
signatures are retained as superseded.

**An imported record asserting a platform signature.** What happens: an auditor asks who signed
electronically, and the answer is that nobody did — the row was imported. Why: the importer reused
the signature columns because they fit. What to do instead: `attestation_kind = 'imported'`, claimed
attributes clearly labelled, no content hash, and rendering that says where it was signed.

**Re-authenticating the wrong user.** What happens: a destructive action is confirmed with the
target's password rather than the caller's, so the control confirms nothing at all. Why: the target
was the object already loaded in the handler. What to do instead: re-authentication always verifies
the acting session's own user, server-side, fail-closed.

**No retention period on the login log.** What happens: IP addresses accumulate indefinitely, outside
every stated retention policy, and the log becomes the operator's largest undeclared personal-data
store. Why: it was built as a security feature, not a data store. What to do instead: a stated
period, an automated purge, and a line in the privacy notice.

**Retention rules evaluated at read time.** What happens: editing a rule retroactively changes the
disposal date of records approved years earlier. Why: `retain_until` derived rather than frozen. What
to do instead: freeze the date at approval and version the rules by `effective_from`.

**An untested backup.** What happens: the first restore is attempted during the first real incident,
at full data volume, and it does not work. Why: dumps succeeded, so the job looked green. What to do
instead: a scheduled restore test with a recorded outcome, and a full-volume rehearsal as a cutover
gate.

**Presenting a young log as complete coverage.** What happens: an auditor infers that no activity
occurred before the earliest row. Why: nobody said when logging started. What to do instead: state
the logging start date in every audit pack, and keep the prior evidence source named.
