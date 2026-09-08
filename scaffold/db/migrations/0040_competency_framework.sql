-- 0040_competency_framework.sql
-- Framework. The three tables of docs/03_COMPETENCY_FRAMEWORK.md.
-- The framework is DATA, not code: adding a competency, renaming one, changing an OB wording or
-- adopting a different edition is an INSERT or an UPDATE, never a migration and never a redeploy.

CREATE TABLE IF NOT EXISTS competency_frameworks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code            TEXT        NOT NULL UNIQUE,
  name            TEXT        NOT NULL,
  edition         TEXT,
  source_ref      TEXT,       -- the published source this edition follows
  effective_from  DATE,
  is_active       BOOLEAN     NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Exactly one framework is active at a time. Inactive frameworks stay fully readable, which is
-- what lets historical grades survive an edition change untouched.
CREATE UNIQUE INDEX IF NOT EXISTS competency_frameworks_one_active
  ON competency_frameworks (is_active) WHERE is_active;

CREATE TABLE IF NOT EXISTS competencies (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  framework_id  UUID        NOT NULL REFERENCES competency_frameworks(id) ON DELETE CASCADE,
  code          TEXT        NOT NULL,
  "index"       INT         NOT NULL,   -- follows the OB numbering of the source
  name          TEXT        NOT NULL,   -- a DISPLAY string; nothing keys on it
  description   TEXT,
  colour        TEXT        NOT NULL,   -- stored token, so a rebrand is an UPDATE
  position      INT         NOT NULL DEFAULT 0,
  is_active     BOOLEAN     NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (framework_id, code),
  UNIQUE (framework_id, "index")
);

CREATE INDEX IF NOT EXISTS competencies_order ON competencies (framework_id, position);

CREATE TABLE IF NOT EXISTS observable_behaviours (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  competency_id  UUID        NOT NULL REFERENCES competencies(id) ON DELETE CASCADE,
  -- Denormalised on purpose: every analytics query scopes to a framework, and reaching it through
  -- competencies adds a join to the hottest path in the system. Kept consistent by a trigger.
  framework_id   UUID        NOT NULL REFERENCES competency_frameworks(id) ON DELETE CASCADE,
  code           TEXT        NOT NULL CHECK (code ~ '^OB [0-8]\.[0-9]{1,2}$'),
  text           TEXT        NOT NULL,   -- a DISPLAY string; nothing keys on it
  position       INT         NOT NULL DEFAULT 0,
  is_active      BOOLEAN     NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (framework_id, code)
);

CREATE INDEX IF NOT EXISTS observable_behaviours_competency
  ON observable_behaviours (competency_id, position);

CREATE OR REPLACE FUNCTION sync_ob_framework() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_framework UUID;
BEGIN
  SELECT framework_id INTO v_framework FROM competencies WHERE id = NEW.competency_id;
  IF v_framework IS NULL THEN
    RAISE EXCEPTION 'observable behaviour references an unknown competency %', NEW.competency_id;
  END IF;
  NEW.framework_id := v_framework;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS observable_behaviours_framework ON observable_behaviours;
CREATE TRIGGER observable_behaviours_framework
  BEFORE INSERT OR UPDATE ON observable_behaviours
  FOR EACH ROW EXECUTE FUNCTION sync_ob_framework();

COMMENT ON TABLE competency_frameworks IS 'Versioned assessment vocabularies; exactly one is active, and historical grades stay readable under their own framework_id.';
COMMENT ON TABLE competencies IS 'The competencies of one framework, referenced everywhere by id; name and colour are display values changeable by UPDATE.';
COMMENT ON TABLE observable_behaviours IS 'The observable behaviours of one competency; selected, never graded, and referenced by id rather than by text.';
COMMENT ON FUNCTION sync_ob_framework() IS 'Keeps observable_behaviours.framework_id consistent with its parent competency.';
