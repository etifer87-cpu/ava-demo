-- 0144_program_builder.sql
-- Program builder (docs/06_PROGRAM_BUILDER.md sections 2 and 4.2). Avianca replication, 2026-09-11.
--
-- THE BUILDER ADDS NO TABLES TO THE TEMPLATE MODEL. Programs are session_templates and their
-- versions; modules, sessions and blocks are nested `section` elements; events are `task`
-- elements; the library is element_library. That model already carries the published-version
-- immutability trigger (0021) and every grade keys on it, so a second model would fork the product.
--
-- What IS new is the equivalency group: a named set of library elements that a task may draw from
-- at delivery instead of naming one fixed failure - "engine malfunction, take-off" holding three
-- candidates. The task references the group by code in content.conduct.slot (lib/program/shape.ts);
-- the group and its candidates live here so that the library, not a task, is the authority on what
-- the candidates are. Candidates are library rows, so a malfunction edited in the library is edited
-- for every group that holds it.
--
-- Soft-delete only, like the library: a group that a published version references must stay
-- readable for as long as that version does.

CREATE TABLE IF NOT EXISTS equivalency_groups (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code            TEXT        NOT NULL CHECK (code ~ '^[a-z0-9][a-z0-9_.-]{0,62}$'),
  name            TEXT        NOT NULL,
  description     TEXT,
  -- NULL = every fleet. A group of A320 engine malfunctions is bound to A320.
  asset_class_id  UUID        REFERENCES asset_classes(id),
  -- Which library element types the group may hold. A picker enumerates by this.
  candidate_type  TEXT        NOT NULL DEFAULT 'event_option'
                              CHECK (candidate_type IN ('event_option', 'task', 'setup')),
  is_active       BOOLEAN     NOT NULL DEFAULT true,
  created_by      UUID        REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS equivalency_groups_code_live
  ON equivalency_groups (code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS equivalency_groups_asset_class
  ON equivalency_groups (asset_class_id) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS equivalency_groups_updated_at ON equivalency_groups;
CREATE TRIGGER equivalency_groups_updated_at BEFORE UPDATE ON equivalency_groups
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS equivalency_groups_no_hard_delete ON equivalency_groups;
CREATE TRIGGER equivalency_groups_no_hard_delete BEFORE DELETE ON equivalency_groups
  FOR EACH ROW EXECUTE FUNCTION deny_hard_delete();

CREATE TABLE IF NOT EXISTS equivalency_group_candidates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    UUID        NOT NULL REFERENCES equivalency_groups(id) ON DELETE CASCADE,
  library_id  UUID        NOT NULL REFERENCES element_library(id),
  position    INT         NOT NULL DEFAULT 0,
  is_active   BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (group_id, library_id)
);

CREATE INDEX IF NOT EXISTS equivalency_group_candidates_order
  ON equivalency_group_candidates (group_id, position);

-- The tree builder (lib/program/model.ts) reads one version's elements by parent and position.
CREATE INDEX IF NOT EXISTS template_elements_tree
  ON template_elements (template_version_id, parent_key, position);

COMMENT ON TABLE equivalency_groups IS
  'Named sets of interchangeable library elements a task may draw from at delivery (a "slot"); referenced by code from template_elements.content.conduct.slot. Soft-delete only.';
COMMENT ON COLUMN equivalency_groups.candidate_type IS
  'The element_library.element_type every candidate must have; the picker filters by it and the write path rejects a candidate of another type.';
COMMENT ON TABLE equivalency_group_candidates IS
  'The library elements that make up one equivalency group, ordered; the library row is the authority on the candidate name and content.';
COMMENT ON INDEX template_elements_tree IS
  'Serves the tree builder, which reads one version''s elements grouped by parent_key in position order.';

-- element_library.tags carries the library KIND from here on. Not a column: a library element can
-- be both a malfunction and part of a preset, and an operator adds a kind without a migration.
-- The builder offers these tag values; nothing rejects others.
COMMENT ON COLUMN element_library.tags IS
  'Free tags; the program builder reads library kind from them (task, block, malfunction, inject, airport, weather, mass_config, position, reset, atc_script, preset) and fleet from a fleet:<code> tag.';

DO $$
BEGIN
  RAISE NOTICE '0144: equivalency_groups and equivalency_group_candidates created; template_elements_tree index added; library kinds documented on element_library.tags.';
END $$;
