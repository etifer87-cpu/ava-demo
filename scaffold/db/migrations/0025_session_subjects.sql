-- 0025_session_subjects.sql
-- ETR. Who was in the session, in which seat, and whether they were assessed.
--
-- This table is also the seam the 'assigned' permission scope reads: the set of subjects an
-- assessor actually taught is derived from here, in ONE helper, never re-derived per call site.

CREATE TABLE IF NOT EXISTS session_subjects (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id         UUID        NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  person_id          UUID        NOT NULL REFERENCES people(id),
  seat_role          TEXT        NOT NULL,   -- operator vocabulary; a label, never an enum
  is_assessed        BOOLEAN     NOT NULL DEFAULT true,  -- false = present, logged, not graded
  outcome            TEXT,
  subject_signed_at  TIMESTAMPTZ,
  subject_signer_id  UUID        REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, person_id)
);

CREATE INDEX IF NOT EXISTS session_subjects_person ON session_subjects (person_id);

COMMENT ON TABLE session_subjects IS 'Participants of a session and their seat; the single source of the assigned permission scope.';
