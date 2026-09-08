-- 0034_element_answer_columns.sql
-- ETR. Repeatable-group instances and typed field answers, on the live grade table and on its
-- frozen copy. Specified by docs/05_TEMPLATES_AND_BUILDER.md section 4.
--
-- docs/05 section 4 states the answer model exactly:
--
--   element_grades(session_id, person_id, element_key, instance_no, attempt, grade, remarks, graded_at)
--   ... "instance_no covers repeatable groups; attempt covers repeats of the same item. Field-type
--   elements store into element_grades.value_text / value_num / value_date on the same key."
--
-- 0026 carried neither instance_no nor the value columns, so migration 0033's `group` and `field`
-- element types had nowhere to put their answers: a template could declare a repeatable attendance
-- group and the second instance would collide with the first on the uniqueness constraint.
--
-- THE UNIQUENESS CONSTRAINT IS THE POINT OF THIS MIGRATION. (session, person, element_key, attempt)
-- says "one answer per element per attempt", which is exactly wrong for a repeatable group: the
-- second instance is not a second attempt at the first, it is a different row of the same form. An
-- upsert naming the old conflict target would silently overwrite instance 1 with instance 2, and
-- the loss would look like a subject who was never entered.
--
-- WHY record_tasks GETS THE SAME COLUMNS. docs/14_SEED_AND_SYNTHETIC_DATA.md section 10: seeded and
-- frozen data must match what the application writes, in shape. If element_grades can hold three
-- instances of one key and record_tasks cannot, finalise silently drops two of them and the record
-- disagrees with the session it was frozen from.
--
-- Forward-only: 0026 and 0029 are not edited. Existing rows default to instance_no = 1, which is
-- what every non-repeatable element has always meant.

-- ---------------------------------------------------------------------------
-- element_grades
-- ---------------------------------------------------------------------------
ALTER TABLE element_grades
  ADD COLUMN IF NOT EXISTS instance_no INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS value_text  TEXT,
  ADD COLUMN IF NOT EXISTS value_num   NUMERIC,
  ADD COLUMN IF NOT EXISTS value_date  DATE;

ALTER TABLE element_grades
  DROP CONSTRAINT IF EXISTS element_grades_instance_no_check;
ALTER TABLE element_grades
  ADD CONSTRAINT element_grades_instance_no_check CHECK (instance_no >= 1);

-- Drop the old uniqueness by inspection: it was declared inline in 0026 and Postgres named it, so
-- a guessed name that does not match would leave the old constraint in place and this migration
-- would be a no-op that still reported success.
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT con.conname
      FROM pg_constraint con
     WHERE con.conrelid = 'element_grades'::regclass
       AND con.contype = 'u'
       AND (
         SELECT array_agg(att.attname::TEXT ORDER BY att.attname)
           FROM unnest(con.conkey) AS k(attnum)
           JOIN pg_attribute att
             ON att.attrelid = con.conrelid AND att.attnum = k.attnum
       ) = ARRAY['attempt', 'element_key', 'person_id', 'session_id']
  LOOP
    EXECUTE format('ALTER TABLE element_grades DROP CONSTRAINT %I', c.conname);
    RAISE NOTICE '0034: dropped superseded uniqueness % on element_grades', c.conname;
  END LOOP;
END $$;

ALTER TABLE element_grades
  DROP CONSTRAINT IF EXISTS element_grades_answer_uniq;
ALTER TABLE element_grades
  ADD CONSTRAINT element_grades_answer_uniq
  UNIQUE (session_id, person_id, element_key, instance_no, attempt);

COMMENT ON COLUMN element_grades.instance_no IS
  'Which instance of a repeatable group this answer belongs to, from 1. A different instance is a different row of the same form, NOT another attempt at the same row - the two axes are independent and both are in the uniqueness constraint.';
COMMENT ON COLUMN element_grades.value_text IS
  'Answer for a field element whose field_type is text, textarea, select, radio or checkbox. Separate from grade, because a field answer is data the assessor recorded and a grade is a judgement they made; a shared column would put both in every grade distribution.';
COMMENT ON COLUMN element_grades.value_num IS
  'Answer for a field element whose field_type is number. NUMERIC, not INTEGER: a field can capture hours or a mass.';
COMMENT ON COLUMN element_grades.value_date IS
  'Answer for a field element whose field_type is date. A DATE column rather than a parsed string, because dates in this domain are day-first and a string that is parsed at read time is parsed differently by two readers.';

-- ---------------------------------------------------------------------------
-- record_tasks - the frozen copy, same shape
-- ---------------------------------------------------------------------------
ALTER TABLE record_tasks
  ADD COLUMN IF NOT EXISTS instance_no INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS value_text  TEXT,
  ADD COLUMN IF NOT EXISTS value_num   NUMERIC,
  ADD COLUMN IF NOT EXISTS value_date  DATE;

ALTER TABLE record_tasks
  DROP CONSTRAINT IF EXISTS record_tasks_instance_no_check;
ALTER TABLE record_tasks
  ADD CONSTRAINT record_tasks_instance_no_check CHECK (instance_no >= 1);

DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT con.conname
      FROM pg_constraint con
     WHERE con.conrelid = 'record_tasks'::regclass
       AND con.contype = 'u'
       AND (
         SELECT array_agg(att.attname::TEXT ORDER BY att.attname)
           FROM unnest(con.conkey) AS k(attnum)
           JOIN pg_attribute att
             ON att.attrelid = con.conrelid AND att.attnum = k.attnum
       ) = ARRAY['attempt', 'element_key', 'record_id']
  LOOP
    EXECUTE format('ALTER TABLE record_tasks DROP CONSTRAINT %I', c.conname);
    RAISE NOTICE '0034: dropped superseded uniqueness % on record_tasks', c.conname;
  END LOOP;
END $$;

ALTER TABLE record_tasks
  DROP CONSTRAINT IF EXISTS record_tasks_answer_uniq;
ALTER TABLE record_tasks
  ADD CONSTRAINT record_tasks_answer_uniq
  UNIQUE (record_id, element_key, instance_no, attempt);

COMMENT ON COLUMN record_tasks.instance_no IS
  'The frozen counterpart of element_grades.instance_no. Present so that a record can carry every instance of a repeatable group; a frozen copy that cannot represent what the session held is a copy that loses rows at finalise.';
COMMENT ON COLUMN record_tasks.value_text IS 'Frozen field answer, text-valued. See element_grades.value_text.';
COMMENT ON COLUMN record_tasks.value_num  IS 'Frozen field answer, numeric. See element_grades.value_num.';
COMMENT ON COLUMN record_tasks.value_date IS 'Frozen field answer, date-valued. See element_grades.value_date.';

DO $$
BEGIN
  RAISE NOTICE '0034: instance_no and value_text/value_num/value_date added to element_grades and record_tasks; uniqueness now includes instance_no on both.';
END $$;
