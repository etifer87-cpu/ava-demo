-- 0104_av_competency_grade_events.sql
-- Analytics layer, part 5 of 20. docs/06_ANALYTICS.md §2.4, §7.5.
-- Competency grade events: the spine of every rate in the platform.

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
       grade_num(grade)               AS grade_value,
       grade_is_below_standard(grade) AS is_below_standard,
       grade_is_critical(grade)       AS is_critical,
       remark,
       CASE WHEN btrim(COALESCE(remark, '')) = '' THEN 0
            ELSE array_length(regexp_split_to_array(btrim(remark), '\s+'), 1)
       END                            AS remark_words,
       assessor_id,
       source
FROM shadowed
WHERE dup_rank = 1;

COMMENT ON VIEW av_competency_grade_events IS
  'One row per (record, competency): ONE COMPETENCY GRADE EVENT, the denominator of the below-standard '
  'rate. A graded record produces roughly one event per competency in the framework, which is why a '
  'rate over these events and a rate over records are different measurements with different exposures '
  'and must never share a unit string or a y-axis. Reads in-app grades and imported record '
  'competencies together; where the same (subject, competency, date) exists in both, the in-app '
  'session SHADOWS the import (screening_index.session_shadows_import). grade_value is NULL for NR, '
  'NO and NA and those rows are excluded from both numerator and denominator everywhere. Nothing here '
  'keys on a competency name: competency_id and framework_id are the keys.';

-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW av_competency_grade_obs AS
SELECT cge.record_id,
       cge.subject_id,
       cge.competency_id,
       cge.framework_id,
       cge.grade_value,
       cgo.observable_behaviour_id,
       ob.code AS ob_code,
       ob.text AS ob_text
FROM av_competency_grade_events cge
JOIN competency_grade_obs cgo ON cgo.competency_grade_id = cge.competency_grade_id
JOIN observable_behaviours ob ON ob.id = cgo.observable_behaviour_id
WHERE cge.competency_grade_id IS NOT NULL
UNION ALL
SELECT cge.record_id,
       cge.subject_id,
       cge.competency_id,
       cge.framework_id,
       cge.grade_value,
       obid                                    AS observable_behaviour_id,
       ob.code,
       ob.text
FROM av_competency_grade_events cge
JOIN record_competencies rc
  ON rc.record_id = cge.record_id AND rc.competency_id = cge.competency_id
CROSS JOIN LATERAL unnest(rc.observable_behaviour_ids) AS obid
JOIN observable_behaviours ob ON ob.id = obid
WHERE cge.competency_grade_id IS NULL;

COMMENT ON VIEW av_competency_grade_obs IS
  'One row per observable behaviour SELECTED on one competency grade event, from both the in-app '
  'join table and the imported id array. OBs are selected, not graded: a row here means "this '
  'behaviour was cited", never "this behaviour scored n". Joins on observable_behaviour_id, so '
  'catalogue wording can be edited without a migration and without de-aligning a single historical '
  'selection - which is the whole reason nothing in this platform matches behaviours by text.';
