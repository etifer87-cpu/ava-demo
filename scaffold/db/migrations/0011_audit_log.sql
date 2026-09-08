-- 0011_audit_log.sql
-- Core platform. Append-only, and enforced rather than merely intended.

CREATE TABLE IF NOT EXISTS audit_log (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_user_id    UUID        REFERENCES users(id),
  actor_label      TEXT,        -- survives the account, so an old row still names who acted
  action           TEXT        NOT NULL
                               CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$'),
  entity_table     TEXT,
  entity_id        TEXT,
  capability_code  TEXT,
  reason           TEXT,        -- free text collected at re-authentication
  request_ip       INET,
  user_agent       TEXT,
  details          JSONB       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS audit_log_occurred ON audit_log (occurred_at DESC);
-- text_pattern_ops so the admin log can filter by action prefix (export.%) without a seq scan
CREATE INDEX IF NOT EXISTS audit_log_action
  ON audit_log (action text_pattern_ops, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_entity ON audit_log (entity_table, entity_id);
CREATE INDEX IF NOT EXISTS audit_log_actor  ON audit_log (actor_user_id, occurred_at DESC);

DROP TRIGGER IF EXISTS audit_log_immutable ON audit_log;
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM PUBLIC;

COMMENT ON TABLE audit_log IS 'Append-only record of who did what to which entity, enforced by a trigger and a REVOKE; writes are best-effort and never block the action they describe.';
