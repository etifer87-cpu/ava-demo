-- 0089_dms_grants.sql
-- DMS: grants shipped with the module. Omitting them produces a clean install whose tables the
-- application role cannot read, and the failure presents as a missing table.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON doc_folders, documents, retention_rules TO tms_app';
    EXECUTE 'GRANT SELECT, INSERT ON document_versions, document_access TO tms_app';
    EXECUTE 'GRANT UPDATE (is_current, archived_at, archived_storage_key, chunk_count, '
            'chunked_at, chunks_retired_at, deleted_at) ON document_versions TO tms_app';
    -- Deletion is a move, never a DELETE. No application role holds DELETE on any DMS table.
    EXECUTE 'REVOKE DELETE ON doc_folders, documents, document_versions, document_access, '
            'retention_rules FROM tms_app';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_readonly') THEN
    EXECUTE 'GRANT SELECT ON doc_folders, documents, document_versions, retention_rules '
            'TO tms_readonly';
    -- The access log is not part of the analytics surface.
    EXECUTE 'REVOKE SELECT ON document_access FROM tms_readonly';
  END IF;
END
$$;
