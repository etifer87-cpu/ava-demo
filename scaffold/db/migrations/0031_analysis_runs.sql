-- 0031_analysis_runs.sql
-- ETR. One row per generated analysis of one person.
--
-- figures is the computed figure set and it is produced entirely in SQL. narrative_html is the
-- model's prose, and it is validated against figures BEFORE it is stored. No number in a report
-- originates in an LLM. config_version_id makes the run reproducible: a figure that cannot name
-- the config it was computed under is not evidence.

CREATE TABLE IF NOT EXISTS analysis_runs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id          UUID        NOT NULL REFERENCES people(id),
  framework_id       UUID,       -- FK added in 0042
  run_kind           TEXT        NOT NULL DEFAULT 'subject',
  status             TEXT        NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued','running','complete','failed')),
  requested_by       UUID        REFERENCES users(id),
  requested_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at       TIMESTAMPTZ,
  config_version_id  UUID        REFERENCES config_versions(id),
  concern_level      TEXT,
  figures            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  narrative_html     TEXT,
  narrative_model    TEXT,       -- which model produced the prose, for degraded-mode auditing
  sources            JSONB       NOT NULL DEFAULT '[]'::jsonb,  -- the records rows consumed
  error              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS analysis_runs_person
  ON analysis_runs (person_id, requested_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS analysis_runs_open
  ON analysis_runs (status) WHERE status IN ('queued','running');

COMMENT ON TABLE analysis_runs IS 'A generated analysis of one person: SQL-computed figures, an optional model-written narrative validated against them, and the config version that produced both.';
