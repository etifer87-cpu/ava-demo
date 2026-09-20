-- 0159_analysis_run_framework.sql
-- Data fixed FORWARD, per rule 3 of scripts/verify.mjs: the release carries the migration that makes
-- the invariant hold, and the check is never narrowed to fit the rows that exist.
--
-- THE DEFECT. `lib/analytics/subject-narrative.ts` — the LIVE path, the one a training manager
-- reaches by clicking the button — inserted analysis_runs without framework_id, while
-- scripts/seed-synthetic.mjs set it on all four of its inserts. So every run the APPLICATION has
-- ever created violates `every graded or evidence-bearing row carries a framework`, and every run
-- the SEEDER creates satisfies it.
--
-- WHY IT SURVIVED THIS LONG. A fresh install ships zero analysis runs, so the assertion passed on an
-- empty set on every workstation run since 0031. It first failed on 2026-09-20 on cvx-hel1, against
-- the single degraded run a human had produced on the 19th. That is the same fact the gate has been
-- reporting from the other end all along as `the analysis runs a fresh install ships include the
-- states that must work`: no run exists locally, so nothing local can be wrong.
--
-- WHY THE VALUE IS NOT GUESSED. competency_grades.framework_id is NOT NULL (0027), so a run's
-- framework is derivable from the graded rows of the very person the run is about, rather than
-- assumed from whichever framework happens to be active today. A person whose grades span more than
-- one framework is a different defect and is left alone here.
--
-- The second statement is the point of the migration. The column has been nullable since 0031 with
-- no default, which is what let a writer omit it silently for nine months. After this, the database
-- refuses the row and the gate assertion becomes a second opinion rather than the only guard.
--
-- Forward-only. Re-runnable: the UPDATE touches only rows that are still NULL, and SET NOT NULL is
-- idempotent.

UPDATE analysis_runs ar
   SET framework_id = src.framework_id
  FROM (
         SELECT cg.person_id,
                (array_agg(DISTINCT cg.framework_id))[1] AS framework_id
           FROM competency_grades cg
          GROUP BY cg.person_id
         HAVING count(DISTINCT cg.framework_id) = 1
       ) src
 WHERE ar.person_id = src.person_id
   AND ar.framework_id IS NULL;

-- A run about a person with no grades at all cannot be resolved from that person's rows. It can
-- still be resolved without guessing IF the installation has only ever had one framework, because
-- then there is exactly one value it could hold. Anything else is left NULL deliberately, and the
-- ALTER below then fails loudly rather than inventing an attribution.
UPDATE analysis_runs ar
   SET framework_id = (SELECT f.id FROM competency_frameworks f)
 WHERE ar.framework_id IS NULL
   AND (SELECT count(*) FROM competency_frameworks) = 1;

ALTER TABLE analysis_runs
  ALTER COLUMN framework_id SET NOT NULL;

COMMENT ON COLUMN analysis_runs.framework_id IS
  'The competency vocabulary this run was measured against. NOT NULL since 0159: a run whose '
  'framework is unknown cannot be read back, and the application path omitted it silently from '
  '0031 until 2026-09-20.';
