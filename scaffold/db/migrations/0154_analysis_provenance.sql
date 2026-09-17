-- 0154_analysis_provenance.sql
-- The provenance gate's verdict, stored with the run, and a status for what the gate does.
--
-- WHY A 'rejected' STATUS SEPARATE FROM 'failed'. They are different events and the difference is
-- the whole point of the pipeline. 'failed' is the machinery breaking: the endpoint answered with
-- something that could not be made to satisfy the schema, or nothing at all. 'rejected' is the
-- machinery WORKING: the model wrote a well-formed narrative, the gate checked every number in it
-- against the figures the deterministic core computed, found one that had no source, and refused
-- to publish it. An operator seeing "failed" goes looking for an outage. An operator seeing
-- "rejected" has just watched the safety property hold, and the report says which figure it was.
--
-- The narrative of a rejected run IS stored, deliberately, so the prompt or the figure set can be
-- corrected by looking at what was actually written. It is never shown as a report.

ALTER TABLE analysis_runs DROP CONSTRAINT IF EXISTS analysis_runs_status_check;
ALTER TABLE analysis_runs
  ADD CONSTRAINT analysis_runs_status_check
  CHECK (status IN ('queued','running','complete','rejected','failed'));

ALTER TABLE analysis_runs ADD COLUMN IF NOT EXISTS provenance JSONB;

COMMENT ON COLUMN analysis_runs.provenance IS
  'The gate report: score, coverage, and every number in the narrative that had no figure behind it. Present on complete AND rejected runs - a passing run that cannot show its score is not evidence either.';
COMMENT ON COLUMN analysis_runs.status IS
  'queued | running | complete | rejected (gate refused the narrative) | failed (the call or the schema broke).';

DO $$
BEGIN
  RAISE NOTICE '0154: analysis_runs gains provenance and the rejected status.';
END $$;
