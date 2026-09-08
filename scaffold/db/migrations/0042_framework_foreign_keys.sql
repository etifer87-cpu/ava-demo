-- 0042_framework_foreign_keys.sql
-- Framework. Deferred foreign keys.
--
-- The contract fixes the migration ranges so that ETR (0020-0039) runs BEFORE the framework
-- (0040-0059). The framework_id, competency_id and observable_behaviour_id columns in the ETR
-- range are therefore created bare, and their constraints are added here.
--
-- VERIFY AFTER MIGRATING. If this file is skipped or fails, the schema still works and still
-- accepts orphan ids; the symptom appears months later as a chart with a missing spoke. Every
-- column listed below should appear in information_schema.referential_constraints.

ALTER TABLE session_template_versions
  DROP CONSTRAINT IF EXISTS session_template_versions_framework_fk,
  ADD  CONSTRAINT session_template_versions_framework_fk
       FOREIGN KEY (framework_id) REFERENCES competency_frameworks(id);

ALTER TABLE template_competencies
  DROP CONSTRAINT IF EXISTS template_competencies_framework_fk,
  ADD  CONSTRAINT template_competencies_framework_fk
       FOREIGN KEY (framework_id) REFERENCES competency_frameworks(id),
  DROP CONSTRAINT IF EXISTS template_competencies_competency_fk,
  ADD  CONSTRAINT template_competencies_competency_fk
       FOREIGN KEY (competency_id) REFERENCES competencies(id);

ALTER TABLE sessions
  DROP CONSTRAINT IF EXISTS sessions_framework_fk,
  ADD  CONSTRAINT sessions_framework_fk
       FOREIGN KEY (framework_id) REFERENCES competency_frameworks(id);

ALTER TABLE competency_grades
  DROP CONSTRAINT IF EXISTS competency_grades_framework_fk,
  ADD  CONSTRAINT competency_grades_framework_fk
       FOREIGN KEY (framework_id) REFERENCES competency_frameworks(id),
  DROP CONSTRAINT IF EXISTS competency_grades_competency_fk,
  ADD  CONSTRAINT competency_grades_competency_fk
       FOREIGN KEY (competency_id) REFERENCES competencies(id);

ALTER TABLE competency_grade_obs
  DROP CONSTRAINT IF EXISTS competency_grade_obs_ob_fk,
  ADD  CONSTRAINT competency_grade_obs_ob_fk
       FOREIGN KEY (observable_behaviour_id) REFERENCES observable_behaviours(id);

ALTER TABLE records
  DROP CONSTRAINT IF EXISTS records_framework_fk,
  ADD  CONSTRAINT records_framework_fk
       FOREIGN KEY (framework_id) REFERENCES competency_frameworks(id);

ALTER TABLE record_competencies
  DROP CONSTRAINT IF EXISTS record_competencies_framework_fk,
  ADD  CONSTRAINT record_competencies_framework_fk
       FOREIGN KEY (framework_id) REFERENCES competency_frameworks(id),
  DROP CONSTRAINT IF EXISTS record_competencies_competency_fk,
  ADD  CONSTRAINT record_competencies_competency_fk
       FOREIGN KEY (competency_id) REFERENCES competencies(id);

ALTER TABLE analysis_runs
  DROP CONSTRAINT IF EXISTS analysis_runs_framework_fk,
  ADD  CONSTRAINT analysis_runs_framework_fk
       FOREIGN KEY (framework_id) REFERENCES competency_frameworks(id);

-- record_competencies.observable_behaviour_ids is an array and carries no FK. Its referential
-- integrity is asserted at import and by an analytics check view, not by the planner.

DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n
  FROM information_schema.table_constraints
  WHERE constraint_type = 'FOREIGN KEY'
    AND constraint_name LIKE '%_framework_fk';
  RAISE NOTICE 'deferred framework foreign keys in place: %', n;
  IF n < 7 THEN
    RAISE EXCEPTION 'deferred framework foreign keys incomplete: only % of 7 present', n;
  END IF;
END $$;
