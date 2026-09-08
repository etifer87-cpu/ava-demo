-- 0105_av_record_rollup.sql
-- Analytics layer, part 6 of 20. docs/06_ANALYTICS.md §4.2, §9, §11.
-- Record-level rollups: the record-grained facts every record-denominated
-- metric is built from.

CREATE OR REPLACE VIEW av_record_rollup AS
SELECT rd.record_id,
       rd.subject_id,
       rd.assessor_id,
       rd.framework_id,
       rd.org_unit_id,
       rd.asset_class_id,
       rd.position,
       rd.template_code,
       rd.template_kind,
       rd.source,
       rd.occurred_on,
       rd.outcome,
       count(cge.record_id) FILTER (WHERE cge.grade_value IS NOT NULL)  AS n_valid,
       count(cge.record_id) FILTER (WHERE cge.is_below_standard)        AS n_below_standard,
       count(cge.record_id) FILTER (WHERE cge.is_critical)              AS n_critical,
       count(cge.record_id) FILTER (
         WHERE cge.grade_value = analytics_int('grade_scale.below_standard_max')
       )                                                        AS n_at_boundary,
       (count(cge.record_id) FILTER (WHERE cge.grade_value IS NOT NULL) > 0)  AS has_valid_grade,
       (count(cge.record_id) FILTER (WHERE cge.is_below_standard)      > 0)   AS is_adverse,
       (   count(cge.record_id) FILTER (WHERE cge.is_critical)
             >= analytics_int('flagged_record.grade_1_at_least')
        OR count(cge.record_id) FILTER (
             WHERE cge.grade_value = analytics_int('grade_scale.below_standard_max')
           ) >= analytics_int('flagged_record.grade_2_at_least')
       )                                                        AS is_flagged,
       fw.competency_count,
       CASE WHEN fw.competency_count > 0
            THEN count(cge.record_id) FILTER (WHERE cge.grade_value IS NOT NULL)::NUMERIC
                 / fw.competency_count
       END                                                      AS competency_coverage
FROM av_record_dim rd
LEFT JOIN av_competency_grade_events cge ON cge.record_id = rd.record_id
LEFT JOIN av_framework fw                ON fw.framework_id = rd.framework_id
GROUP BY rd.record_id, rd.subject_id, rd.assessor_id, rd.framework_id, rd.org_unit_id,
         rd.asset_class_id, rd.position, rd.template_code, rd.template_kind, rd.source,
         rd.occurred_on, rd.outcome, fw.competency_count;

COMMENT ON VIEW av_record_rollup IS
  'One row per record, with its competency grades collapsed to counts. is_adverse is the numerator '
  'of the adverse-competency rate and has_valid_grade is its denominator - both RECORD-grained, which '
  'is what distinguishes that metric from the below-standard rate. is_flagged reads its two triggers '
  'from flagged_record.* in analytics_config; no surface restates them. is_flagged never affects '
  'outcome: a flag says "worth reading", not "failed".';

-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW av_record_outcome_mix AS
SELECT rp.period_month,
       rp.period_quarter,
       rr.template_kind,
       rr.org_unit_id,
       rr.asset_class_id,
       rr.outcome,
       count(*) AS records
FROM av_record_rollup rr
JOIN av_record_period rp ON rp.record_id = rr.record_id
GROUP BY rp.period_month, rp.period_quarter, rr.template_kind, rr.org_unit_id,
         rr.asset_class_id, rr.outcome;

COMMENT ON VIEW av_record_outcome_mix IS
  'One row per (period, template kind, org unit, asset class, outcome) with a record count. PARTIAL_PASS '
  'is an outcome in its own right and is never folded into PASS or FAIL, on this view or on any chart '
  'built from it. A NULL outcome means the record carries no explicit outcome and renders "not recorded".';
