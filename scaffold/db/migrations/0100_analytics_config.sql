-- 0100_analytics_config.sql
-- Analytics layer, part 1 of 20 (0100-0119). Specified by docs/06_ANALYTICS.md §2, §17.
--
-- Owns two objects outside contract §9's "av_* views and grade_num()":
--   analytics_config  - the loaded contents of scaffold/config/analytics.yaml
--   analytics_number/int/text/json - the readers every later view uses
-- Declared here because contract rule 7 (no threshold inline in code or SQL)
-- cannot be satisfied without a place for SQL to read config from.
--
-- Forward-only. Re-runnable.

CREATE TABLE IF NOT EXISTS analytics_config (
  key             TEXT PRIMARY KEY,
  value_num       NUMERIC,
  value_text      TEXT,
  value_json      JSONB,
  config_version  TEXT        NOT NULL,
  loaded_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE analytics_config IS
  'One row per leaf key of scaffold/config/analytics.yaml, flattened to a dotted path '
  '(e.g. grade_scale.below_standard_max). Loaded by scripts/load-analytics-config.mjs; '
  'never edited by hand and never written by the application. Every threshold, weight, '
  'window, band boundary and minimum sample used by any av_* view is read from here.';

COMMENT ON COLUMN analytics_config.key IS
  'The dotted path of a leaf key. A container that a view needs whole - program_indicator.scopes, '
  'program_indicator.alert_sigma, screening_index.points - is ALSO stored under its own path with the '
  'subtree in value_json, so SQL can read it in one call without reassembling leaves.';

COMMENT ON COLUMN analytics_config.config_version IS
  'The version string from analytics.yaml at load time. Printed on every governance surface '
  'so a chart can be tied to the configuration it was drawn against.';

-- ---------------------------------------------------------------------------
-- Readers. All raise on a missing key: a missing threshold must fail loudly,
-- never silently default. A default here would be a hardcoded threshold.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION analytics_require(p_key TEXT)
RETURNS analytics_config
LANGUAGE plpgsql STABLE PARALLEL SAFE
AS $$
DECLARE r analytics_config;
BEGIN
  SELECT * INTO r FROM analytics_config WHERE key = p_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'analytics_config key % is not loaded. Run scripts/load-analytics-config.mjs.', p_key
      USING ERRCODE = 'no_data_found';
  END IF;
  RETURN r;
END;
$$;

CREATE OR REPLACE FUNCTION analytics_number(p_key TEXT)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE PARALLEL SAFE
AS $$
DECLARE r analytics_config;
BEGIN
  r := analytics_require(p_key);
  IF r.value_num IS NULL THEN
    RAISE EXCEPTION 'analytics_config key % holds no numeric value', p_key;
  END IF;
  RETURN r.value_num;
END;
$$;

CREATE OR REPLACE FUNCTION analytics_int(p_key TEXT)
RETURNS INT
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT analytics_number(p_key)::INT $$;

CREATE OR REPLACE FUNCTION analytics_text(p_key TEXT)
RETURNS TEXT
LANGUAGE plpgsql STABLE PARALLEL SAFE
AS $$
DECLARE r analytics_config;
BEGIN
  r := analytics_require(p_key);
  IF r.value_text IS NULL THEN
    RAISE EXCEPTION 'analytics_config key % holds no text value', p_key;
  END IF;
  RETURN r.value_text;
END;
$$;

CREATE OR REPLACE FUNCTION analytics_json(p_key TEXT)
RETURNS JSONB
LANGUAGE plpgsql STABLE PARALLEL SAFE
AS $$
DECLARE r analytics_config;
BEGIN
  r := analytics_require(p_key);
  RETURN COALESCE(r.value_json, 'null'::JSONB);
END;
$$;

COMMENT ON FUNCTION analytics_number(TEXT) IS
  'Reads one numeric threshold from analytics_config. Raises when the key is absent: a missing '
  'threshold must fail loudly rather than default, because a default in SQL is a hardcoded threshold.';

-- ---------------------------------------------------------------------------
-- grade_num(text) -> int
-- The single definition of a valid grade in the platform. docs/06_ANALYTICS.md §2.2.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION grade_num(p_grade TEXT)
RETURNS INT
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT CASE
           WHEN p_grade IS NULL THEN NULL
           WHEN btrim(p_grade) ~ analytics_text('grade_scale.valid_pattern')
             THEN btrim(p_grade)::INT
           ELSE NULL
         END
$$;

COMMENT ON FUNCTION grade_num(TEXT) IS
  'Coerces a stored grade to an integer, returning NULL unless it matches '
  'grade_scale.valid_pattern from analytics_config. NR, NO, NA, blanks and anything unparseable '
  'resolve to NULL and are excluded from BOTH numerator and denominator of every metric. '
  'STABLE rather than IMMUTABLE because the pattern is configuration: it therefore cannot be '
  'used in an expression index. Index the raw grade column instead.';

-- ---------------------------------------------------------------------------
-- Convenience predicates. They read config; they do not define it.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION grade_is_below_standard(p_grade TEXT)
RETURNS BOOLEAN
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT grade_num(p_grade) IS NOT NULL
     AND grade_num(p_grade) <= analytics_int('grade_scale.below_standard_max')
$$;

CREATE OR REPLACE FUNCTION grade_is_critical(p_grade TEXT)
RETURNS BOOLEAN
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT grade_num(p_grade) = analytics_int('grade_scale.critical_grade')
$$;

COMMENT ON FUNCTION grade_is_below_standard(TEXT) IS
  'True when the grade is valid and at or below grade_scale.below_standard_max. The boundary is '
  'stated once, in analytics.yaml; this function reads it and no view restates it.';
