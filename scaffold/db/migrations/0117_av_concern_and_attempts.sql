-- 0117_av_concern_and_attempts.sql
-- Analytics layer, part 18 of 20. docs/06_ANALYTICS.md §8, §4.3.
-- Concern inputs (one derivation for every surface) and the first-attempt /
-- after-remedial split.

CREATE OR REPLACE VIEW av_concern_input AS
SELECT sd.subject_id,
       sd.is_active                                              AS subject_is_active,
       sd.watch_list,
       sd.concern_override,
       count(cge.record_id) FILTER (WHERE cge.grade_value IS NOT NULL) AS n_valid,
       count(cge.record_id) FILTER (WHERE cge.is_critical)             AS n_critical,
       count(cge.record_id) FILTER (
         WHERE cge.grade_value = analytics_int('grade_scale.below_standard_max')
       )                                                               AS n_at_boundary,
       count(cge.record_id) FILTER (WHERE cge.is_below_standard)       AS n_below_standard,
       max(cge.occurred_on)                                            AS last_graded_on
FROM av_subject_dim sd
LEFT JOIN av_competency_grade_events cge
       ON cge.subject_id = sd.subject_id
      AND ( analytics_json('concern.lookback_days') = 'null'::JSONB
            OR cge.occurred_on >= CURRENT_DATE
               - (analytics_int('concern.lookback_days') || ' days')::INTERVAL )
GROUP BY sd.subject_id, sd.is_active, sd.watch_list, sd.concern_override;

COMMENT ON VIEW av_concern_input IS
  'One row per subject, INCLUDING subjects with no grades, carrying the counts the concern rule needs '
  'plus any manual override. The rule itself lives in lib/analytics/concern.ts and is applied by one '
  'endpoint that the roster, the dashboard, the profile and the admin statistics all read: two '
  'surfaces deriving the same concept from two different sources will disagree, and the disagreement '
  'is invisible until someone puts the screens side by side. A subject with n_valid = 0 resolves to '
  'NULL concern, which renders "no data" - never "Low".';

-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW av_first_attempt AS
SELECT ege.element_key,
       max(ege.element_name)                                       AS element_name,
       rd.template_code,
       rd.asset_class_id,
       count(*) FILTER (WHERE ege.is_first_attempt
                          AND ege.grade_value IS NOT NULL)         AS n_first,
       count(*) FILTER (WHERE ege.is_first_attempt
                          AND ege.is_below_standard)               AS below_first,
       count(*) FILTER (WHERE NOT ege.is_first_attempt
                          AND ege.grade_value IS NOT NULL)         AS n_after,
       count(*) FILTER (WHERE NOT ege.is_first_attempt
                          AND ege.is_below_standard)               AS below_after
FROM av_element_grade_events ege
JOIN av_record_dim rd ON rd.record_id = ege.record_id
GROUP BY ege.element_key, rd.template_code, rd.asset_class_id;

COMMENT ON VIEW av_first_attempt IS
  'One row per (element, template code, asset class) with the below-standard counts split by attempt '
  'number. The after-remedial figures are computed only over elements that were actually repeated, so '
  'they are not a like-for-like population and every surface labels them "of elements repeated". '
  'The difference between the two rates measures what repetition recovered on those elements; it is '
  'not a measure of the programme''s overall quality and must not be reported as one.';

-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW av_element_repeat AS
SELECT ei.element_key,
       max(ei.element_name)                          AS element_name,
       count(*)                                      AS elements_attempted,
       count(*) FILTER (WHERE ei.was_repeated)       AS repeat_n,
       count(*) FILTER (WHERE ei.was_repeated)::NUMERIC / NULLIF(count(*), 0) AS repeat_rate
FROM av_element_instances ei
GROUP BY ei.element_key;

COMMENT ON VIEW av_element_repeat IS
  'One row per element: how many INSTANCES were attempted and how many needed a repeat. Both sides '
  'are instance-based, which is the only reason repeat_rate keeps its meaning - computing it against '
  'an attempt-expanded denominator silently mixes two grains and produces a number nobody can '
  'interpret. Groups on element_key, never on the element name: names carry syllabus item numbers '
  'that are renumbered between template versions, so grouping by name ranks fragments of one element.';
