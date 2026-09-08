-- 0032_template_kinds.sql
-- ETR. The template-kind vocabulary becomes a catalogue table, and session_templates.template_kind
-- references it instead of a CHECK.
--
-- WHY A LOOKUP TABLE RATHER THAN A WIDER CHECK.
--
-- docs/04_ETR.md section 4 defines template_kind as "a controlled vocabulary from
-- config/policy.yaml, shared by the builder and the session-create filter. It is configuration; an
-- operator edits it without touching code." A CHECK cannot be that. Every kind an operator adds,
-- renames or retires would be a migration, a review and a deploy, and the vocabulary would drift
-- from policy.yaml the first time somebody was in a hurry. The contract says the same thing in
-- general terms (docs/02_DATA_MODEL.md section 6, Enums): a constrained vocabulary is a CHECK on
-- TEXT, OR a catalogue table where the vocabulary is operator-editable. This one is.
--
-- 0020 constrained the column to six COARSE FAMILIES - ground, simulator, line, line_check,
-- assessment, other - while docs/04 section 4 defines twelve PROCESS kinds. config/policy.yaml
-- bridged the two with a db_kind mapping, so the database recorded "simulator" for four different
-- kinds of event and no read surface could tell an upset-recovery session from a recurrent one.
-- After this migration the column carries the process kind the author actually chose, the mapping
-- is deleted from policy.yaml, and analytics.yaml's program_indicator.scopes select on process
-- kinds directly.
--
-- FORWARD-ONLY. 0020 is not edited. The six coarse family codes are inserted here as RETIRED rows
-- so that any template written before this migration stays referentially valid; they are not
-- offered to an author and nothing new may be created under them. A data migration that guessed a
-- process kind from a family would be inventing a fact about somebody's training event -
-- "simulator" maps to four kinds and there is no way back.

CREATE TABLE IF NOT EXISTS template_kinds (
  code                      TEXT PRIMARY KEY,
  label                     TEXT        NOT NULL,
  -- The facility a session of this kind is normally held at. Seeds sessions.facility_kind; the
  -- vocabulary is the one 0024 constrains that column to.
  facility_kind             TEXT        CHECK (facility_kind IN ('ffs','ftd','classroom','aircraft','line','other')),
  -- One event, many subjects, one record each: signing fans the event out.
  fan_out_on_signature      BOOLEAN     NOT NULL DEFAULT false,
  -- Whether a repeat attempt is a concept at all for this kind. On the line it is not: repeat
  -- logic is SKIPPED, not zeroed, and zero is a different claim from not-applicable.
  supports_attempts         BOOLEAN     NOT NULL DEFAULT false,
  -- docs/05_TEMPLATES_AND_BUILDER.md section 7: one record IS one sector.
  one_record_per_sector     BOOLEAN     NOT NULL DEFAULT false,
  -- Restricted kinds are hidden from the subject entirely; copied onto the record at finalise.
  hide_record_from_subject  BOOLEAN     NOT NULL DEFAULT false,
  position                  INT         NOT NULL DEFAULT 0,
  is_active                 BOOLEAN     NOT NULL DEFAULT true,
  note                      TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS template_kinds_updated_at ON template_kinds;
CREATE TRIGGER template_kinds_updated_at BEFORE UPDATE ON template_kinds
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE template_kinds IS
  'The operator-editable vocabulary of session template kinds, referenced by session_templates.template_kind. A catalogue rather than a CHECK because docs/04_ETR.md defines this list as configuration: adding, renaming or retiring a kind is an INSERT or an UPDATE, never a migration.';
COMMENT ON COLUMN template_kinds.is_active IS
  'false = retired. A retired kind is not offered to an author and no new template may be created under it, but existing templates keep referencing it. Nothing in this platform hard-deletes a vocabulary entry that data still points at.';
COMMENT ON COLUMN template_kinds.supports_attempts IS
  'false means repeat attempts are NOT A CONCEPT for this kind, which is a different statement from "no repeats were observed". Read surfaces skip repeat logic rather than reporting zero.';

-- ---------------------------------------------------------------------------
-- The twelve process kinds of docs/04_ETR.md section 4, in that order. A neutral
-- starter list: an operator replaces it before the first real session is graded.
-- ---------------------------------------------------------------------------
INSERT INTO template_kinds
  (code, label, facility_kind, fan_out_on_signature, supports_attempts,
   one_record_per_sector, hide_record_from_subject, position, is_active, note)
VALUES
  ('ground_school',        'Ground school',                'classroom', true,  false, false, false,  1, true, NULL),
  ('simulator_recurrent',  'Simulator, recurrent',         'ffs',       false, true,  false, false,  2, true, NULL),
  ('proficiency_check',    'Proficiency check',            'ffs',       false, true,  false, false,  3, true, NULL),
  ('line_check',           'Line check',                   'line',      false, false, false, false,  4, true,
     'No repeat attempts exist on the line; repeat logic is skipped, not zeroed.'),
  ('line_supervised',      'Supervised line flying',       'line',      false, false, true,  false,  5, true,
     'One record is one sector. A multi-sector duty day is two records, and there is no repeatable leg group.'),
  ('command_upgrade',      'Command upgrade',              'ffs',       false, true,  false, false,  6, true, NULL),
  ('crm',                  'Crew resource management',     'classroom', true,  false, false, false,  7, true, NULL),
  ('low_visibility',       'Low visibility operations',    'ffs',       false, true,  false, false,  8, true, NULL),
  ('upset_recovery',       'Upset prevention and recovery','ffs',       false, true,  false, false,  9, true, NULL),
  ('aerodrome_competence', 'Aerodrome competence',         'classroom', true,  false, false, false, 10, true, NULL),
  ('assessment',           'Assessment or selection',      'other',     false, false, false, true,  11, true,
     'Restricted: hidden from the subject entirely, and the record carries a stand-down period and an attempt number.'),
  ('other',                'Other',                        'other',     false, false, false, false, 12, true, NULL)
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- The six coarse families 0020 used to constrain the column to, retained as
-- RETIRED codes so pre-0032 rows stay referentially valid. Not offered, not
-- selectable, and deliberately not mapped onto a process kind by a guess.
-- 'line_check', 'assessment' and 'other' are already above under the same
-- spelling and are therefore not repeated.
-- ---------------------------------------------------------------------------
INSERT INTO template_kinds
  (code, label, facility_kind, position, is_active, note)
VALUES
  ('ground',    'Ground (retired family code)',    'classroom', 90, false,
     'Retired by migration 0032. A coarse family from the pre-0032 CHECK, kept only so templates written before that migration stay valid.'),
  ('simulator', 'Simulator (retired family code)', 'ffs',       91, false,
     'Retired by migration 0032. Mapped from four different process kinds, which is why the family was replaced rather than kept.'),
  ('line',      'Line (retired family code)',      'line',      92, false,
     'Retired by migration 0032.')
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Swap the CHECK for the reference. The constraint is found by inspection
-- rather than by name: an inline column CHECK is named by Postgres, and a name
-- guessed in a migration that then silently does not match leaves the old
-- constraint in place and this whole migration a no-op.
-- ---------------------------------------------------------------------------
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'session_templates'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%template_kind%'
  LOOP
    EXECUTE format('ALTER TABLE session_templates DROP CONSTRAINT %I', c.conname);
    RAISE NOTICE '0032: dropped CHECK % on session_templates.template_kind', c.conname;
  END LOOP;
END $$;

ALTER TABLE session_templates
  DROP CONSTRAINT IF EXISTS session_templates_template_kind_fk;
ALTER TABLE session_templates
  ADD CONSTRAINT session_templates_template_kind_fk
  FOREIGN KEY (template_kind) REFERENCES template_kinds(code);

COMMENT ON COLUMN session_templates.template_kind IS
  'The process kind of this template, referencing template_kinds(code). Twelve values ship; an operator edits the catalogue. analytics.yaml program_indicator.scopes select on these values directly.';

-- Grants ship with the object. A table the application role cannot read fails as a missing table.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON template_kinds TO tms_app';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_readonly') THEN
    EXECUTE 'GRANT SELECT ON template_kinds TO tms_readonly';
  END IF;
END
$$;

-- Verification, printed rather than assumed. The runner listens for notices.
DO $$
DECLARE n_active INT; n_retired INT; n_orphan INT;
BEGIN
  SELECT count(*) FILTER (WHERE is_active), count(*) FILTER (WHERE NOT is_active)
    INTO n_active, n_retired FROM template_kinds;
  SELECT count(*) INTO n_orphan
    FROM session_templates st
    LEFT JOIN template_kinds tk ON tk.code = st.template_kind
   WHERE tk.code IS NULL;
  RAISE NOTICE '0032: template_kinds has % active and % retired codes; % orphan session_templates rows',
    n_active, n_retired, n_orphan;
END $$;
