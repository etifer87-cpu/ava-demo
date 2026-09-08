-- 0030_line_sectors.sql
-- ETR. Line flying under supervision, where the unit of assessment is a sector rather than a task.
-- Attaches to a live session, to a frozen record, or to both.

CREATE TABLE IF NOT EXISTS line_sectors (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     UUID        REFERENCES sessions(id) ON DELETE CASCADE,
  record_id      UUID        REFERENCES records(id)  ON DELETE CASCADE,
  person_id      UUID        NOT NULL REFERENCES people(id),
  sector_number  INT         NOT NULL CHECK (sector_number >= 1),
  flight_ref     TEXT,
  sector_date    DATE,
  departure      TEXT,
  arrival        TEXT,
  pf_role        TEXT,
  is_supervised  BOOLEAN     NOT NULL DEFAULT true,
  outcome        TEXT,
  remark         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ,
  CONSTRAINT line_sectors_has_parent CHECK (session_id IS NOT NULL OR record_id IS NOT NULL),
  UNIQUE (session_id, person_id, sector_number)
);

CREATE INDEX IF NOT EXISTS line_sectors_person ON line_sectors (person_id, sector_date DESC);
CREATE INDEX IF NOT EXISTS line_sectors_record ON line_sectors (record_id);

COMMENT ON TABLE line_sectors IS 'Sector-level detail for line training and line checks, attached to a session, a record, or both.';
