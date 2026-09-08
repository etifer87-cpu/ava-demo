-- 0110_av_indicator_base.sql
-- Analytics layer, part 11 of 20. docs/06_ANALYTICS.md §5.1, §5.5.
-- Frozen base statistics and alert levels for the program-level indicator.

CREATE OR REPLACE VIEW av_indicator_base AS
WITH windowed AS (
  SELECT s.metric, s.grain, s.scope, s.framework_id, s.competency_id,
         s.period, s.num, s.den,
         CASE WHEN s.den > 0 THEN s.num::NUMERIC / s.den END AS period_rate
  FROM av_indicator_series s
  JOIN av_scope sc ON sc.scope = s.scope
  WHERE s.period >= sc.base_from
    AND s.period <= sc.base_to
),
agg AS (
  SELECT metric, grain, scope, framework_id, competency_id,
         sum(num)                      AS base_num,
         sum(den)                      AS base_den,
         count(*)                      AS base_periods_observed,
         stddev_samp(period_rate)      AS sd_p,
         min(period)                   AS first_period,
         max(period)                   AS last_period
  FROM windowed
  GROUP BY metric, grain, scope, framework_id, competency_id
)
SELECT a.metric,
       a.grain,
       a.scope,
       a.framework_id,
       a.competency_id,
       sc.base_from,
       sc.base_to,
       a.first_period,
       a.last_period,
       a.base_periods_observed,
       sc.base_periods                                        AS base_periods_configured,
       (a.base_periods_observed = sc.base_periods)            AS base_periods_ok,
       CASE WHEN a.base_den > 0 THEN a.base_num::NUMERIC / a.base_den END AS base_rate,
       COALESCE(a.sd_p, 0)                                    AS sd_p,
       CASE WHEN a.base_den > 0
            THEN a.base_num::NUMERIC / a.base_den
               + COALESCE(a.sd_p, 0) * (analytics_json('program_indicator.alert_sigma') ->> 0)::NUMERIC
       END                                                    AS alert1,
       CASE WHEN a.base_den > 0
            THEN a.base_num::NUMERIC / a.base_den
               + COALESCE(a.sd_p, 0) * (analytics_json('program_indicator.alert_sigma') ->> 1)::NUMERIC
       END                                                    AS alert2,
       CASE WHEN a.base_den > 0
            THEN a.base_num::NUMERIC / a.base_den
               + COALESCE(a.sd_p, 0) * (analytics_json('program_indicator.alert_sigma') ->> 2)::NUMERIC
       END                                                    AS alert3,
       CASE
         WHEN analytics_text('program_indicator.target.type') = 'absolute'
           THEN analytics_number('program_indicator.target.value')
         WHEN a.base_den > 0
           THEN (a.base_num::NUMERIC / a.base_den)
                * (1 - analytics_number('program_indicator.target.value'))
       END                                                    AS target,
       (COALESCE(a.sd_p, 0)
          > (a.base_num::NUMERIC / NULLIF(a.base_den, 0))
            * analytics_number('program_indicator.sd_caveat_ratio'))  AS sd_caveat,
       (SELECT c.config_version FROM analytics_config c LIMIT 1)      AS config_version
FROM agg a
JOIN av_scope sc ON sc.scope = a.scope;

COMMENT ON VIEW av_indicator_base IS
  'One row per indicator series (metric, grain, scope, framework, competency): its FROZEN baseline. '
  'base_rate is the POOLED rate over the base window, sum(num)/sum(den), never the mean of the '
  'per-period rates. sd_p is the SAMPLE standard deviation of the per-period rates - a population sd '
  'understates the alert spacing. Alert levels are base_rate + k * sd_p for each k in '
  'program_indicator.alert_sigma; the target is absolute or a relative improvement on base according '
  'to configuration. The base is NEVER recomputed on a schedule: a yardstick that drifts with the '
  'thing it measures makes improvement permanently invisible, so rebasing is an edit to base_from / '
  'base_to plus a version bump recorded in config_versions. '
  'base_periods_ok is the deploy assertion that catches join fan-out: a duplicate inflates numerator '
  'and denominator equally, so the RATE stays plausible while the period count doubles. Assert on '
  'base_periods_ok, never on the rate.';

-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW av_indicator_overdispersion AS
WITH counts AS (
  SELECT s.metric, s.grain, s.scope, s.framework_id, s.competency_id, s.period, s.num
  FROM av_indicator_series s
  JOIN av_scope sc ON sc.scope = s.scope
  WHERE s.period >= sc.base_from AND s.period <= sc.base_to
)
SELECT metric, grain, scope, framework_id, competency_id,
       avg(num)::NUMERIC                            AS mean_count,
       stddev_samp(num)::NUMERIC                    AS observed_sd,
       sqrt(NULLIF(avg(num), 0))::NUMERIC           AS poisson_sd,
       (stddev_samp(num) / NULLIF(sqrt(NULLIF(avg(num), 0)), 0))::NUMERIC AS overdispersion,
       ( (stddev_samp(num) / NULLIF(sqrt(NULLIF(avg(num), 0)), 0))
         < analytics_number('program_indicator.overdispersion_warn_below') ) AS aggregate_up
FROM counts
GROUP BY metric, grain, scope, framework_id, competency_id;

COMMENT ON VIEW av_indicator_overdispersion IS
  'One row per indicator series: the ratio of the observed per-period standard deviation of the '
  'below-standard count to the Poisson standard deviation implied by its mean, over the base window. '
  'A ratio near 1 means period-to-period movement is indistinguishable from counting noise, and a '
  'chart at that period length draws peaks and troughs that mean nothing and invite explanations of '
  'randomness - aggregate_up says so explicitly. A near-Poisson series is not a defect: a stable '
  'exposure is exactly what makes a genuine future shift visible.';
