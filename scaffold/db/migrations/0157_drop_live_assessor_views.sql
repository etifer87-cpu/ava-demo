-- 0157_drop_live_assessor_views.sql
-- Removes seven av_assessor_* views that cannot be computed and that nothing reads.
--
-- WHAT THEY WERE. The live, unmaterialised form of the assessor-fairness chain. Migration 0147
-- replaced them with mv_assessor_* precisely because, in its own words, the comparison behind them
-- "cannot be computed inside a page request" - every screen reads the materialised form, and
-- scripts/refresh-analytics.mjs keeps it current. The live twins were left behind.
--
-- WHY THEY GO RATHER THAN GET FIXED. They are not slow; they are quadratic. Measured on this
-- database, 2026-09-19: a probe of av_assessor_adjusted for ONE row ran 2h25m without returning,
-- with parallelism disabled it still passed 120s, and its plan expands the chain six times with
-- every estimate reading rows=1 against an actual ~75,000, so the planner chooses nested loops.
-- Fixing that means rebuilding the materialisation 0147 already built. Keeping them means a schema
-- full of views no one can run, which the next reader will assume work.
--
-- WHAT READS THEM: nothing. No page, no library, no script, no other view - only the gate suite,
-- which probed them because they exist. Checked across lib/, app/, scripts/ and db/migrations/
-- before this migration was written.
--
-- WHAT IS NOT TOUCHED. mv_assessor_* and refresh_assessor_analytics() are untouched, and so are
-- av_assessor_grades, av_assessor_occurrence, av_assessor_halo, av_assessor_justification,
-- av_assessor_leniency, av_assessor_nr_baseline and av_assessor_nr_excess, which all return inside
-- the gate's budget. The two av_indicator_* views that also exceed it are a DIFFERENT problem -
-- they carry the program-indicator bands, a gate assertion reads one of them, and their cost is the
-- per-row config read that migration 0155 addressed for the application. They are handled separately
-- and deliberately survive this migration.
--
-- Forward-only. Re-runnable.

-- No CASCADE, deliberately. Every dependency among these seven is internal - adjusted,
-- competency_raw, monthly and status read residual; window_records reads residual too; residual
-- reads expected - and nothing outside the set references any of them, which was checked before
-- this was written. Dropping in dependency order therefore succeeds on its own, and a DROP that
-- fails here means something depends on these that this migration does not know about. That is a
-- fact worth stopping for, which CASCADE would have hidden by deleting it.
DROP VIEW IF EXISTS av_assessor_adjusted;
DROP VIEW IF EXISTS av_assessor_competency_raw;
DROP VIEW IF EXISTS av_assessor_monthly;
DROP VIEW IF EXISTS av_assessor_status;
DROP VIEW IF EXISTS av_assessor_window_records;
DROP VIEW IF EXISTS av_assessor_residual;
DROP VIEW IF EXISTS av_assessor_expected;

DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM pg_matviews
   WHERE schemaname = 'public' AND matviewname LIKE 'mv\_assessor\_%';
  IF n = 0 THEN
    RAISE EXCEPTION 'refusing to leave the assessor analytics with no materialised form: '
      'mv_assessor_* is missing. Run migration 0147 before this one.';
  END IF;
  RAISE NOTICE '0157: seven live av_assessor_* views dropped; % materialised view(s) remain and are '
    'what every screen reads.', n;
END $$;
