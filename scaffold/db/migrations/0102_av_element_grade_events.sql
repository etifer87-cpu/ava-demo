-- 0102_av_element_grade_events.sql
-- Analytics layer, part 3 of 20. docs/06_ANALYTICS.md §2.5.
-- Element grade events, with attempt expansion.
--
-- A repeat is a ROW in both element_grades and record_tasks, so nothing here
-- unnests a jsonb attempt array and there is no lateral fallback to get wrong.

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
       grade_num(u.grade)               AS grade_value,
       grade_is_below_standard(u.grade) AS is_below_standard,
       grade_is_critical(u.grade)       AS is_critical,
       (u.attempt = 1)                  AS is_first_attempt,
       u.remark,
       CASE WHEN btrim(COALESCE(u.remark, '')) = '' THEN 0
            ELSE array_length(regexp_split_to_array(btrim(u.remark), '\s+'), 1)
       END                              AS remark_words,
       u.assessor_id,
       u.source
FROM u;

COMMENT ON VIEW av_element_grade_events IS
  'One row per (record, element_key, attempt): ONE GRADE EVENT. Every attempt of a repeated element '
  'is its own event, so an element graded 2 then 4 contributes one below-standard event and one that '
  'is not - it does not collapse into a single "meets standard" reading, which is exactly how '
  'first-attempt failures become invisible. grade_value is NULL for NR, NO, NA and anything '
  'unparseable, and those rows are excluded from both numerator and denominator downstream. Metrics '
  'that must stay instance-based filter is_first_attempt. Reads in-app grades and imported record '
  'tasks together: a view reading one source reports zeros for the other.';

-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW av_element_instances AS
SELECT record_id,
       subject_id,
       element_key,
       max(element_name)                                 AS element_name,
       count(*)                                          AS attempts,
       (count(*) > 1)                                    AS was_repeated,
       max(grade_value) FILTER (WHERE attempt = 1)       AS first_attempt_grade,
       (array_agg(grade_value ORDER BY attempt DESC))[1] AS last_attempt_grade
FROM av_element_grade_events
GROUP BY record_id, subject_id, element_key;

COMMENT ON VIEW av_element_instances IS
  'One row per (record, element_key): ONE ELEMENT INSTANCE, however many attempts it took. This is '
  'the correct denominator for repeat rate and for "elements attempted"; av_element_grade_events is '
  'the correct denominator for any rate over grades. Mixing the two grains makes repeat rate '
  'meaningless. last_attempt_grade exists for display only and must never denominate a rate.';

-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW av_element_duplicates AS
SELECT record_id, element_key, attempt,
       count(*)              AS row_count,
       count(DISTINCT grade) AS distinct_grades
FROM av_element_grade_events
GROUP BY record_id, element_key, attempt
HAVING count(*) > 1;

COMMENT ON VIEW av_element_duplicates IS
  'One row per duplicated (record, element_key, attempt). Reported as a data-quality metric and NEVER '
  'silently deduplicated: some duplicates carry conflicting grades and there is no obviously correct '
  'survivor, so data_quality.dedupe_rule stays "none" until an operator chooses one and writes it '
  'down. A duplicate inflates numerator and denominator equally, so no rate check will ever find these.';
