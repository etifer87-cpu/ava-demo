-- 0027_competency_grades.sql
-- ETR. The competency grade and its selected observable behaviours.
--
-- OBs are SELECTED, not graded: the junction row carries no grade of its own, and a free-text
-- remark is never parsed back into OB references.

CREATE TABLE IF NOT EXISTS competency_grades (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     UUID        NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  person_id      UUID        NOT NULL REFERENCES people(id),
  framework_id   UUID        NOT NULL,   -- FK added in 0042
  competency_id  UUID        NOT NULL,   -- FK added in 0042; an id, never a name
  grade          TEXT,                   -- TEXT: must hold NR / NO / NA beside 1-5
  remark         TEXT,
  graded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  graded_by      UUID        REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, person_id, competency_id)
);

CREATE INDEX IF NOT EXISTS competency_grades_session   ON competency_grades (session_id, person_id);
CREATE INDEX IF NOT EXISTS competency_grades_framework ON competency_grades (framework_id, competency_id);

CREATE TABLE IF NOT EXISTS competency_grade_obs (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  competency_grade_id      UUID NOT NULL REFERENCES competency_grades(id) ON DELETE CASCADE,
  observable_behaviour_id  UUID NOT NULL,   -- FK added in 0042
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (competency_grade_id, observable_behaviour_id)
);

CREATE INDEX IF NOT EXISTS competency_grade_obs_ob ON competency_grade_obs (observable_behaviour_id);

COMMENT ON TABLE competency_grades IS 'Per-competency grade for one subject in one session, referenced by competency_id and carrying its framework_id.';
COMMENT ON TABLE competency_grade_obs IS 'Observable behaviours selected in support of a competency grade; a junction because it is edited behaviour by behaviour while grading.';
