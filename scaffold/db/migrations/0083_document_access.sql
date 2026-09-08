-- 0083_document_access.sql
-- DMS: explicit grants and denials, review chain steps, and the access log for sensitive classes.
-- See docs/09_DMS.md section 7 and docs/17_GOVERNANCE.md section 2.

CREATE TABLE IF NOT EXISTS document_access (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_kind      TEXT NOT NULL CHECK (entry_kind IN ('grant','deny','review_step','access_log')),

  document_id     UUID REFERENCES documents (id) ON DELETE RESTRICT,
  folder_id       UUID REFERENCES doc_folders (id),

  principal_kind  TEXT CHECK (principal_kind IN ('user','role','capability','group')),
  principal_id    TEXT,
  capability      TEXT,
  scope           TEXT CHECK (scope IN ('own','assigned','team','all')),

  step_index      INTEGER,
  step_state      TEXT CHECK (step_state IN ('pending','approved','rejected','skipped')),

  action          TEXT CHECK (action IN ('view','download','print','export','approve','reject')),
  actor_user_id   UUID REFERENCES users (id),
  actor_label     TEXT,
  occurred_at     TIMESTAMPTZ,
  ip              INET,
  request_id      TEXT,

  reason          TEXT,
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      UUID REFERENCES users (id),
  deleted_at      TIMESTAMPTZ,

  CONSTRAINT document_access_target
    CHECK (document_id IS NOT NULL OR folder_id IS NOT NULL),
  CONSTRAINT document_access_rule_shape
    CHECK (entry_kind NOT IN ('grant','deny')
           OR (principal_kind IS NOT NULL AND principal_id IS NOT NULL)),
  CONSTRAINT document_access_step_shape
    CHECK (entry_kind <> 'review_step'
           OR (step_index IS NOT NULL AND step_state IS NOT NULL AND capability IS NOT NULL)),
  CONSTRAINT document_access_log_shape
    CHECK (entry_kind <> 'access_log'
           OR (action IS NOT NULL AND occurred_at IS NOT NULL AND actor_label IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS document_access_step_uk
  ON document_access (document_id, step_index)
  WHERE entry_kind = 'review_step' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS document_access_document_idx
  ON document_access (document_id, entry_kind) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS document_access_log_idx
  ON document_access (occurred_at DESC) WHERE entry_kind = 'access_log';

COMMENT ON TABLE  document_access IS
  'Four entry kinds in one table: explicit grants, explicit denials, ordered review-chain steps, '
  'and the read log for medical, certificate and restricted documents. Scope resolution itself is '
  'the platform resolver; these rows are the document-specific overlay, and the review chain is '
  'data rather than code for the same reason QMS approvals are.';
COMMENT ON COLUMN document_access.entry_kind IS
  'grant | deny | review_step | access_log. Deny always wins over grant. A shape CHECK per kind '
  'keeps the unused columns honest.';
COMMENT ON COLUMN document_access.action IS
  'For access_log rows. Export and download are separate capabilities from view, with no own '
  'carve-out: reading on screen never implies the right to take a copy.';
COMMENT ON COLUMN document_access.expires_at IS
  'Time-boxed grants. An expired grant is inert but retained as evidence of what was permitted.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE UPDATE, DELETE ON document_access FROM tms_app';
    EXECUTE 'GRANT UPDATE (step_state, reason, deleted_at) ON document_access TO tms_app';
  END IF;
END
$$;
