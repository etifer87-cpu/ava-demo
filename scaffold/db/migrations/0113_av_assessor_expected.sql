-- 0113_av_assessor_expected.sql
-- Analytics layer, part 14 of 20. docs/06_ANALYTICS.md §13.1.
-- Expected grade: what the SAME subjects scored in the SAME competencies with
-- OTHER assessors.
--
-- Never compare an assessor to the peer mean. A raw comparison punishes an
-- assessor assigned weaker subjects and flatters one assigned stronger
-- subjects, with no way to tell either from a genuine bias.

CREATE OR REPLACE VIEW av_assessor_occurrence AS
SELECT cge.record_id,
       cge.subject_id,
       cge.competency_id,
       cge.framework_id,
       cge.assessor_id,
       cge.occurred_on,
       cge.grade_value,
       row_number() OVER (PARTITION BY cge.subject_id, cge.competency_id
                          ORDER BY cge.occurred_on, cge.record_id) AS occurrence_rank
FROM av_competency_grade_events cge
WHERE cge.grade_value IS NOT NULL;

COMMENT ON VIEW av_assessor_occurrence IS
  'One row per valid competency grade event, ranked within (subject, competency) in chronological '
  'order. occurrence_rank is the distance metric the expected-grade weighting uses: the estimate is '
  'symmetric in RANK distance because it is a leave-one-out estimate of the subject''s ability around '
  'that point in time, not a forecast, so later evidence is as relevant as earlier.';

-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW av_assessor_expected AS
WITH pairs AS (
  SELECT o.record_id,
         o.subject_id,
         o.competency_id,
         o.framework_id,
         o.assessor_id,
         o.occurred_on,
         o.grade_value,
         p.grade_value AS peer_grade,
         power(0.5, abs(o.occurrence_rank - p.occurrence_rank)::NUMERIC
                    / analytics_number('assessor_fairness.expected.half_life')) AS w
  FROM av_assessor_occurrence o
  JOIN av_assessor_occurrence p
    ON p.subject_id    = o.subject_id
   AND p.competency_id = o.competency_id
   AND p.record_id    <> o.record_id
   AND p.assessor_id IS DISTINCT FROM o.assessor_id
   AND abs(p.occurrence_rank - o.occurrence_rank)
         <= analytics_int('assessor_fairness.expected.window_rank')
),
level1 AS (
  SELECT record_id, subject_id, competency_id, framework_id, assessor_id, occurred_on, grade_value,
         count(*)                              AS peer_n,
         sum(w * peer_grade) / NULLIF(sum(w), 0) AS expected
  FROM pairs
  GROUP BY record_id, subject_id, competency_id, framework_id, assessor_id, occurred_on, grade_value
),
level2 AS (   -- the subject's mean across all competencies, other assessors
  SELECT o.subject_id, avg(p.grade_value) AS expected
  FROM av_assessor_occurrence o
  JOIN av_assessor_occurrence p
    ON p.subject_id = o.subject_id
   AND p.assessor_id IS DISTINCT FROM o.assessor_id
  GROUP BY o.subject_id
),
level3 AS (   -- the peer group's mean for that competency
  SELECT competency_id, avg(grade_value) AS expected FROM av_assessor_occurrence GROUP BY competency_id
),
level4 AS (   -- the peer group's overall mean
  SELECT avg(grade_value) AS expected FROM av_assessor_occurrence
)
SELECT o.record_id,
       o.subject_id,
       o.competency_id,
       o.framework_id,
       o.assessor_id,
       o.occurred_on,
       o.grade_value,
       COALESCE(l1.peer_n, 0) AS peer_n,
       CASE
         WHEN l1.expected IS NOT NULL
              AND l1.peer_n >= analytics_int('assessor_fairness.expected.min_grades') THEN 1
         WHEN l2.expected IS NOT NULL THEN 2
         WHEN l3.expected IS NOT NULL THEN 3
         ELSE 4
       END AS fallback_level,
       COALESCE(
         CASE WHEN l1.peer_n >= analytics_int('assessor_fairness.expected.min_grades')
              THEN l1.expected END,
         l2.expected, l3.expected, (SELECT expected FROM level4)
       ) AS expected
FROM av_assessor_occurrence o
LEFT JOIN level1 l1 ON l1.record_id = o.record_id AND l1.competency_id = o.competency_id
LEFT JOIN level2 l2 ON l2.subject_id = o.subject_id
LEFT JOIN level3 l3 ON l3.competency_id = o.competency_id;

COMMENT ON VIEW av_assessor_expected IS
  'One row per valid competency grade event with the expected grade for that (subject, competency, '
  'occurrence) estimated from OTHER assessors only, weighted by 0.5 ^ (rank distance / half_life) and '
  'renormalised over the peers actually used. window_rank bounds the self-join: it is a performance '
  'guard, not a statistical choice - without it the pair join is quadratic in each subject''s history. '
  'fallback_level is recorded on EVERY row, so any aggregate can be filtered or audited by it; a '
  'population where a large share of rows resolve above level 1 is not fit for banding, and the '
  'surface must say so rather than banding it.';
