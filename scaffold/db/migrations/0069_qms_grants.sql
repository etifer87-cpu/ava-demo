-- 0069_qms_grants.sql
-- QMS: grants shipped with the module. A clean install that omits these produces tables the
-- application role cannot read, and the failure looks like a missing table.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON qual_types, qual_type_versions, qualifications, '
            'qual_approvals, attestations TO tms_app';
    EXECUTE 'GRANT SELECT, INSERT ON qms_events TO tms_app';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE qms_events_id_seq TO tms_app';
    EXECUTE 'REVOKE UPDATE, DELETE ON qms_events FROM tms_app';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_readonly') THEN
    EXECUTE 'GRANT SELECT ON qual_types, qual_type_versions, qualifications, qual_approvals, '
            'attestations, qms_events TO tms_readonly';
  END IF;
END
$$;
