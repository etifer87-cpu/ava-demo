-- 0149_grading_proposal.sql
-- The proposed competency grade, stored BESIDE the instructor's own.
--
-- The grading surface computes, from the task grades of the exercises that target a competency, what
-- that evidence adds up to (lib/program/grade-tokens.ts). The instructor's grade is the record;
-- the proposal is kept so that a divergence is visible instead of lost. policy.yaml already states
-- the principle one level up - `grading.outcome_is_always_explicit` and `store_computed_outcome`
-- put a computed OUTCOME beside the human one - and this is the same arrangement per competency.
--
-- Why it is worth a column rather than a recomputation at read time: the proposal depends on the
-- task grades AS THEY WERE when the instructor answered it. Recomputing it later, after a repeat
-- attempt or an amendment, would rewrite history and turn an agreement into a disagreement (or the
-- reverse) with nothing in the row to show why. The assessor-fairness work reads the pair, so the
-- pair must be stable.
--
-- record_competencies gets the same two columns, so that finalising a session (step 31) freezes the
-- proposal with the grade and does not need a migration of its own.
-- Forward-only, idempotent.

ALTER TABLE competency_grades
  ADD COLUMN IF NOT EXISTS proposed_grade  TEXT,
  ADD COLUMN IF NOT EXISTS proposed_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS proposed_basis  JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN competency_grades.proposed_grade IS
  'What the task grades targeting this competency added up to when the instructor graded it, in the same vocabulary as grade. Advisory: never read as the grade, never written over grade, never recomputed in place.';
COMMENT ON COLUMN competency_grades.proposed_at IS
  'When the proposal was computed. NULL means no proposal was made - normally because no task targeting the competency had a scored grade yet.';
COMMENT ON COLUMN competency_grades.proposed_basis IS
  'The evidence behind the proposal: n_scored, mean, critical, the element keys it read and how many observable behaviours were selected. Rendered beside the grade so the instructor can see what they are disagreeing with.';

ALTER TABLE record_competencies
  ADD COLUMN IF NOT EXISTS proposed_grade  TEXT,
  ADD COLUMN IF NOT EXISTS proposed_basis  JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN record_competencies.proposed_grade IS
  'The frozen copy of competency_grades.proposed_grade. A record carries the disagreement it was signed with.';

-- Finding the competency grades where the instructor moved away from the proposal is a question the
-- standardisation manager asks across the whole bench, so it gets an index rather than a scan.
CREATE INDEX IF NOT EXISTS competency_grades_override
  ON competency_grades (competency_id)
  WHERE proposed_grade IS NOT NULL AND grade IS DISTINCT FROM proposed_grade;

DO $$ BEGIN RAISE NOTICE '0149: proposed competency grade stored beside the instructor grade (competency_grades, record_competencies).'; END $$;
