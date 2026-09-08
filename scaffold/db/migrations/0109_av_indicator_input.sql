-- 0109_av_indicator_input.sql
-- Analytics layer, part 10 of 20. docs/06_ANALYTICS.md §5.
-- Program-level indicator inputs, unified across metric and grain.
--
-- One row shape for every series the indicator can draw, so that the status
-- engine in lib/analytics/program-indicator.ts has exactly one input type.

CREATE OR REPLACE VIEW av_indicator_input AS
-- below-standard rate, competency grain
SELECT 'below_standard_rate'::TEXT AS metric,
       'competency'::TEXT          AS grain,
       pc.scope,
       pc.framework_id,
       pc.competency_id,
       pc.period,
       pc.n_below                  AS num,
       pc.n                        AS den
FROM av_period_competency pc
UNION ALL
-- below-standard rate, overall grain
SELECT 'below_standard_rate',
       'overall',
       po.scope,
       po.framework_id,
       NULL::UUID,
       po.period,
       po.n_below_grades,
       po.n_grades
FROM av_period_overall po
UNION ALL
-- adverse-competency rate, OVERALL GRAIN ONLY
SELECT 'adverse_competency_rate',
       'overall',
       po.scope,
       po.framework_id,
       NULL::UUID,
       po.period,
       po.n_adverse,
       po.n_records
FROM av_period_overall po;

COMMENT ON VIEW av_indicator_input IS
  'One row per (metric, grain, scope, framework, competency, period) with a raw numerator and '
  'denominator - never a rate, so that pooling downstream sums counts rather than averaging '
  'percentages. The adverse-competency rate appears at OVERALL GRAIN ONLY, deliberately: at '
  'competency grain each record grades a competency once, so "records with at least one '
  'below-standard grade in competency c" is identical to "below-standard grade events in competency '
  'c" and the metric collapses onto the below-standard rate. Publishing it at competency grain would '
  'print one metric under two names.';

-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW av_indicator_series AS
SELECT ii.*,
       CASE WHEN ii.den > 0 THEN ii.num::NUMERIC / ii.den END AS rate,
       (ii.den < analytics_int('suppression.min_n_rate'))      AS is_suppressed,
       sc.period_grain,
       sc.default_window_periods
FROM av_indicator_input ii
JOIN av_scope sc ON sc.scope = ii.scope;

COMMENT ON VIEW av_indicator_series IS
  'One row per period of one indicator series, carrying the proportion and its suppression flag. '
  'The full series is served in one call and windowed by the client, so panning never refetches and '
  'the base statistics are always computed over the same rows the chart is drawn from. rate is NULL '
  'when suppressed; a suppressed period BREAKS a consecutive-period run in the status engine rather '
  'than continuing it, because absence of evidence must not accumulate as evidence.';
