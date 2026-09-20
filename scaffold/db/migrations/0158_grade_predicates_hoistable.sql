-- 0158_grade_predicates_hoistable.sql
-- The same defect migration 0155 fixed for the APPLICATION, fixed for the VIEWS.
--
-- WHERE THE COST WAS. av_element_grade_events and av_competency_grade_events call grade_num(),
-- grade_is_below_standard() and grade_is_critical() once per row. Each of those reads
-- analytics_config through a plpgsql function, and PostgreSQL evaluates a STABLE function once per
-- ROW, not once per query - so every view built on these two paid three configuration lookups per
-- grade, and they are the root of the indicator chain: av_period_competency and av_period_overall
-- read them, av_indicator_input reads those, av_indicator_series reads that, and
-- av_indicator_base and av_indicator_overdispersion read the series. Measured 2026-09-19:
-- av_indicator_input 16s, av_indicator_series 15s, base and overdispersion over 30s on the
-- workstation, 24.1s and 23.3s on cvx-hel1 against a 30s gate budget. The server is not fixed; it
-- is six seconds from failing.
--
-- THE FIX, which is 0155's. Two- and three-argument predicates that TAKE the configuration rather
-- than reading it. Their bodies hold no subquery, so PostgreSQL inlines them; the caller supplies
-- the values as uncorrelated scalar subqueries, which the planner evaluates once per query as an
-- InitPlan. A view is flattened into the query that selects from it, so the hoist works here where
-- it could not work inside a function body (a SQL function whose body contains a subquery is not
-- inlined - measured, 0155).
--
-- NOTHING IS RESTATED. The boundary still lives in analytics.yaml and is still read from
-- analytics_config; only the number of times it is read changes. The comparison itself is still
-- written once, in these functions, and not spelled out in any view.
--
-- The one-argument forms are untouched and remain correct for ad-hoc queries.
--
-- Forward-only. Re-runnable.

CREATE OR REPLACE FUNCTION grade_is_below_standard(p_grade TEXT, p_max INT, p_pattern TEXT)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT grade_num(p_grade, p_pattern) IS NOT NULL
     AND grade_num(p_grade, p_pattern) <= p_max
$$;

COMMENT ON FUNCTION grade_is_below_standard(TEXT, INT, TEXT) IS
  'grade_is_below_standard(text) with grade_scale.below_standard_max and grade_scale.valid_pattern '
  'passed in rather than read per row. IMMUTABLE and subquery-free so PostgreSQL inlines it; the '
  'caller hoists both values with (SELECT analytics_int(...)) / (SELECT analytics_text(...)), which '
  'the planner evaluates once per query. Identical in meaning to the one-argument form.';

CREATE OR REPLACE FUNCTION grade_is_critical(p_grade TEXT, p_critical INT, p_pattern TEXT)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT grade_num(p_grade, p_pattern) = p_critical
$$;

COMMENT ON FUNCTION grade_is_critical(TEXT, INT, TEXT) IS
  'grade_is_critical(text) with grade_scale.critical_grade and grade_scale.valid_pattern passed in '
  'rather than read per row. See grade_is_below_standard(TEXT, INT, TEXT).';

-- ---------------------------------------------------------------------------
-- The two views the whole analytics layer is built on, rebuilt with the
-- configuration hoisted. Everything downstream - av_period_competency,
-- av_period_overall, av_indicator_input, av_indicator_series,
-- av_indicator_base, av_indicator_overdispersion - inherits the saving without
-- being touched, because the cost was never theirs.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW av_element_grade_events AS
WITH from_sessions AS (
  SELECT r.id           AS record_id,
         eg.person_id   AS subject_id,
         eg.element_key,
         te.title       AS element_name,
         eg.attempt,
         eg.grade,
         eg.remark,
         COALESCE(u.person_id, r.assessor_person_id) AS assessor_id,
         'app'::TEXT    AS source
  FROM element_grades eg
  JOIN records r
    ON r.session_id = eg.session_id
   AND r.person_id  = eg.person_id
   AND r.deleted_at IS NULL
  LEFT JOIN users u             ON u.id = eg.graded_by
  LEFT JOIN template_elements te
    ON te.template_version_id = r.template_version_id
   AND te.element_key         = eg.element_key
),
from_records AS (
  SELECT rt.record_id,
         r.person_id AS subject_id,
         rt.element_key,
         rt.task_name AS element_name,
         rt.attempt,
         rt.grade,
         rt.remark,
         r.assessor_person_id AS assessor_id,
         r.source
  FROM record_tasks rt
  JOIN records r ON r.id = rt.record_id AND r.deleted_at IS NULL
  WHERE r.source <> 'app'
),
u AS (
  SELECT * FROM from_sessions
  UNION ALL
  SELECT * FROM from_records
)
SELECT u.record_id,
       u.subject_id,
       u.element_key,
       u.element_name,
       u.attempt,
       u.grade,
       grade_num(u.grade, (SELECT analytics_text('grade_scale.valid_pattern')))               AS grade_value,
       grade_is_below_standard(u.grade, (SELECT analytics_int('grade_scale.below_standard_max')), (SELECT analytics_text('grade_scale.valid_pattern'))) AS is_below_standard,
       grade_is_critical(u.grade, (SELECT analytics_int('grade_scale.critical_grade')), (SELECT analytics_text('grade_scale.valid_pattern')))       AS is_critical,
       (u.attempt = 1)                  AS is_first_attempt,
       u.remark,
       CASE WHEN btrim(COALESCE(u.remark, '')) = '' THEN 0
            ELSE array_length(regexp_split_to_array(btrim(u.remark), '\s+'), 1)
       END                              AS remark_words,
       u.assessor_id,
       u.source
FROM u;;

CREATE OR REPLACE VIEW av_competency_grade_events AS
WITH from_sessions AS (
  SELECT r.id        AS record_id,
         cg.id       AS competency_grade_id,
         cg.person_id AS subject_id,
         cg.competency_id,
         COALESCE(cg.framework_id, r.framework_id) AS framework_id,
         cg.grade,
         cg.remark,
         COALESCE(u.person_id, r.assessor_person_id) AS assessor_id,
         r.training_date AS occurred_on,
         'app'::TEXT  AS source,
         1            AS shadow_rank      -- in-app shadows import
  FROM competency_grades cg
  JOIN records r
    ON r.session_id = cg.session_id
   AND r.person_id  = cg.person_id
   AND r.deleted_at IS NULL
  LEFT JOIN users u ON u.id = cg.graded_by
),
from_records AS (
  SELECT rc.record_id,
         NULL::UUID AS competency_grade_id,
         r.person_id AS subject_id,
         rc.competency_id,
         COALESCE(rc.framework_id, r.framework_id) AS framework_id,
         rc.grade,
         rc.remark,
         r.assessor_person_id AS assessor_id,
         r.training_date      AS occurred_on,
         r.source,
         2                    AS shadow_rank
  FROM record_competencies rc
  JOIN records r ON r.id = rc.record_id AND r.deleted_at IS NULL
  WHERE r.source <> 'app'
),
unioned AS (
  SELECT * FROM from_sessions
  UNION ALL
  SELECT * FROM from_records
),
shadowed AS (
  SELECT u.*,
         row_number() OVER (
           PARTITION BY u.subject_id, u.competency_id, u.occurred_on
           ORDER BY u.shadow_rank, u.record_id
         ) AS dup_rank
  FROM unioned u
)
SELECT record_id,
       competency_grade_id,
       subject_id,
       competency_id,
       framework_id,
       occurred_on,
       grade,
       grade_num(grade, (SELECT analytics_text('grade_scale.valid_pattern')))               AS grade_value,
       grade_is_below_standard(grade, (SELECT analytics_int('grade_scale.below_standard_max')), (SELECT analytics_text('grade_scale.valid_pattern'))) AS is_below_standard,
       grade_is_critical(grade, (SELECT analytics_int('grade_scale.critical_grade')), (SELECT analytics_text('grade_scale.valid_pattern')))       AS is_critical,
       remark,
       CASE WHEN btrim(COALESCE(remark, '')) = '' THEN 0
            ELSE array_length(regexp_split_to_array(btrim(remark), '\s+'), 1)
       END                            AS remark_words,
       assessor_id,
       source
FROM shadowed
WHERE dup_rank = 1;;
