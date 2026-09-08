-- 0029_record_children.sql
-- ETR. The frozen per-task and per-competency detail of a record.

CREATE TABLE IF NOT EXISTS record_tasks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id     UUID        NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  -- NOT NULL even for imports. The importer synthesises a stable key from the normalised task name
  -- (lowercased, punctuation collapsed, syllabus number stripped) and puts the raw number in
  -- external_ref. That is what stops one task splitting across buckets when a curriculum
  -- renumbers, and it is done ONCE at import, not at every read.
  element_key   TEXT        NOT NULL,
  external_ref  TEXT,
  task_name     TEXT,
  position      INT         NOT NULL DEFAULT 0,
  attempt       INT         NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  grade         TEXT,
  remark        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (record_id, element_key, attempt)
);

CREATE INDEX IF NOT EXISTS record_tasks_record ON record_tasks (record_id, position);
CREATE INDEX IF NOT EXISTS record_tasks_key    ON record_tasks (element_key);

CREATE TABLE IF NOT EXISTS record_competencies (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id                 UUID   NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  framework_id              UUID   NOT NULL,   -- FK added in 0042
  competency_id             UUID   NOT NULL,   -- FK added in 0042
  grade                     TEXT,
  remark                    TEXT,
  -- An array rather than a junction table, because a record is frozen: nothing ever inserts into
  -- or deletes from a single record's OB set after finalise. No FK is possible on an array; the
  -- referential check happens at import and in an analytics check view.
  observable_behaviour_ids  UUID[] NOT NULL DEFAULT '{}',
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (record_id, competency_id)
);

CREATE INDEX IF NOT EXISTS record_competencies_record ON record_competencies (record_id);
CREATE INDEX IF NOT EXISTS record_competencies_comp
  ON record_competencies (framework_id, competency_id);
CREATE INDEX IF NOT EXISTS record_competencies_obs
  ON record_competencies USING GIN (observable_behaviour_ids);

COMMENT ON TABLE record_tasks IS 'Frozen per-task, per-attempt grades of a record; every attempt is a row, because only the last attempt is not the grade.';
COMMENT ON TABLE record_competencies IS 'Frozen per-competency grades of a record, with the supporting observable behaviours as an id array.';
