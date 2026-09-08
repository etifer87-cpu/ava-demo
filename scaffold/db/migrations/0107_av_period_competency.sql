-- 0107_av_period_competency.sql
-- Analytics layer, part 8 of 20. docs/06_ANALYTICS.md §4.1.
-- Below-standard rate inputs: period x competency x scope.

CREATE OR REPLACE VIEW av_period_competency AS
SELECT rs.scope,
       rs.period,
       cge.framework_id,
       cge.competency_id,
       count(*) FILTER (WHERE cge.grade_value IS NOT NULL)  AS n,
       count(*) FILTER (WHERE cge.is_below_standard)        AS n_below,
       count(*) FILTER (WHERE cge.is_critical)              AS n_critical,
       count(*) FILTER (WHERE cge.grade_value = 1)          AS n_g1,
       count(*) FILTER (WHERE cge.grade_value = 2)          AS n_g2,
       count(*) FILTER (WHERE cge.grade_value = 3)          AS n_g3,
       count(*) FILTER (WHERE cge.grade_value = 4)          AS n_g4,
       count(*) FILTER (WHERE cge.grade_value = 5)          AS n_g5,
       CASE WHEN count(*) FILTER (WHERE cge.grade_value IS NOT NULL) > 0
            THEN count(*) FILTER (WHERE cge.is_below_standard)::NUMERIC
               / count(*) FILTER (WHERE cge.grade_value IS NOT NULL)
       END                                                  AS rate,
       (count(*) FILTER (WHERE cge.grade_value IS NOT NULL)
          < analytics_int('suppression.min_n_rate'))        AS is_suppressed
FROM av_competency_grade_events cge
JOIN av_record_scope rs ON rs.record_id = cge.record_id
GROUP BY rs.scope, rs.period, cge.framework_id, cge.competency_id;

COMMENT ON VIEW av_period_competency IS
  'One row per (scope, period, framework, competency): the below-standard rate over GRADE EVENTS, '
  'with the per-grade counts that feed every distribution chart. rate is a proportion in [0,1] and '
  'stays one all the way to the render step - the display denominator is applied at render only, to '
  'values and reference lines together, so no threshold comparison can be reordered by it. '
  'is_suppressed marks n below suppression.min_n_rate; the consumer renders "n<30" and treats the '
  'rate as absent, never as zero. The per-grade columns are explicit rather than a crosstab so that '
  'a grade band with no occurrences still produces a zero rather than a missing key.';

-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW av_period_competency_pooled AS
SELECT scope,
       period,
       framework_id,
       sum(n)        AS n,
       sum(n_below)  AS n_below,
       CASE WHEN sum(n) > 0 THEN sum(n_below)::NUMERIC / sum(n) END AS rate,
       (sum(n) < analytics_int('suppression.min_n_rate')) AS is_suppressed
FROM av_period_competency
GROUP BY scope, period, framework_id;

COMMENT ON VIEW av_period_competency_pooled IS
  'One row per (scope, period, framework): the below-standard rate POOLED across competencies, '
  'computed as sum(n_below) / sum(n) and never as the mean of the per-competency rates. Averaging '
  'rates gives every competency equal weight regardless of how often it was graded, which is a '
  'different and unstated metric.';
