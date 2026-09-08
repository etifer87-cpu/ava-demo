-- 0066_qms_crossrefs.sql
-- QMS: foreign keys that could not be declared inline because the target table is created later.
-- Guarded so the migration is idempotent; ADD CONSTRAINT has no IF NOT EXISTS.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'qualifications_approval_fk') THEN
    ALTER TABLE qualifications
      ADD CONSTRAINT qualifications_approval_fk
      FOREIGN KEY (approval_id) REFERENCES qual_approvals (id);
  END IF;
END
$$;

COMMENT ON CONSTRAINT qualifications_approval_fk ON qualifications IS
  'Every holding points at the approval that authorised it. Nullable only for rows imported from a '
  'legacy estate, which carry source <> app and are reported as an exception list until an '
  'approval record is reconstructed.';
