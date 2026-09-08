-- 0111_av_assessor_grades.sql
-- Analytics layer, part 12 of 20. docs/06_ANALYTICS.md §13, §7.1(c).
-- Assessor-resolved grade occurrences, and the simple leniency delta the
-- screening index uses.
--
-- Dependency note: this file must run BEFORE 0112, which joins av_assessor_leniency.

CREATE OR REPLACE VIEW av_assessor_grades AS
SELECT cge.record_id,
       cge.subject_id,
       cge.assessor_id,
       cge.competency_id,
       cge.framework_id,
       cge.occurred_on,
       cge.grade,
       cge.grade_value,
       cge.is_below_standard,
       cge.is_critical,
       cge.remark,
       cge.remark_words,
       rd.template_code,
       rd.template_kind,
       rd.asset_class_id,
       rd.org_unit_id,
       'competency'::TEXT AS grade_kind
FROM av_competency_grade_events cge
JOIN av_record_dim rd ON rd.record_id = cge.record_id
UNION ALL
SELECT ege.record_id,
       ege.subject_id,
       ege.assessor_id,
       NULL::UUID,
       rd.framework_id,
       rd.occurred_on,
       ege.grade,
       ege.grade_value,
       ege.is_below_standard,
       ege.is_critical,
       ege.remark,
       ege.remark_words,
       rd.template_code,
       rd.template_kind,
       rd.asset_class_id,
       rd.org_unit_id,
       'element'::TEXT
FROM av_element_grade_events ege
JOIN av_record_dim rd ON rd.record_id = ege.record_id;

COMMENT ON VIEW av_assessor_grades IS
  'One row per graded occurrence with the assessor resolved, over both competency grades and element '
  'grades, from every source. grade_kind separates the two layers because they have different grains '
  'and must not be pooled into one mean. Rows with an unresolved assessor are KEPT and carry a NULL '
  'assessor_id: dropping them would quietly remove part of the corpus from every peer mean.';

-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW av_assessor_leniency AS
WITH graded AS (
  SELECT assessor_id, record_id, grade_value
  FROM av_assessor_grades
  WHERE grade_kind = 'competency' AND grade_value IS NOT NULL
),
overall AS (
  SELECT avg(grade_value)::NUMERIC AS mean_all FROM graded
)
SELECT g.assessor_id,
       count(DISTINCT g.record_id)                 AS n_sessions,
       count(*)                                    AS n_grades,
       avg(g.grade_value)::NUMERIC                 AS mean_grade,
       (avg(g.grade_value) - (SELECT mean_all FROM overall))::NUMERIC AS delta,
       (count(DISTINCT g.record_id)
          >= analytics_int('screening_index.leniency.min_sessions'))  AS meets_min_sessions
FROM graded g
WHERE g.assessor_id IS NOT NULL
GROUP BY g.assessor_id;

COMMENT ON VIEW av_assessor_leniency IS
  'One row per assessor: mean grade awarded and its difference from the all-assessor mean. This is '
  'the SIMPLE delta the screening index uses to adjust a subject''s grades for who happened to award '
  'them - it is deliberately not the shrunk, expected-grade-adjusted delta in av_assessor_adjusted, '
  'which answers a different question about the assessor rather than about the subject. It is only '
  'applied when meets_min_sessions is true (screening_index.leniency.min_sessions): below that sample '
  'an assessor''s mean is dominated by which subjects they happened to assess, and adjusting by it '
  'injects more noise than it removes. Grades from dormant and former assessors stay in this mean; '
  'status is a display filter only.';
