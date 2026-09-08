-- 0106_av_scope.sql
-- Analytics layer, part 7 of 20. docs/06_ANALYTICS.md §5.4.
-- Indicator scopes, resolved from configuration rather than from a WHERE clause.
--
-- A scope is a named slice with its own period length, its own template
-- families and its own frozen base window. Adding, renaming or re-scoping one
-- is an edit to program_indicator.scopes in analytics.yaml plus a config
-- reload. It is never a new view and never a new predicate.

CREATE OR REPLACE VIEW av_scope AS
SELECT s.key                                        AS scope,
       s.value ->> 'label'                          AS label,
       s.value ->> 'period'                         AS period_grain,
       (s.value ->> 'base_from')::DATE              AS base_from,
       (s.value ->> 'base_to')::DATE                AS base_to,
       (s.value ->> 'base_periods')::INT            AS base_periods,
       (s.value ->> 'default_window_periods')::INT  AS default_window_periods,
       COALESCE(s.value -> 'template_kinds', '[]'::JSONB)        AS template_kinds,
       COALESCE(s.value -> 'exclude_asset_class_codes', '[]'::JSONB) AS exclude_asset_class_codes,
       COALESCE((s.value ->> 'pooled_series')::BOOLEAN, false)      AS pooled_series
FROM jsonb_each(analytics_json('program_indicator.scopes')) AS s(key, value);

COMMENT ON VIEW av_scope IS
  'One row per configured indicator scope. period_grain, base window and base_periods come from '
  'analytics.yaml, never from a literal in a view. base_periods counts PERIODS, not months: a '
  'quarterly scope needs the same number of points to estimate a standard deviation from, which '
  'costs three times the calendar, and must not be "corrected" to twelve months.';

-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW av_record_scope AS
SELECT rd.record_id,
       sc.scope,
       sc.period_grain,
       CASE sc.period_grain
         WHEN 'month'   THEN rp.period_month
         WHEN 'quarter' THEN rp.period_quarter
         WHEN 'year'    THEN rp.period_year
       END AS period
FROM av_record_dim rd
JOIN av_record_period rp ON rp.record_id = rd.record_id
JOIN av_scope sc
  ON sc.template_kinds ? rd.template_kind
LEFT JOIN asset_classes ac ON ac.id = rd.asset_class_id
WHERE NOT (sc.exclude_asset_class_codes ? COALESCE(ac.code, ''));

COMMENT ON VIEW av_record_scope IS
  'One row per (record, scope it belongs to), carrying the period key at that scope''s granularity. '
  'A record can belong to more than one scope; scopes are never pooled with EACH OTHER, because '
  'different period lengths and different bases make a cross-scope pooled figure meaningless. '
  'Membership and exclusions are read from configuration, so a template kind joining or leaving a '
  'scope is a config reload rather than a migration.';
