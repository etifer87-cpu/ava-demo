-- 0108_av_period_overall.sql
-- Analytics layer, part 9 of 20. docs/06_ANALYTICS.md §4.2.
-- Adverse-competency rate inputs: period x scope, RECORD-denominated.

CREATE OR REPLACE VIEW av_period_overall AS
SELECT rs.scope,
       rs.period,
       rr.framework_id,
       count(*) FILTER (WHERE rr.has_valid_grade)                 AS n_records,
       count(*) FILTER (WHERE rr.is_adverse)                      AS n_adverse,
       count(*) FILTER (WHERE rr.is_flagged)                      AS n_flagged,
       sum(rr.n_valid)                                            AS n_grades,
       sum(rr.n_below_standard)                                   AS n_below_grades,
       CASE WHEN count(*) FILTER (WHERE rr.has_valid_grade) > 0
            THEN count(*) FILTER (WHERE rr.is_adverse)::NUMERIC
               / count(*) FILTER (WHERE rr.has_valid_grade)
       END                                                        AS adverse_competency_rate,
       CASE WHEN sum(rr.n_valid) > 0
            THEN sum(rr.n_below_standard)::NUMERIC / sum(rr.n_valid)
       END                                                        AS below_standard_rate,
       (count(*) FILTER (WHERE rr.has_valid_grade)
          < analytics_int('suppression.min_n_rate'))              AS acr_suppressed,
       (sum(rr.n_valid) < analytics_int('suppression.min_n_rate')) AS bsr_suppressed
FROM av_record_rollup rr
JOIN av_record_scope rs ON rs.record_id = rr.record_id
GROUP BY rs.scope, rs.period, rr.framework_id;

COMMENT ON VIEW av_period_overall IS
  'One row per (scope, period, framework) carrying BOTH headline rates side by side, each with its own '
  'numerator, its own denominator and its own suppression flag. adverse_competency_rate is denominated '
  'in RECORDS (n_adverse / n_records); below_standard_rate is denominated in GRADE EVENTS '
  '(n_below_grades / n_grades). The two denominators differ by roughly the number of competencies '
  'graded per record, so their display denominators describe different exposures and the two series '
  'must never share a y-axis or a unit string. Both are emitted here precisely so that a consumer '
  'cannot pick one denominator and label it with the other metric''s unit.';

-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW av_period_subject_counts AS
SELECT rs.scope,
       rs.period,
       count(DISTINCT rr.subject_id)  AS subjects,
       count(DISTINCT rr.assessor_id) AS assessors,
       count(*)                       AS records
FROM av_record_rollup rr
JOIN av_record_scope rs ON rs.record_id = rr.record_id
GROUP BY rs.scope, rs.period;

COMMENT ON VIEW av_period_subject_counts IS
  'One row per (scope, period) with the distinct subject and assessor counts for that period. This '
  'view exists separately because count(DISTINCT ...) IS NOT ADDITIVE ACROSS PERIODS: a period-filtered '
  'distinct count cannot be recovered by summing an unpartitioned view, and summing it silently '
  'multiplies anyone who appears in more than one period.';
