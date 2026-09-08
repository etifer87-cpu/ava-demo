-- 0129_integration_grants.sql
-- Integration and dispatch: grants shipped with the module.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON external_refs, sync_runs, api_keys, '
            'webhook_deliveries, dispatch_rules, dispatch_notices TO tms_app';
    EXECUTE 'REVOKE DELETE ON external_refs, sync_runs, api_keys, webhook_deliveries, '
            'dispatch_rules, dispatch_notices FROM tms_app';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_readonly') THEN
    EXECUTE 'GRANT SELECT ON external_refs, sync_runs, dispatch_rules TO tms_readonly';
    -- Credentials and message payloads are not part of the analytics surface.
    EXECUTE 'REVOKE SELECT ON api_keys, webhook_deliveries, dispatch_notices FROM tms_readonly';
  END IF;
END
$$;
