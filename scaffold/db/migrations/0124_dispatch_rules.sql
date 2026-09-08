-- 0124_dispatch_rules.sql
-- Dispatch: which events raise a notice, at what severity, to whom.
-- See docs/10_INTEGRATION.md section 3.8.

CREATE TABLE IF NOT EXISTS dispatch_rules (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code              TEXT NOT NULL CHECK (code ~ '^[a-z0-9_]{2,64}$'),
  label             TEXT NOT NULL,
  description       TEXT,

  event_kind        TEXT NOT NULL CHECK (event_kind IN (
                      'qual_warning','qual_grace','qual_expired','qual_missing',
                      'qual_grant_available','qual_waived',
                      'doc_expiring','doc_expired','doc_pending_review','doc_unrouted',
                      'record_fail','record_not_completed','record_no_show','record_unsigned',
                      'progression_at_risk','progression_blocked','milestone_overdue',
                      'eligibility_reached','attestation_stale',
                      'sync_error','reconciliation_mismatch','quality_review')),
  severity          TEXT NOT NULL DEFAULT 'info'
                      CHECK (severity IN ('hard','soft','consent','info')),

  audience_capability TEXT NOT NULL,
  audience_scope    TEXT NOT NULL DEFAULT 'all'
                      CHECK (audience_scope IN ('own','assigned','team','all')),
  notify_subject    BOOLEAN NOT NULL DEFAULT FALSE,
  channels          TEXT[] NOT NULL DEFAULT '{in_app}',

  lead_days         INTEGER CHECK (lead_days IS NULL OR lead_days >= 0),
  repeat_days       INTEGER CHECK (repeat_days IS NULL OR repeat_days >= 1),
  org_unit_id       UUID REFERENCES org_units (id),
  asset_class_id    UUID REFERENCES asset_classes (id),
  attestation_key   TEXT,

  is_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  template_key      TEXT,
  sort_order        INTEGER NOT NULL DEFAULT 100,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        UUID REFERENCES users (id),
  deleted_at        TIMESTAMPTZ,

  -- Consent severity is meaningless without the attestation it waits for.
  CONSTRAINT dispatch_rules_consent_needs_key
    CHECK (severity <> 'consent' OR attestation_key IS NOT NULL),
  CONSTRAINT dispatch_rules_channels_nonempty
    CHECK (array_length(channels, 1) IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS dispatch_rules_code_uk
  ON dispatch_rules (code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS dispatch_rules_event_idx
  ON dispatch_rules (event_kind, severity) WHERE deleted_at IS NULL;

COMMENT ON TABLE  dispatch_rules IS
  'Notification and blocking rules as configuration. Adding a rule is an INSERT. Audience is named '
  'by capability and scope rather than by role list, so a permission change does not silently '
  'orphan an alert.';
COMMENT ON COLUMN dispatch_rules.severity IS
  'hard blocks the action; soft warns, allows and records a reason; consent blocks until a live '
  'attestation exists - neither soft (publishing past it silently would be wrong) nor hard (it is '
  'permitted with agreement); info never blocks.';
COMMENT ON COLUMN dispatch_rules.is_enabled IS
  'A DISABLED RULE IS STILL COMPUTED AND STILL DISPLAYED AS INFORMATION. It simply stops blocking. '
  'That is how a not-yet-mandatory minimum stays visible and accrues evidence before it becomes '
  'binding, and it is the single most useful behaviour in this table.';
COMMENT ON COLUMN dispatch_rules.channels IS
  'in_app is built. Outbound channels (mail, calendar feed) are deliberately deferred behind the '
  'same delivery record, so enabling one is configuration rather than a new mechanism.';
