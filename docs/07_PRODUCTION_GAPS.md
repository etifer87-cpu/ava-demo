# 07 — Production gaps

Things that are **deliberately demo-shaped** and must be closed before this instance holds a real
training record. Every entry says what it is now, why that was acceptable for the demo, and what has
to be true on a live instance. Nothing here is a bug: each one was a decision, taken in the open, with
the cheaper path chosen because the deadline is a demo on 2026-09-29 and not a certification audit.

Anything added here must also be added to the brain's `TODO.md` under the go-live section, so it is
not only documented but scheduled.

---

## 1. A pilot's signature may be an employee id rather than a password

**Now.** `lib/program/signing.ts` verifies a signature with the signer's own account **password**,
checked in Postgres with `crypt()` exactly as sign-in is. Where the signer has **no account at all**
it falls back to their **employee id** typed on the instructor's device, and records
`session_subjects.subject_signature_method = 'employee_id_on_device'` rather than `'password'`.

**Why for the demo.** The seeded roster is 500+ pilots and almost none of them have logins; creating
accounts for a demo population is work that teaches nobody anything. The instructor always has an
account (they are signed in), so the instructor's signature is already password-verified today.

**Live instance.** Every pilot who signs holds an account, so every signature is password-verified.
An employee id is printed on a roster that every colleague can read: a record signed that way cannot
be defended if the pilot later says it was not them. **No code changes for this** — the method is
chosen by whether the person has an account — but the accounts must exist before the first real
session, and a production row carrying `employee_id_on_device` is a finding, not a detail.

**Check.** `SELECT count(*) FROM session_subjects WHERE subject_signature_method <> 'password' AND subject_signed_at IS NOT NULL;`
must be 0 on a live instance.

---

## 2. The signing endpoint has no lockout of its own

**Now.** `POST /api/sessions/[id]/sign` verifies a password on every attempt and neither counts
failures nor locks the account. `users.failed_login_count` / `locked_until` are maintained by the
sign-in route only.

**Why for the demo.** The surface is reachable only by an authenticated holder of
`training.sessions.sign`, on a private instance behind Cloudflare Access.

**Live instance.** Either the sign route shares the sign-in route's failure counter and lockout, or
the signature is re-authenticated through the sign-in path. A password-checking endpoint without a
rate limit is a password-guessing endpoint.

---

## 3. `instructor` holds `people.view` at `all`, not `assigned`

**Now.** Migration-time scope for the `instructor` role was widened from `assigned` to `all` (step
29). The fleet binding on the grant does the narrowing, so an A320-bound instructor still cannot see
a B787 pilot.

**Why.** The kit's `assigned` scope resolves to "people on sessions where I am the assessor", which is
self-referential: a brand-new instructor can open no first session, because the pilot they want to
put on it is not yet assigned to them.

**Live instance.** A scope that means "people on the fleets my grant is bound to" is the right
answer, and it belongs in the kit rather than in this instance. Until then, an operator with several
fleets and instructors who must not read across them needs the fleet binding on every instructor
grant — which is exactly what the account page's binding dropdown is for.

---

## 4. The `.env` secrets were pasted into a chat

**Now.** The local `.env` for `C:\Avianca TMS` was shared in a conversation on 2026-09-08: the
database password, `SESSION_SECRET` and `INTERNAL_API_TOKEN`.

**Why it is not urgent.** The instance is loopback-only on a single workstation and has never been
exposed.

**Live instance.** Rotate all three before the server instance holds anything, and generate the
server's own set on the server. They are not the same secrets.

---

## 5. A record's PDF lives in the database, not in the DMS

**Now.** Finalising renders the record to a PDF and stores the bytes in `record_pdfs` (migration
0152), one row per record. `records.document_id` is still null.

**Why for the demo.** `documents` (0081) needs a resolved folder — slot, `path_template`,
`period_key`, the archive slot, a storage root — and the DMS module that owns that routing is a stub.
Writing a document row now would mean inventing the routing twice. Bytes in the database also keep
the environment story intact: `pg_dump` carries them, so "migrate, seed, never copy a database" needs
no second file sync. It is dozens of rows here, because only finalised app records get one and the
seeded history is never re-frozen.

**Live instance.** The DMS module reads `record_pdfs` once, creates the document row per its own
routing, fills `records.document_id`, and `record_pdfs` is dropped. Until then: a real operator's
archive of thousands of records does not belong in a BYTEA column, and nothing here should be taken as
saying it does.

**Check.** `SELECT count(*) FROM record_pdfs;` must be 0 on a live instance once the DMS owns them.

---

## 6. Nothing here is a signature standard

**Now.** A signature in this platform is an identity assertion plus a content hash: the password
proves the account, the SHA-256 proves what was attested to, and the audit row proves when. It is
strictly better than a scanned squiggle on a paper ETR and it is what the operator asked for.

**Live instance, if it ever has to satisfy a regulator on electronic signatures specifically** (EASA
AMC, FAA 14 CFR Part 11-equivalent, or a national rule): that is a separate conversation about
certificates, timestamping authorities and non-repudiation, and it is an integration, not a field.
The hash and the method column are what make that integration possible without rewriting history —
a later method appears as a new value in `*_signature_method` and the old rows keep saying exactly
what they always said.
