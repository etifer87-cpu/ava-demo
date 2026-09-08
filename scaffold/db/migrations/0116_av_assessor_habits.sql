-- 0116_av_assessor_habits.sql
-- Analytics layer, part 17 of 20. docs/06_ANALYTICS.md §13.3, §13.4.
-- Habit and justification inputs. Scaling, points and bands are applied in
-- lib/analytics/assessor-fairness.ts; this view supplies raw quantities only.

CREATE OR REPLACE VIEW av_assessor_justification AS
SELECT g.assessor_id,
       count(*) FILTER (WHERE g.is_below_standard)                           AS n_below_standard,
       count(*) FILTER (
         WHERE g.is_below_standard
           AND g.remark_words >= analytics_int('assessor_fairness.justification.min_words')
       )                                                                     AS n_substantive,
       count(*) FILTER (
         WHERE g.grade_value <= analytics_int('assessor_fairness.justification.grade_max')
           AND g.remark_words <  analytics_int('assessor_fairness.justification.min_words')
       )                                                                     AS n_unjustified_low,
       count(*) FILTER (WHERE g.remark_words > 0)                            AS n_with_remark,
       count(*) FILTER (WHERE g.grade_value IS NOT NULL)                     AS n_valid
FROM av_assessor_grades g
WHERE g.assessor_id IS NOT NULL
GROUP BY g.assessor_id;

COMMENT ON VIEW av_assessor_justification IS
  'One row per assessor with the counts behind the justification rate (n_substantive / '
  'n_below_standard) and the deterministic unjustified-low nomination count. Grades at or above '
  'justification.never_penalise_grade_min with no comment are absent from every count here: a good '
  'grade with no essay is not a finding, in any metric, on any surface. The masking rule is NOT '
  'computed in SQL - a keyword match alone must never cap a score, so masking candidates are '
  'nominated in the application and decided by the model pass before they can affect anything.';

-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW av_assessor_halo AS
WITH per_record AS (
  SELECT g.assessor_id,
         g.record_id,
         count(*) FILTER (WHERE g.grade_value IS NOT NULL) AS graded,
         count(DISTINCT g.grade_value)                     AS distinct_grades
  FROM av_assessor_grades g
  WHERE g.grade_kind = 'competency' AND g.assessor_id IS NOT NULL
  GROUP BY g.assessor_id, g.record_id
)
SELECT assessor_id,
       count(*) FILTER (
         WHERE graded >= analytics_int('assessor_fairness.habits.halo.min_competencies_graded')
       )                                                          AS n_eligible_records,
       count(*) FILTER (
         WHERE graded >= analytics_int('assessor_fairness.habits.halo.min_competencies_graded')
           AND distinct_grades = 1
       )                                                          AS n_halo_records
FROM per_record
GROUP BY assessor_id;

COMMENT ON VIEW av_assessor_halo IS
  'One row per assessor: records on which every graded competency carried the identical grade, over '
  'records with at least halo.min_competencies_graded competencies graded. n_eligible_records is the '
  'denominator AND the availability test: an assessor with zero eligible records has no halo rate, '
  'the term is unavailable, and it is excluded from the standardisation index denominator rather than '
  'scored as a pass. An unmeasurable term must never act as free credit.';

-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW av_assessor_nr_baseline AS
SELECT rd.template_code,
       rd.asset_class_id,
       count(*)                                                   AS n_events,
       avg(CASE WHEN cge.grade_value IS NULL THEN 1 ELSE 0 END)::NUMERIC AS expected_nr_rate
FROM av_competency_grade_events cge
JOIN av_record_dim rd ON rd.record_id = cge.record_id
GROUP BY rd.template_code, rd.asset_class_id;

COMMENT ON VIEW av_assessor_nr_baseline IS
  'One row per (template code, asset class): the EXPECTED not-observed / not-required rate for that '
  'combination, measured across every assessor. Some session types are entirely not-required by '
  'design, so a raw not-observed rate penalises an assessor for the roster they were given - which is '
  'exactly the bias the module exists to remove. Only max(actual - expected, 0) is ever scored.';

-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW av_assessor_nr_excess AS
WITH actual AS (
  SELECT cge.assessor_id, rd.template_code, rd.asset_class_id,
         count(*)                                                   AS n_events,
         avg(CASE WHEN cge.grade_value IS NULL THEN 1 ELSE 0 END)::NUMERIC AS actual_nr_rate
  FROM av_competency_grade_events cge
  JOIN av_record_dim rd ON rd.record_id = cge.record_id
  WHERE cge.assessor_id IS NOT NULL
  GROUP BY cge.assessor_id, rd.template_code, rd.asset_class_id
)
SELECT a.assessor_id,
       sum(a.n_events)                                                 AS n_events,
       sum(a.actual_nr_rate * a.n_events) / NULLIF(sum(a.n_events), 0) AS actual_nr_rate,
       sum(b.expected_nr_rate * a.n_events) / NULLIF(sum(a.n_events), 0) AS expected_nr_rate,
       greatest(
         sum(a.actual_nr_rate  * a.n_events) / NULLIF(sum(a.n_events), 0)
       - sum(b.expected_nr_rate * a.n_events) / NULLIF(sum(a.n_events), 0), 0)  AS nr_excess
FROM actual a
JOIN av_assessor_nr_baseline b
  ON b.template_code = a.template_code
 AND b.asset_class_id IS NOT DISTINCT FROM a.asset_class_id
GROUP BY a.assessor_id;

COMMENT ON VIEW av_assessor_nr_excess IS
  'One row per assessor: their not-observed rate, the exposure-weighted expectation for the mix of '
  'session types and asset classes they actually worked, and the excess of the first over the second, '
  'floored at zero. Only nr_excess is ever scored; the raw rate is never used anywhere.';
