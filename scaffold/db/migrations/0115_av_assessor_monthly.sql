-- 0115_av_assessor_monthly.sql
-- Analytics layer, part 16 of 20. docs/06_ANALYTICS.md §13.
-- Additive monthly rollup: every windowed assessor metric is recovered EXACTLY
-- from these sums, without re-scanning the grade corpus per request.

CREATE OR REPLACE VIEW av_assessor_monthly AS
SELECT r.assessor_id,
       date_trunc('month', r.occurred_on)::DATE AS period_month,
       count(*)                                 AS n_grades,
       count(DISTINCT r.record_id)              AS n_records,
       sum(r.grade_value)::NUMERIC              AS sum_g,
       sum(r.grade_value::NUMERIC ^ 2)          AS sum_g2,
       sum(r.residual)                          AS sum_r,
       sum(r.residual ^ 2)                      AS sum_r2,
       sum(EXTRACT(EPOCH FROM r.occurred_on::TIMESTAMP) / 86400.0)                 AS sum_x,
       sum((EXTRACT(EPOCH FROM r.occurred_on::TIMESTAMP) / 86400.0) ^ 2)           AS sum_x2,
       sum((EXTRACT(EPOCH FROM r.occurred_on::TIMESTAMP) / 86400.0) * r.residual)  AS sum_xr
FROM av_assessor_residual r
WHERE r.assessor_id IS NOT NULL
GROUP BY r.assessor_id, date_trunc('month', r.occurred_on);

COMMENT ON VIEW av_assessor_monthly IS
  'One row per (assessor, month) carrying only ADDITIVE quantities: counts, sums of grades, sums of '
  'squares, and the cross-products needed for an ordinary-least-squares slope. Every windowed metric '
  '- mean, standard deviation, mean residual, drift slope - is recovered exactly by summing these '
  'over the months in the window, so a roster page costs one aggregate over a few hundred rows rather '
  'than a re-aggregation of the whole grade corpus per request. n_records is NOT additive across '
  'months for distinct-record purposes and is present only for per-month display; a windowed record '
  'count reads av_assessor_window_records.';

-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW av_assessor_window_records AS
SELECT r.assessor_id,
       min(r.occurred_on) AS first_graded_on,
       max(r.occurred_on) AS last_graded_on,
       count(DISTINCT r.record_id)  AS n_records,
       count(DISTINCT r.subject_id) AS n_subjects
FROM av_assessor_residual r
WHERE r.assessor_id IS NOT NULL
GROUP BY r.assessor_id;

COMMENT ON VIEW av_assessor_window_records IS
  'One row per assessor with the distinct record and subject counts over all history. Exists '
  'separately from av_assessor_monthly because count(DISTINCT ...) is not additive across periods: '
  'summing the monthly figure multiplies anyone who appears in more than one month.';

-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW av_assessor_status AS
SELECT ps.person_id                              AS assessor_id,
       ps.on_roster,
       ps.has_login,
       ps.unregistered,
       ps.role_missing,
       wr.last_graded_on,
       CASE
         WHEN NOT ps.has_login THEN 'former'
         WHEN wr.last_graded_on IS NULL
           OR wr.last_graded_on < (CURRENT_DATE
                - (analytics_int('assessor_fairness.status.dormant_after_days') || ' days')::INTERVAL)
           THEN 'dormant'
         ELSE 'current'
       END                                       AS status
FROM av_person_status ps
JOIN av_assessor_window_records wr ON wr.assessor_id = ps.person_id;

COMMENT ON VIEW av_assessor_status IS
  'One row per person who has ever awarded a grade. Status is DERIVED, never stored, and NOBODY IS '
  'HIDDEN: unregistered and role_missing are data-hygiene tags rather than exclusions. Status is a '
  'DISPLAY FILTER ONLY - grades from dormant and former assessors stay in the peer mean and in every '
  'current assessor''s expected-grade calculation, because removing them changes everyone else''s '
  'number. Uses CURRENT_DATE, so any consumer that needs a reproducible as-at result computes status '
  'in lib/analytics with an injected asOf instead.';
