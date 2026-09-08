-- 0103_av_record_dim.sql
-- Analytics layer, part 4 of 20. docs/06_ANALYTICS.md §2.6, §2.7.
-- Record dimensions and outcome. Every period, scope and breakdown downstream
-- reads its dimensions from here.

CREATE OR REPLACE VIEW av_record_dim AS
SELECT r.id                                         AS record_id,
       r.person_id                                  AS subject_id,
       COALESCE(r.assessor_person_id, s.assessor_person_id) AS assessor_id,
       r.assessor_label,
       r.framework_id,
       r.source,
       r.training_date                              AS occurred_on,
       r.session_id,
       r.template_version_id,
       stv.template_id,
       st.code                                      AS template_code,
       st.template_kind,
       st.name                                      AS template_name,
       -- Dimension fallback: the record's own value, then the template's, then
       -- the person's current value (data_quality.dimension_fallback).
       COALESCE(r.org_unit_id,    st.org_unit_id,    sd.org_unit_id)    AS org_unit_id,
       COALESCE(r.asset_class_id, st.asset_class_id, sd.asset_class_id) AS asset_class_id,
       COALESCE(r.snapshot ->> 'position', ss.seat_role, sd.position)   AS position,
       COALESCE(r.outcome_override, r.outcome)                          AS outcome,
       (r.outcome_override IS NOT NULL)                                 AS outcome_is_overridden,
       r.is_hidden_from_subject,
       sd.joined_on,
       sd.is_active                                                     AS subject_is_active
FROM records r
LEFT JOIN sessions s                    ON s.id  = r.session_id AND s.deleted_at IS NULL
LEFT JOIN session_subjects ss           ON ss.session_id = r.session_id AND ss.person_id = r.person_id
LEFT JOIN session_template_versions stv ON stv.id = r.template_version_id
LEFT JOIN session_templates st          ON st.id = stv.template_id
LEFT JOIN av_subject_dim sd             ON sd.subject_id = r.person_id
WHERE r.deleted_at IS NULL;

COMMENT ON VIEW av_record_dim IS
  'One row per record: one subject, one session, signed. Carries every dimension the analytics layer '
  'groups by. Two rules here are load-bearing. First, outcome is read from an explicit field only, '
  'COALESCE(outcome_override, outcome), and is NEVER inferred from grades - a record can carry a '
  'below-standard grade and still pass, and deriving one from the other invents an assessor''s '
  'decision. Second, org_unit_id, asset_class_id and position resolve from the RECORD first and from '
  'the person''s current roster row last, so a reassigned subject''s history does not follow them to '
  'their new unit. Reads every source value; a view filtered to one source reports zeros for the others.';

-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW av_record_period AS
SELECT rd.record_id,
       rd.occurred_on,
       date_trunc('month',   rd.occurred_on)::DATE AS period_month,
       date_trunc('quarter', rd.occurred_on)::DATE AS period_quarter,
       date_trunc('year',    rd.occurred_on)::DATE AS period_year
FROM av_record_dim rd;

COMMENT ON VIEW av_record_period IS
  'One row per record, carrying the period key at each supported granularity. The period is '
  'precomputed here rather than written as date_trunc() inside a GROUP BY GROUPING SETS: a function '
  'inside a grouping set is re-evaluated once per row per grouping set, which turns a fast aggregate '
  'into a very slow one for no benefit.';
