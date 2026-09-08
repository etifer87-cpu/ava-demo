-- 0085_dms_crossrefs.sql
-- DMS: deferred foreign keys whose target tables are created after documents.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_retention_rule_fk') THEN
    ALTER TABLE documents
      ADD CONSTRAINT documents_retention_rule_fk
      FOREIGN KEY (retention_rule_id) REFERENCES retention_rules (id);
  END IF;
END
$$;

COMMENT ON CONSTRAINT documents_retention_rule_fk ON documents IS
  'The rule version that produced retain_until, frozen at approval. Keeping the rule id as well as '
  'the date is what lets an auditor see which schedule a disposal date came from.';
