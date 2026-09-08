-- 0114_av_assessor_residual.sql
-- Analytics layer, part 15 of 20. docs/06_ANALYTICS.md §13.2.
-- Residuals, and the shrunk adjusted leniency delta with its interval.

CREATE OR REPLACE VIEW av_assessor_residual AS
SELECT ae.record_id,
       ae.subject_id,
       ae.competency_id,
       ae.framework_id,
       ae.assessor_id,
       ae.occurred_on,
       ae.grade_value,
       ae.expected,
       ae.fallback_level,
       (ae.grade_value - ae.expected)::NUMERIC AS residual
FROM av_assessor_expected ae
WHERE ae.expected IS NOT NULL;

COMMENT ON VIEW av_assessor_residual IS
  'One row per valid competency grade event: the grade awarded minus the grade the same subject '
  'earned in the same competency from other assessors. A positive residual means this assessor graded '
  'above what that subject''s other evidence supports. Residuals, not raw grades, are the unit of '
  'every fairness measure downstream.';

-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW av_assessor_adjusted AS
WITH agg AS (
  SELECT r.assessor_id,
         count(*)                              AS n_grades,
         count(DISTINCT r.record_id)           AS n_records,
         count(DISTINCT r.subject_id)          AS n_subjects,
         avg(r.residual)::NUMERIC              AS delta_raw_residual,
         stddev_samp(r.residual)::NUMERIC      AS sd_residual,
         avg(r.grade_value)::NUMERIC           AS mean_grade,
         stddev_samp(r.grade_value)::NUMERIC   AS sigma_grade,
         max(r.occurred_on)                    AS last_graded_on,
         avg(CASE WHEN r.fallback_level > 1 THEN 1 ELSE 0 END)::NUMERIC AS share_above_level_1
  FROM av_assessor_residual r
  WHERE r.assessor_id IS NOT NULL
  GROUP BY r.assessor_id
),
group_mean AS (SELECT avg(grade_value) AS m FROM av_assessor_occurrence)
SELECT a.assessor_id,
       a.n_grades,
       a.n_records,
       a.n_subjects,
       a.mean_grade,
       a.sigma_grade,
       a.last_graded_on,
       a.share_above_level_1,
       (a.mean_grade - (SELECT m FROM group_mean))::NUMERIC AS delta_unadjusted,
       a.delta_raw_residual,
       ( a.delta_raw_residual * a.n_grades
         / (a.n_grades + analytics_number('assessor_fairness.adjusted_delta.k_shrink'))
       )::NUMERIC                                          AS delta_adjusted,
       ( analytics_number('assessor_fairness.adjusted_delta.ci_z')
         * a.sd_residual / sqrt(NULLIF(a.n_grades, 0))
       )::NUMERIC                                          AS ci_half_width,
       (a.n_records < analytics_int('assessor_fairness.adjusted_delta.min_records_banded'))
                                                           AS is_provisional,
       ( a.n_records >= analytics_int('assessor_fairness.adjusted_delta.min_records_banded')
         AND abs( a.delta_raw_residual * a.n_grades
                  / (a.n_grades + analytics_number('assessor_fairness.adjusted_delta.k_shrink')) )
             >= analytics_number('assessor_fairness.adjusted_delta.outlier_abs')
       )                                                   AS is_outlier
FROM agg a;

COMMENT ON VIEW av_assessor_adjusted IS
  'One row per assessor: the mean residual shrunk toward zero by n / (n + k_shrink), with a normal '
  'interval, and the unadjusted own-mean-minus-group-mean delta retained as a SECONDARY reference. '
  'Shrinkage is mandatory - without it the assessors with the fewest events occupy both ends of the '
  'ranking every time, purely as an artefact of variance. is_provisional marks assessors below '
  'min_records_banded: they are excluded from outlier flags and NEVER banded. delta_unadjusted is '
  'displayed because it is the number people expect to see, and showing both is how the correction '
  'gets explained; it is never used for banding or flagging.';

-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW av_assessor_competency_raw AS
SELECT r.assessor_id,
       r.competency_id,
       r.framework_id,
       count(*)                    AS n,
       avg(r.grade_value)::NUMERIC AS own_mean,
       avg(r.residual)::NUMERIC    AS mean_residual
FROM av_assessor_residual r
WHERE r.assessor_id IS NOT NULL
GROUP BY r.assessor_id, r.competency_id, r.framework_id;

COMMENT ON VIEW av_assessor_competency_raw IS
  'One row per (assessor, competency): the assessor''s own mean and mean residual for that competency. '
  'The expected-grade machinery is not shrunk or banded per competency in this scaffold, so any '
  'surface built on this view is LABELLED RAW. An unlabelled raw number sitting beside adjusted '
  'numbers is the defect; the raw number itself is fine.';
