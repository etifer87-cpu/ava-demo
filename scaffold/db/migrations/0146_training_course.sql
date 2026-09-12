-- 0146_training_course.sql
-- Initial training: the course (intake) a pilot belongs to while under type-rating and line
-- training. NULL for line pilots. The stage reached is not stored: it is read from the pilot's
-- records and planned sessions, so it can never disagree with them. Forward-only, idempotent.

ALTER TABLE people ADD COLUMN IF NOT EXISTS training_course TEXT;
CREATE INDEX IF NOT EXISTS people_training_course ON people (training_course) WHERE deleted_at IS NULL AND training_course IS NOT NULL;
COMMENT ON COLUMN people.training_course IS 'Initial-training intake code (e.g. TR-2026-1) while in type-rating or line training; NULL for line pilots.';

DO $$ BEGIN RAISE NOTICE '0146: people.training_course added.'; END $$;
