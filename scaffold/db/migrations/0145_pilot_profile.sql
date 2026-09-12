-- 0145_pilot_profile.sql
-- The pilot profile the roster screens and the training status read: seniority, rank date,
-- experience, licence, sex, the full set of instructor qualifications, and the roster status
-- (active, candidate under screening, left). Widens `people`; nothing the kit reads changes
-- meaning. Forward-only, idempotent.
--
--   seniority_number   1 = most senior. Unique among live rows. NULL for candidates.
--   instructor_roles   every qualification held (TRI, TRE, SFI, SFE, LTC, CRMI, GI); the kit's
--                      single `instructor_role` stays the HIGHEST one, for everything that reads it.
--   roster_status      active | candidate | left. is_active stays the kit's switch: candidates and
--                      leavers are is_active = false, so every existing scope query keeps working.

ALTER TABLE people
  ADD COLUMN IF NOT EXISTS seniority_number  INT,
  ADD COLUMN IF NOT EXISTS sex               TEXT CHECK (sex IS NULL OR sex IN ('M', 'F')),
  ADD COLUMN IF NOT EXISTS licence_number    TEXT,
  ADD COLUMN IF NOT EXISTS total_hours       INT  CHECK (total_hours IS NULL OR total_hours >= 0),
  ADD COLUMN IF NOT EXISTS hours_on_type     INT  CHECK (hours_on_type IS NULL OR hours_on_type >= 0),
  ADD COLUMN IF NOT EXISTS rank_since        DATE,
  ADD COLUMN IF NOT EXISTS fleet_since       DATE,
  ADD COLUMN IF NOT EXISTS instructor_roles  TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS roster_status     TEXT NOT NULL DEFAULT 'active' CHECK (roster_status IN ('active', 'candidate', 'left')),
  ADD COLUMN IF NOT EXISTS left_on           DATE;

CREATE UNIQUE INDEX IF NOT EXISTS people_seniority_live
  ON people (seniority_number) WHERE deleted_at IS NULL AND seniority_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS people_roster_status ON people (roster_status) WHERE deleted_at IS NULL;

COMMENT ON COLUMN people.seniority_number IS 'Operator seniority: 1 is the most senior pilot. NULL for candidates.';
COMMENT ON COLUMN people.instructor_roles IS 'Every instructor qualification held; instructor_role keeps the highest for the kit.';
COMMENT ON COLUMN people.roster_status IS 'active | candidate (screening, not on the seniority list) | left.';

DO $$ BEGIN RAISE NOTICE '0145: pilot profile columns added to people.'; END $$;
