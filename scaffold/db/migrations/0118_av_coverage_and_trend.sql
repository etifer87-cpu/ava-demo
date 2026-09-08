-- 0118_av_coverage_and_trend.sql
-- Analytics layer, part 19 of 20. docs/06_ANALYTICS.md §10, §11.
-- Coverage measures and trend inputs.

CREATE OR REPLACE VIEW av_record_coverage AS
SELECT rr.record_id,
       rr.subject_id,
       rr.assessor_id,
       rr.framework_id,
       rr.occurred_on,
       rr.n_valid,
       rr.competency_count,
       rr.competency_coverage,
       count(DISTINCT obs.competency_id)                              AS competencies_with_ob,
       CASE WHEN rr.n_valid > 0
            THEN count(DISTINCT obs.competency_id)::NUMERIC / rr.n_valid
       END                                                            AS ob_coverage,
       count(*) FILTER (WHERE cge.remark_words > 0)::NUMERIC
         / NULLIF(count(cge.record_id), 0)                            AS remark_coverage
FROM av_record_rollup rr
LEFT JOIN av_competency_grade_events cge ON cge.record_id = rr.record_id
                                        AND cge.grade_value IS NOT NULL
LEFT JOIN av_competency_grade_obs obs    ON obs.record_id = rr.record_id
GROUP BY rr.record_id, rr.subject_id, rr.assessor_id, rr.framework_id, rr.occurred_on,
         rr.n_valid, rr.competency_count, rr.competency_coverage;

COMMENT ON VIEW av_record_coverage IS
  'One row per record with the three coverage measures kept SEPARATE and separately named: '
  'competency_coverage (competencies graded of those in the framework), ob_coverage (competency '
  'grades citing at least one observable behaviour) and remark_coverage (grades carrying any remark). '
  'They are different questions and collapsing them into one "coverage" number hides which one moved. '
  'Each is compared against its own target under coverage.targets.';

-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW av_ob_selection_counts AS
SELECT obs.framework_id,
       obs.competency_id,
       obs.observable_behaviour_id,
       obs.ob_code,
       obs.ob_text,
       date_trunc('quarter', rd.occurred_on)::DATE                AS period_quarter,
       count(*)                                                   AS selections,
       count(*) FILTER (WHERE obs.grade_value
              <= analytics_int('grade_scale.below_standard_max')) AS selections_below_standard
FROM av_competency_grade_obs obs
JOIN av_record_dim rd ON rd.record_id = obs.record_id
GROUP BY obs.framework_id, obs.competency_id, obs.observable_behaviour_id, obs.ob_code, obs.ob_text,
         date_trunc('quarter', rd.occurred_on);

COMMENT ON VIEW av_ob_selection_counts IS
  'One row per (observable behaviour, quarter) with how often it was cited and how often it was cited '
  'alongside a below-standard grade. A selection count is not a score: an OB is selected, never '
  'graded. Keys on observable_behaviour_id throughout, so catalogue wording can be edited without '
  'de-aligning a single historical selection.';

-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW av_trend_input AS
SELECT cge.subject_id,
       cge.competency_id,
       cge.framework_id,
       cge.record_id,
       cge.occurred_on,
       cge.grade_value,
       row_number() OVER (PARTITION BY cge.subject_id, cge.competency_id
                          ORDER BY cge.occurred_on, cge.record_id) AS chrono_rank,
       count(*)    OVER (PARTITION BY cge.subject_id, cge.competency_id) AS n_points
FROM av_competency_grade_events cge
WHERE cge.grade_value IS NOT NULL;

COMMENT ON VIEW av_trend_input IS
  'One row per valid competency grade event of one subject in one competency, in chronological order '
  'with the total point count. Supplies ordered points only: the half-split comparison, the flat band '
  'and the minimum point count are applied in lib/analytics/trend.ts against injected configuration, '
  'so a trend arrow is never drawn from fewer points than trend.min_points and is omitted rather than '
  'shown flat when the evidence is too thin.';
