-- 0151_objection.sql
-- The pilot's objection: signing's alternative, not its failure.
--
-- policy.yaml `signatures.objection` already states the rule - a pilot who does not accept the record
-- may say so instead of signing, which marks the record with `marks_record` and notifies
-- `notifies_role`. The kit has nowhere to put it: session_subjects carries a signature or nothing.
--
-- It belongs on session_subjects rather than on sessions because it is ONE PILOT'S act. A two-pilot
-- session where one signs and one objects is an ordinary outcome, and a column on the session could
-- not express it.
--
-- The record still gets written. An objection does not erase an assessment - it says the pilot
-- disputes it, and `records.outcome` takes policy's `marks_record` value (INCOMPLETE in this
-- operator's vocabulary) while the assessor's own finding is kept in the snapshot. That way nothing
-- reads an objected record as a pass, and nothing loses what the instructor actually found.
-- Forward-only, idempotent.

ALTER TABLE session_subjects
  ADD COLUMN IF NOT EXISTS objected_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS objection_reason TEXT,
  ADD COLUMN IF NOT EXISTS objection_by     UUID REFERENCES users(id);

-- An objection with no reason is not an objection: it is the reason a manager is being asked to read.
ALTER TABLE session_subjects DROP CONSTRAINT IF EXISTS session_subjects_objection_complete;
ALTER TABLE session_subjects
  ADD CONSTRAINT session_subjects_objection_complete
  CHECK (objected_at IS NULL OR (objection_reason IS NOT NULL AND btrim(objection_reason) <> ''));

-- A pilot either signs or objects. Both at once is a contradiction, and the handler refuses it; the
-- constraint is here so that no future writer can create one by accident.
ALTER TABLE session_subjects DROP CONSTRAINT IF EXISTS session_subjects_sign_xor_object;
ALTER TABLE session_subjects
  ADD CONSTRAINT session_subjects_sign_xor_object
  CHECK (subject_signed_at IS NULL OR objected_at IS NULL);

COMMENT ON COLUMN session_subjects.objected_at IS
  'When this pilot objected instead of signing. Mutually exclusive with subject_signed_at.';
COMMENT ON COLUMN session_subjects.objection_reason IS
  'The pilot''s own words, required. This is what the notified role reads; it is copied into the record snapshot and never summarised.';
COMMENT ON COLUMN session_subjects.objection_by IS
  'The account that entered the objection - the pilot''s own where they have one, otherwise the account that presented the device.';

DO $$ BEGIN RAISE NOTICE '0151: objection columns on session_subjects.'; END $$;
