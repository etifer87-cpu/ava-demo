-- 0013_app_settings.sql
-- Core platform. Operational switches only: bcrypt cost, session lifetime, feature flags.
-- Analysis thresholds do NOT live here - they live in config_versions, versioned and checksummed.

CREATE TABLE IF NOT EXISTS app_settings (
  key         TEXT PRIMARY KEY
              CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  value       JSONB       NOT NULL,
  description TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID        REFERENCES users(id)
);

DROP TRIGGER IF EXISTS app_settings_updated_at ON app_settings;
CREATE TRIGGER app_settings_updated_at BEFORE UPDATE ON app_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO app_settings (key, value, description) VALUES
  ('auth.bcrypt_cost',            '12'::jsonb,    'bcrypt cost factor; never lower without review'),
  ('auth.session_lifetime_days',  '7'::jsonb,     'session cookie lifetime'),
  ('auth.max_failed_logins',      '8'::jsonb,     'failed attempts before locked_until is set'),
  ('auth.lockout_minutes',        '15'::jsonb,    'lockout duration'),
  ('llm.enabled',                 'false'::jsonb, 'degraded mode is a supported, tested state')
ON CONFLICT (key) DO NOTHING;

COMMENT ON TABLE app_settings IS 'Operational switches as JSONB rows; not the home for analysis thresholds, which belong to config_versions.';
