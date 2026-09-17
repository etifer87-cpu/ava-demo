-- 0150_signatures.sql
-- What a signature attests to, and what it took to remove one.
--
-- The kit already carries WHO signed and WHEN (0024 assessor_signed_at / assessor_signer_id, 0025
-- subject_signed_at / subject_signer_id). What it does not carry is WHAT they signed. A signature
-- over "the session" is worth nothing once the session can change: the statements in policy.yaml say
-- in as many words that both parties attest to this content and that a later change voids them, and
-- that sentence needs a value behind it.
--
--   content_hash  SHA-256 over the canonical grading content of one subject's part of the session -
--                 every task attempt, every competency grade with its behaviours and its proposal,
--                 the section notes, the outcome and the remarks (lib/program/signing.ts).
--                 Written on the FIRST signature, because that is the moment the content is frozen;
--                 re-read and compared on every later render, so a mismatch is visible rather than
--                 theoretical.
--
--   *_signature_method  HOW the identity was asserted. This platform has no digital certificates and
--                 no drawn squiggles: a signer types their own employee id on the device in front of
--                 them, which is what a paper ETR has always been. Recording the method means a later
--                 method (a certificate, an SSO re-authentication) does not make the old rows lie.
--
--   unsigned_at / unsigned_by / unsigned_reason  Unsigning is the act a regulator asks about, so the
--                 reason is stored on the session itself and not only in the log. Only the last
--                 unsign is kept here; audit_log keeps them all.
--
-- records.content_hash is the frozen copy, so a signed record can be re-verified after finalisation.
-- Forward-only, idempotent.

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS content_hash              TEXT,
  ADD COLUMN IF NOT EXISTS assessor_signature_method TEXT,
  ADD COLUMN IF NOT EXISTS unsigned_at               TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS unsigned_by               UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS unsigned_reason           TEXT;

COMMENT ON COLUMN sessions.content_hash IS
  'SHA-256 over the canonical grading content at the first signature. Both signature statements attest to this value; a render that recomputes a different one says so.';
COMMENT ON COLUMN sessions.assessor_signature_method IS
  'How the assessor asserted their identity, e.g. employee_id. Stored per signature so a later method does not reinterpret an old row.';
COMMENT ON COLUMN sessions.unsigned_reason IS
  'Why the signatures were removed. Required by the handler; kept here as well as in audit_log because it is the first thing asked about a record that was signed twice.';

ALTER TABLE session_subjects
  ADD COLUMN IF NOT EXISTS subject_signature_method TEXT;

COMMENT ON COLUMN session_subjects.subject_signature_method IS
  'How the pilot asserted their identity. employee_id_on_device is the normal case: they type their own employee id on the instructor''s screen at the debrief, and subject_signer_id is then the account that presented it.';

ALTER TABLE records
  ADD COLUMN IF NOT EXISTS content_hash TEXT;

COMMENT ON COLUMN records.content_hash IS
  'The frozen copy of sessions.content_hash. A record carries the hash its signatures attest to, so it can still be verified after the session tables move on.';

DO $$ BEGIN RAISE NOTICE '0150: content hash and signature method on sessions / session_subjects / records.'; END $$;
