-- 0026_element_grades.sql
-- ETR. A grade against one template element, for one subject, on one attempt.
--
-- Two things here are deliberate and must not be "fixed" later:
--   1. element_key carries NO foreign key to template_elements. A retired element must not orphan
--      a historical grade, and a template re-save must not be able to strand one.
--   2. grade is TEXT with no CHECK. The column must hold 1-5 and the non-scoring codes NR, NO, NA;
--      the vocabulary is config, and a CHECK on it is a migration every time policy moves.

CREATE TABLE IF NOT EXISTS element_grades (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   UUID        NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  person_id    UUID        NOT NULL REFERENCES people(id),
  element_key  TEXT        NOT NULL,
  -- Every attempt is a row. Storing only the last attempt hides the initial failure: a task graded
  -- 2 then 4 reads as "meets standard", and below-standard counts roughly double once every
  -- attempt is counted.
  attempt      INT         NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  grade        TEXT,       -- NULL = cleared
  remark       TEXT,
  graded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  graded_by    UUID        REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, person_id, element_key, attempt)
);

CREATE INDEX IF NOT EXISTS element_grades_session ON element_grades (session_id, person_id);
CREATE INDEX IF NOT EXISTS element_grades_key     ON element_grades (element_key);

COMMENT ON TABLE element_grades IS 'Per-element, per-attempt grades for a session, keyed by element_key rather than by a template row id.';
