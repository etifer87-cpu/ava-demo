-- 0147_assessor_materialised.sql
-- The assessor analytics, materialised as a staged pipeline.
--
-- WHY. The kit's assessor views (0111-0116) are correct and stay the definition, but they are
-- written as a stack of views over views: av_assessor_expected alone reads av_assessor_occurrence
-- seven times (the rank-window self-join, the three fallback levels, the outer select), and each of
-- those re-derives the whole grade-event spine - competency_grades UNION record_competencies, with
-- a window sort - from scratch. Read once per page that is a timeout; read once per stage of a
-- build it is minutes of repeated work. Worse, the level-2 fallback self-joins every occurrence of
-- a pilot against every other occurrence of the same pilot with no window at all: with three years
-- of history that is tens of millions of pairs, computed to produce one number per pilot.
--
-- WHAT THIS FILE DOES. It walks the same algebra once, materialising each stage and ANALYZE-ing it
-- so the next stage gets a real row estimate and an index instead of a re-derivation:
--
--   mv_assessor_grades      the whole graded corpus, once          (= av_assessor_grades)
--   mv_assessor_occurrence  competency grades, ranked in (subject, competency)
--   mv_assessor_expected    the expected grade and its fallback level
--   mv_assessor_residual    grade - expected
--   ... then the per-assessor rollups, the habits and the distributions.
--
-- Every figure is the figure the views define. Two stages are re-expressed rather than re-run:
--
--   * the level-2 fallback is computed in closed form. avg over pairs (o, p) of the same pilot with
--     a different assessor is, per pilot, sum_a C_a * (T - S_a) / sum_a C_a * (N - C_a), where T
--     and N are that pilot's grade total and count and S_a, C_a the same per assessor. Same number,
--     no join. (IS DISTINCT FROM means an unresolved assessor is its own group, which this keeps.)
--   * the not-observed baseline and excess are taken from mv_assessor_grades rather than from
--     av_competency_grade_events joined to av_record_dim again; the columns are the same columns.
--
-- Level 1 keeps its self-join: expected.window_rank bounds it inside one (subject, competency), so
-- it is small once the input is an indexed table.
--
-- Refreshed by refresh_assessor_analytics(), which scripts/seed-history.mjs calls after a write and
-- `npm run analytics:refresh` runs by hand. A screen reads mv_*; nothing rebuilds on a page read.

SET LOCAL search_path TO public, pg_catalog;
SET LOCAL statement_timeout = 0;

-- PostgreSQL 17 runs CREATE MATERIALIZED VIEW ... WITH DATA and REFRESH MATERIALIZED VIEW with
-- search_path restricted to pg_catalog, pg_temp (a maintenance-command safety rule). A view body
-- survives that - it is stored resolved - but the config readers are SQL and plpgsql functions
-- whose bodies are re-parsed at call time: analytics_int() calls analytics_number(), which calls
-- analytics_require(), which reads analytics_config, all unqualified. Under the restricted path the
-- first of those fails with "function analytics_number(text) does not exist", which is why this
-- file failed before it did anything. Pinning search_path on every public SQL/plpgsql function
-- makes them behave identically however they are reached, maintenance command or ordinary query.
DO $$
DECLARE f RECORD; n INT := 0;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
      JOIN pg_namespace ns ON ns.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang
     WHERE ns.nspname = 'public' AND p.prokind = 'f' AND l.lanname IN ('sql', 'plpgsql')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
       AND NOT EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%')
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_catalog', f.sig);
    n := n + 1;
  END LOOP;
  RAISE NOTICE '0147: search_path pinned on % public function(s)', n;
  PERFORM public.analytics_number('assessor_fairness.adjusted_delta.k_shrink');
END $$;

-- Every threshold below is read from analytics_config as a qualified scalar subquery: the planner
-- evaluates each once for the whole statement, so no stage calls a config function per row, and
-- nothing here hardcodes a value that belongs in config/analytics.yaml. A materialised view may not
-- depend on a temporary table, which is why these are subqueries rather than locals.

-- ---------------------------------------------------------------------------
-- Stage 1. The graded corpus, once.
DO $$ DECLARE t TIMESTAMPTZ := clock_timestamp(); n BIGINT;
BEGIN
  CREATE MATERIALIZED VIEW public.mv_assessor_grades AS SELECT * FROM public.av_assessor_grades;
  CREATE INDEX mv_assessor_grades_assessor ON public.mv_assessor_grades (assessor_id);
  CREATE INDEX mv_assessor_grades_kind ON public.mv_assessor_grades (grade_kind);
  CREATE INDEX mv_assessor_grades_template ON public.mv_assessor_grades (template_code, asset_class_id);
  ANALYZE public.mv_assessor_grades;
  SELECT count(*) INTO n FROM public.mv_assessor_grades;
  RAISE NOTICE '0147: stage 1 graded corpus - % rows in %', n, clock_timestamp() - t;
END $$;

-- Stage 2. Competency grades, ranked within (subject, competency). Same rows as
-- av_assessor_occurrence: that view reads av_competency_grade_events, which is the competency half
-- of the corpus above, and keeps only a scored grade.
DO $$ DECLARE t TIMESTAMPTZ := clock_timestamp(); n BIGINT;
BEGIN
  CREATE MATERIALIZED VIEW public.mv_assessor_occurrence AS
  SELECT g.record_id, g.subject_id, g.competency_id, g.framework_id, g.assessor_id, g.occurred_on, g.grade_value,
         row_number() OVER (PARTITION BY g.subject_id, g.competency_id ORDER BY g.occurred_on, g.record_id) AS occurrence_rank
    FROM public.mv_assessor_grades g
   WHERE g.grade_kind = 'competency' AND g.grade_value IS NOT NULL;
  CREATE INDEX mv_assessor_occurrence_pair ON public.mv_assessor_occurrence (subject_id, competency_id, occurrence_rank);
  CREATE INDEX mv_assessor_occurrence_subject ON public.mv_assessor_occurrence (subject_id);
  CREATE INDEX mv_assessor_occurrence_competency ON public.mv_assessor_occurrence (competency_id);
  CREATE INDEX mv_assessor_occurrence_record ON public.mv_assessor_occurrence (record_id, competency_id);
  ANALYZE public.mv_assessor_occurrence;
  SELECT count(*) INTO n FROM public.mv_assessor_occurrence;
  RAISE NOTICE '0147: stage 2 occurrences - % rows in %', n, clock_timestamp() - t;
END $$;

-- Stage 3. The expected grade: what the SAME pilot scored in the SAME competency with OTHER
-- instructors, weighted 0.5 ^ (rank distance / half_life) and renormalised over the peers used,
-- with the three fallbacks and the level recorded on every row (0113).
DO $$ DECLARE t TIMESTAMPTZ := clock_timestamp(); n BIGINT; lv RECORD;
BEGIN
  CREATE MATERIALIZED VIEW public.mv_assessor_expected AS
  WITH pairs AS (
    SELECT o.record_id, o.competency_id,
           count(*) AS peer_n,
           sum(power(0.5, abs(o.occurrence_rank - p.occurrence_rank)::NUMERIC / (SELECT value_num FROM public.analytics_config WHERE key = 'assessor_fairness.expected.half_life')) * p.grade_value)
             / NULLIF(sum(power(0.5, abs(o.occurrence_rank - p.occurrence_rank)::NUMERIC / (SELECT value_num FROM public.analytics_config WHERE key = 'assessor_fairness.expected.half_life'))), 0) AS expected
      FROM public.mv_assessor_occurrence o
      JOIN public.mv_assessor_occurrence p
        ON p.subject_id = o.subject_id
       AND p.competency_id = o.competency_id
       AND p.record_id <> o.record_id
       AND p.assessor_id IS DISTINCT FROM o.assessor_id
       AND abs(p.occurrence_rank - o.occurrence_rank) <= (SELECT value_num::INT FROM public.analytics_config WHERE key = 'assessor_fairness.expected.window_rank')
     GROUP BY o.record_id, o.competency_id
  ),
  -- Level 2 in closed form: avg over pairs (o, p) of the same pilot with a different assessor.
  per_assessor AS (
    SELECT subject_id, assessor_id, count(*)::NUMERIC AS c, sum(grade_value)::NUMERIC AS s
      FROM public.mv_assessor_occurrence GROUP BY subject_id, assessor_id
  ),
  per_subject AS (
    SELECT subject_id, sum(c) AS n_all, sum(s) AS t_all FROM per_assessor GROUP BY subject_id
  ),
  level2 AS (
    SELECT a.subject_id,
           sum(a.c * (ps.t_all - a.s)) / NULLIF(sum(a.c * (ps.n_all - a.c)), 0) AS expected
      FROM per_assessor a JOIN per_subject ps ON ps.subject_id = a.subject_id
     GROUP BY a.subject_id
  ),
  level3 AS (SELECT competency_id, avg(grade_value) AS expected FROM public.mv_assessor_occurrence GROUP BY competency_id),
  level4 AS (SELECT avg(grade_value) AS expected FROM public.mv_assessor_occurrence)
  SELECT o.record_id, o.subject_id, o.competency_id, o.framework_id, o.assessor_id, o.occurred_on, o.grade_value,
         COALESCE(pr.peer_n, 0) AS peer_n,
         CASE
           WHEN pr.expected IS NOT NULL AND pr.peer_n >= (SELECT value_num::INT FROM public.analytics_config WHERE key = 'assessor_fairness.expected.min_grades') THEN 1
           WHEN l2.expected IS NOT NULL THEN 2
           WHEN l3.expected IS NOT NULL THEN 3
           ELSE 4
         END AS fallback_level,
         COALESCE(
           CASE WHEN pr.peer_n >= (SELECT value_num::INT FROM public.analytics_config WHERE key = 'assessor_fairness.expected.min_grades') THEN pr.expected END,
           l2.expected, l3.expected, (SELECT expected FROM level4)
         ) AS expected
    FROM public.mv_assessor_occurrence o
    LEFT JOIN pairs pr ON pr.record_id = o.record_id AND pr.competency_id = o.competency_id
    LEFT JOIN level2 l2 ON l2.subject_id = o.subject_id
    LEFT JOIN level3 l3 ON l3.competency_id = o.competency_id;
  CREATE INDEX mv_assessor_expected_assessor ON public.mv_assessor_expected (assessor_id);
  ANALYZE public.mv_assessor_expected;
  SELECT count(*) INTO n FROM public.mv_assessor_expected;
  SELECT count(*) FILTER (WHERE fallback_level = 1) AS l1, count(*) FILTER (WHERE fallback_level > 1) AS rest
    INTO lv FROM public.mv_assessor_expected;
  RAISE NOTICE '0147: stage 3 expected grades - % rows in % (level 1: %, fell back: %)', n, clock_timestamp() - t, lv.l1, lv.rest;
END $$;

-- Stage 4. Residuals (0114). Grade minus what the pilot's other evidence supports.
DO $$ DECLARE t TIMESTAMPTZ := clock_timestamp(); n BIGINT;
BEGIN
  CREATE MATERIALIZED VIEW public.mv_assessor_residual AS
  SELECT e.record_id, e.subject_id, e.competency_id, e.framework_id, e.assessor_id, e.occurred_on, e.grade_value,
         e.expected, e.fallback_level, (e.grade_value - e.expected)::NUMERIC AS residual
    FROM public.mv_assessor_expected e
   WHERE e.expected IS NOT NULL;
  CREATE INDEX mv_assessor_residual_assessor ON public.mv_assessor_residual (assessor_id);
  CREATE INDEX mv_assessor_residual_competency ON public.mv_assessor_residual (assessor_id, competency_id);
  ANALYZE public.mv_assessor_residual;
  SELECT count(*) INTO n FROM public.mv_assessor_residual;
  RAISE NOTICE '0147: stage 4 residuals - % rows in %', n, clock_timestamp() - t;
END $$;

-- ---------------------------------------------------------------------------
-- Stage 5. The per-assessor rollups, the habits, the distributions.
DO $$ DECLARE t TIMESTAMPTZ := clock_timestamp(); n BIGINT;
BEGIN
  -- av_assessor_adjusted (0114): the shrunk delta with its interval.
  CREATE MATERIALIZED VIEW public.mv_assessor_adjusted AS
  WITH agg AS (
    SELECT r.assessor_id,
           count(*) AS n_grades, count(DISTINCT r.record_id) AS n_records, count(DISTINCT r.subject_id) AS n_subjects,
           avg(r.residual)::NUMERIC AS delta_raw_residual, stddev_samp(r.residual)::NUMERIC AS sd_residual,
           avg(r.grade_value)::NUMERIC AS mean_grade, stddev_samp(r.grade_value)::NUMERIC AS sigma_grade,
           max(r.occurred_on) AS last_graded_on,
           avg(CASE WHEN r.fallback_level > 1 THEN 1 ELSE 0 END)::NUMERIC AS share_above_level_1
      FROM public.mv_assessor_residual r WHERE r.assessor_id IS NOT NULL GROUP BY r.assessor_id
  ),
  group_mean AS (SELECT avg(grade_value) AS m FROM public.mv_assessor_occurrence)
  SELECT a.assessor_id, a.n_grades, a.n_records, a.n_subjects, a.mean_grade, a.sigma_grade, a.last_graded_on, a.share_above_level_1,
         (a.mean_grade - (SELECT m FROM group_mean))::NUMERIC AS delta_unadjusted,
         a.delta_raw_residual,
         (a.delta_raw_residual * a.n_grades / (a.n_grades + (SELECT value_num FROM public.analytics_config WHERE key = 'assessor_fairness.adjusted_delta.k_shrink')))::NUMERIC AS delta_adjusted,
         ((SELECT value_num FROM public.analytics_config WHERE key = 'assessor_fairness.adjusted_delta.ci_z') * a.sd_residual / sqrt(NULLIF(a.n_grades, 0)))::NUMERIC AS ci_half_width,
         (a.n_records < (SELECT value_num::INT FROM public.analytics_config WHERE key = 'assessor_fairness.adjusted_delta.min_records_banded')) AS is_provisional,
         ( a.n_records >= (SELECT value_num::INT FROM public.analytics_config WHERE key = 'assessor_fairness.adjusted_delta.min_records_banded')
           AND abs(a.delta_raw_residual * a.n_grades / (a.n_grades + (SELECT value_num FROM public.analytics_config WHERE key = 'assessor_fairness.adjusted_delta.k_shrink'))) >= (SELECT value_num FROM public.analytics_config WHERE key = 'assessor_fairness.adjusted_delta.outlier_abs')
         ) AS is_outlier
    FROM agg a;
  CREATE UNIQUE INDEX mv_assessor_adjusted_pk ON public.mv_assessor_adjusted (assessor_id);

  -- av_assessor_competency_raw (0114). LABELLED RAW wherever it is shown: not shrunk, not banded.
  CREATE MATERIALIZED VIEW public.mv_assessor_competency_raw AS
  SELECT r.assessor_id, r.competency_id, r.framework_id,
         count(*) AS n, avg(r.grade_value)::NUMERIC AS own_mean, avg(r.residual)::NUMERIC AS mean_residual
    FROM public.mv_assessor_residual r WHERE r.assessor_id IS NOT NULL
   GROUP BY r.assessor_id, r.competency_id, r.framework_id;
  CREATE UNIQUE INDEX mv_assessor_competency_raw_pk ON public.mv_assessor_competency_raw (assessor_id, competency_id, framework_id);

  -- av_assessor_monthly (0115): the additive rollup every windowed metric is recovered from.
  CREATE MATERIALIZED VIEW public.mv_assessor_monthly AS
  SELECT r.assessor_id, date_trunc('month', r.occurred_on)::DATE AS period_month,
         count(*) AS n_grades, count(DISTINCT r.record_id) AS n_records,
         sum(r.grade_value)::NUMERIC AS sum_g, sum(r.grade_value::NUMERIC ^ 2) AS sum_g2,
         sum(r.residual) AS sum_r, sum(r.residual ^ 2) AS sum_r2,
         sum(EXTRACT(EPOCH FROM r.occurred_on::TIMESTAMP) / 86400.0) AS sum_x,
         sum((EXTRACT(EPOCH FROM r.occurred_on::TIMESTAMP) / 86400.0) ^ 2) AS sum_x2,
         sum((EXTRACT(EPOCH FROM r.occurred_on::TIMESTAMP) / 86400.0) * r.residual) AS sum_xr
    FROM public.mv_assessor_residual r WHERE r.assessor_id IS NOT NULL
   GROUP BY r.assessor_id, date_trunc('month', r.occurred_on);
  CREATE UNIQUE INDEX mv_assessor_monthly_pk ON public.mv_assessor_monthly (assessor_id, period_month);

  -- Group means: one row per competency plus the overall row (everyone = true).
  CREATE MATERIALIZED VIEW public.mv_assessor_group AS
  SELECT competency_id, GROUPING(competency_id) = 1 AS everyone, avg(grade_value)::NUMERIC AS group_mean, count(*) AS n
    FROM public.mv_assessor_occurrence GROUP BY ROLLUP (competency_id);
  CREATE INDEX mv_assessor_group_competency ON public.mv_assessor_group (competency_id);

  -- Grade distribution; everyone = true is the whole population (an unresolved assessor is a NULL
  -- assessor_id with everyone = false).
  CREATE MATERIALIZED VIEW public.mv_assessor_distribution AS
  SELECT assessor_id, GROUPING(assessor_id) = 1 AS everyone, grade_value::INT AS grade, count(*) AS n
    FROM public.mv_assessor_grades
   WHERE grade_kind = 'competency' AND grade_value IS NOT NULL
   GROUP BY ROLLUP (assessor_id), grade_value;
  CREATE INDEX mv_assessor_distribution_assessor ON public.mv_assessor_distribution (assessor_id);

  -- av_assessor_justification and av_assessor_halo (0116), from the materialised corpus.
  CREATE MATERIALIZED VIEW public.mv_assessor_justification AS
  SELECT g.assessor_id,
         count(*) FILTER (WHERE g.is_below_standard) AS n_below_standard,
         count(*) FILTER (WHERE g.is_below_standard AND g.remark_words >= (SELECT value_num::INT FROM public.analytics_config WHERE key = 'assessor_fairness.justification.min_words')) AS n_substantive,
         count(*) FILTER (WHERE g.grade_value <= (SELECT value_num::INT FROM public.analytics_config WHERE key = 'assessor_fairness.justification.grade_max') AND g.remark_words < (SELECT value_num::INT FROM public.analytics_config WHERE key = 'assessor_fairness.justification.min_words')) AS n_unjustified_low,
         count(*) FILTER (WHERE g.remark_words > 0) AS n_with_remark,
         count(*) FILTER (WHERE g.grade_value IS NOT NULL) AS n_valid
    FROM public.mv_assessor_grades g WHERE g.assessor_id IS NOT NULL GROUP BY g.assessor_id;
  CREATE UNIQUE INDEX mv_assessor_justification_pk ON public.mv_assessor_justification (assessor_id);

  CREATE MATERIALIZED VIEW public.mv_assessor_halo AS
  WITH per_record AS (
    SELECT g.assessor_id, g.record_id,
           count(*) FILTER (WHERE g.grade_value IS NOT NULL) AS graded,
           count(DISTINCT g.grade_value) AS distinct_grades
      FROM public.mv_assessor_grades g
     WHERE g.grade_kind = 'competency' AND g.assessor_id IS NOT NULL
     GROUP BY g.assessor_id, g.record_id
  )
  SELECT assessor_id,
         count(*) FILTER (WHERE graded >= (SELECT value_num::INT FROM public.analytics_config WHERE key = 'assessor_fairness.habits.halo.min_competencies_graded')) AS n_eligible_records,
         count(*) FILTER (WHERE graded >= (SELECT value_num::INT FROM public.analytics_config WHERE key = 'assessor_fairness.habits.halo.min_competencies_graded') AND distinct_grades = 1) AS n_halo_records
    FROM per_record GROUP BY assessor_id;
  CREATE UNIQUE INDEX mv_assessor_halo_pk ON public.mv_assessor_halo (assessor_id);

  -- av_assessor_nr_baseline / av_assessor_nr_excess (0116): not-observed above what the same
  -- programs on the same fleet produce.
  CREATE MATERIALIZED VIEW public.mv_assessor_nr_excess AS
  WITH comp AS (
    SELECT assessor_id, template_code, asset_class_id, grade_value
      FROM public.mv_assessor_grades WHERE grade_kind = 'competency'
  ),
  baseline AS (
    SELECT template_code, asset_class_id, count(*) AS n_events,
           avg(CASE WHEN grade_value IS NULL THEN 1 ELSE 0 END)::NUMERIC AS expected_nr_rate
      FROM comp GROUP BY template_code, asset_class_id
  ),
  actual AS (
    SELECT assessor_id, template_code, asset_class_id, count(*) AS n_events,
           avg(CASE WHEN grade_value IS NULL THEN 1 ELSE 0 END)::NUMERIC AS actual_nr_rate
      FROM comp WHERE assessor_id IS NOT NULL GROUP BY assessor_id, template_code, asset_class_id
  )
  SELECT a.assessor_id, sum(a.n_events) AS n_events,
         sum(a.actual_nr_rate * a.n_events) / NULLIF(sum(a.n_events), 0) AS actual_nr_rate,
         sum(b.expected_nr_rate * a.n_events) / NULLIF(sum(a.n_events), 0) AS expected_nr_rate,
         greatest( sum(a.actual_nr_rate * a.n_events) / NULLIF(sum(a.n_events), 0)
                 - sum(b.expected_nr_rate * a.n_events) / NULLIF(sum(a.n_events), 0), 0) AS nr_excess
    FROM actual a
    JOIN baseline b ON b.template_code = a.template_code AND b.asset_class_id IS NOT DISTINCT FROM a.asset_class_id
   GROUP BY a.assessor_id;
  CREATE UNIQUE INDEX mv_assessor_nr_excess_pk ON public.mv_assessor_nr_excess (assessor_id);

  ANALYZE public.mv_assessor_adjusted;
  ANALYZE public.mv_assessor_competency_raw;
  ANALYZE public.mv_assessor_monthly;
  ANALYZE public.mv_assessor_group;
  ANALYZE public.mv_assessor_distribution;
  SELECT count(*) INTO n FROM public.mv_assessor_adjusted;
  RAISE NOTICE '0147: stage 5 rollups - % assessors in %', n, clock_timestamp() - t;
END $$;

-- ---------------------------------------------------------------------------
-- The refresh. Order is the dependency order, and what REFRESH re-runs is each stage's own stored
-- SQL - so a threshold changed in analytics.yaml and reloaded takes effect on the next refresh
-- without this file being touched.
CREATE OR REPLACE FUNCTION refresh_assessor_analytics() RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE t TIMESTAMPTZ := clock_timestamp();
BEGIN
  REFRESH MATERIALIZED VIEW public.mv_assessor_grades;
  REFRESH MATERIALIZED VIEW public.mv_assessor_occurrence;
  REFRESH MATERIALIZED VIEW public.mv_assessor_expected;
  REFRESH MATERIALIZED VIEW public.mv_assessor_residual;
  REFRESH MATERIALIZED VIEW public.mv_assessor_adjusted;
  REFRESH MATERIALIZED VIEW public.mv_assessor_competency_raw;
  REFRESH MATERIALIZED VIEW public.mv_assessor_monthly;
  REFRESH MATERIALIZED VIEW public.mv_assessor_group;
  REFRESH MATERIALIZED VIEW public.mv_assessor_distribution;
  REFRESH MATERIALIZED VIEW public.mv_assessor_justification;
  REFRESH MATERIALIZED VIEW public.mv_assessor_halo;
  REFRESH MATERIALIZED VIEW public.mv_assessor_nr_excess;
  RAISE NOTICE 'assessor analytics refreshed in %', clock_timestamp() - t;
END $$;

COMMENT ON FUNCTION refresh_assessor_analytics() IS
  'Rebuilds the materialised assessor analytics in dependency order. Called by scripts/seed-history.mjs '
  'after a write and by npm run analytics:refresh. Not concurrent: the demo has one writer.';

-- ---------------------------------------------------------------------------
DO $$
DECLARE n_res BIGINT; n_adj BIGINT; n_mon BIGINT;
BEGIN
  SELECT count(*) INTO n_res FROM public.mv_assessor_residual;
  SELECT count(*) INTO n_adj FROM public.mv_assessor_adjusted;
  SELECT count(*) INTO n_mon FROM public.mv_assessor_monthly;
  IF n_res = 0 THEN
    RAISE EXCEPTION '0147: mv_assessor_residual is empty. Either no record carries a competency grade, or the expected-grade stage produced nothing - the bench would show no leaning at all, so this is refused rather than shipped empty.';
  END IF;
  RAISE NOTICE '0147: materialised - % residual rows, % assessors, % assessor-months. refresh_assessor_analytics() added.', n_res, n_adj, n_mon;
END $$;
