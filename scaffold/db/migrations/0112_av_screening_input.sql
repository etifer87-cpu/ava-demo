-- 0112_av_screening_input.sql
-- Analytics layer, part 13 of 20. docs/06_ANALYTICS.md §7.
-- Screening index inputs: the ordered per-subject, per-competency grade series.
--
-- This view supplies ORDERED FACTS ONLY. Recency weights, points, the leniency
-- adjustment, the clean-run test and the bands all live in
-- lib/analytics/screening-index.ts, where they are unit-testable and where the
-- thresholds arrive as injected configuration.

CREATE OR REPLACE VIEW av_screening_input AS
WITH eligible AS (
  SELECT cge.subject_id,
         cge.competency_id,
         cge.framework_id,
         cge.record_id,
         cge.occurred_on,
         cge.grade_value,
         cge.assessor_id,
         cge.source
  FROM av_competency_grade_events cge
  JOIN av_record_dim rd ON rd.record_id = cge.record_id
  WHERE cge.grade_value IS NOT NULL
    AND NOT (analytics_json('screening_index.exclude_template_codes')
             ? COALESCE(rd.template_code, ''))
),
ranked AS (
  SELECT e.*,
         row_number() OVER (PARTITION BY e.subject_id, e.competency_id
                            ORDER BY e.occurred_on DESC, e.record_id DESC) AS recency_rank,
         row_number() OVER (PARTITION BY e.subject_id, e.competency_id
                            ORDER BY e.occurred_on ASC,  e.record_id ASC)  AS chrono_rank,
         count(*)    OVER (PARTITION BY e.subject_id, e.competency_id)     AS total_events
  FROM eligible e
)
SELECT r.subject_id,
       r.competency_id,
       r.framework_id,
       r.record_id,
       r.occurred_on,
       r.grade_value,
       r.assessor_id,
       r.source,
       r.recency_rank,
       r.chrono_rank,
       r.total_events,
       (r.recency_rank <= analytics_int('screening_index.window_sessions')) AS in_window,
       al.delta                     AS assessor_delta,
       al.n_sessions                AS assessor_sessions,
       (al.n_sessions >= analytics_int('screening_index.leniency.min_sessions')) AS assessor_qualifies
FROM ranked r
LEFT JOIN av_assessor_leniency al ON al.assessor_id = r.assessor_id;

COMMENT ON VIEW av_screening_input IS
  'One row per valid competency grade event of one subject in one competency, ranked newest-first '
  '(recency_rank) and oldest-first (chrono_rank), with the awarding assessor''s leniency delta and '
  'whether that assessor meets the minimum sample. Supplies ordered facts only: the recency weights, '
  'the asymmetric points, the leniency adjustment, the critical-grade flag and its recovery run, and '
  'the band boundaries are all applied in lib/analytics/screening-index.ts against injected '
  'configuration. Both rankings are emitted because the two are needed for different things - the '
  'window and its weights are recency-ordered, while the clean-run test after a critical grade must '
  'walk forward in chronological order. Excluded template codes come from configuration, never from a '
  'predicate written into this view.';

-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW av_screening_subject_competency AS
SELECT fw.framework_id,
       sd.subject_id,
       cd.competency_id,
       count(si.record_id) FILTER (WHERE si.in_window)                        AS events_in_window,
       count(si.record_id)                                                    AS events_total,
       max(si.occurred_on) FILTER (WHERE si.grade_value
             = analytics_int('grade_scale.critical_grade'))                   AS last_critical_on
FROM av_subject_dim sd
CROSS JOIN av_competency_dim cd
JOIN av_framework fw ON fw.framework_id = cd.framework_id
LEFT JOIN av_screening_input si
       ON si.subject_id = sd.subject_id AND si.competency_id = cd.competency_id
GROUP BY fw.framework_id, sd.subject_id, cd.competency_id;

COMMENT ON VIEW av_screening_subject_competency IS
  'One row per (subject, competency) for EVERY active competency of the framework, including those '
  'with no grades at all. The cross join is deliberate: a competency with no evidence must be returned '
  'as INSUFFICIENT and never dropped, because a missing row renders as a gap that reads like "fine". '
  'There is no subject-level rollup of the screening index anywhere - averaging across competencies '
  'is exactly the compensation the index exists to prevent.';
