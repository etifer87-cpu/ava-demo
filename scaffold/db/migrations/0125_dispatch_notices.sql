-- 0125_dispatch_notices.sql
-- Dispatch: one addressed instance of a rule, with its delivery record.
-- See docs/10_INTEGRATION.md section 3.8.

CREATE TABLE IF NOT EXISTS dispatch_notices (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id           UUID REFERENCES dispatch_rules (id),
  event_kind        TEXT NOT NULL,
  severity          TEXT NOT NULL DEFAULT 'info'
                      CHECK (severity IN ('hard','soft','consent','info')),

  subject_id        UUID REFERENCES people (id),
  recipient_person_id UUID REFERENCES people (id),
  recipient_user_id UUID REFERENCES users (id),
  org_unit_id       UUID REFERENCES org_units (id),

  target_kind       TEXT,
  target_id         TEXT,
  dedup_key         TEXT NOT NULL,
  title             TEXT NOT NULL,
  body              TEXT,
  payload           JSONB NOT NULL DEFAULT '{}'::jsonb,

  channel           TEXT NOT NULL DEFAULT 'in_app',
  state             TEXT NOT NULL DEFAULT 'queued'
                      CHECK (state IN ('queued','delivered','read','failed','superseded','cleared')),
  attempts          INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  queued_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at      TIMESTAMPTZ,
  read_at           TIMESTAMPTZ,
  failed_at         TIMESTAMPTZ,
  error             TEXT,
  cleared_at        TIMESTAMPTZ,
  cleared_reason    TEXT,
  deleted_at        TIMESTAMPTZ,

  CONSTRAINT dispatch_notices_has_recipient
    CHECK (recipient_person_id IS NOT NULL OR recipient_user_id IS NOT NULL),
  CONSTRAINT dispatch_notices_delivered_complete
    CHECK (state NOT IN ('delivered','read') OR delivered_at IS NOT NULL),
  CONSTRAINT dispatch_notices_failed_complete
    CHECK (state <> 'failed' OR (failed_at IS NOT NULL AND error IS NOT NULL)),
  CONSTRAINT dispatch_notices_cleared_complete
    CHECK (state <> 'cleared' OR (cleared_at IS NOT NULL AND cleared_reason IS NOT NULL))
);

-- One live notice per dedup key per recipient. Re-running the evaluation must not produce a
-- second copy of the same warning every night.
CREATE UNIQUE INDEX IF NOT EXISTS dispatch_notices_live_uk
  ON dispatch_notices (dedup_key,
                       COALESCE(recipient_person_id, '00000000-0000-0000-0000-000000000000'::uuid),
                       COALESCE(recipient_user_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE state IN ('queued','delivered','read') AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS dispatch_notices_inbox_idx
  ON dispatch_notices (recipient_person_id, queued_at DESC)
  WHERE state IN ('queued','delivered') AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS dispatch_notices_subject_idx
  ON dispatch_notices (subject_id, event_kind) WHERE deleted_at IS NULL;

COMMENT ON TABLE  dispatch_notices IS
  'One addressed instance of a dispatch rule. A notice is stored for its addressee WHETHER OR NOT '
  'that person has a login yet - recipient_person_id is the durable address and recipient_user_id '
  'is filled in when an account exists, so nothing is lost when accounts are provisioned later.';
COMMENT ON COLUMN dispatch_notices.dedup_key IS
  'Stable identity of the condition being reported, typically event kind plus target plus the '
  'window it belongs to. The partial unique index turns a nightly re-evaluation into an update '
  'rather than a duplicate.';
COMMENT ON COLUMN dispatch_notices.state IS
  'queued | delivered | read | failed | superseded | cleared. Cleared carries a reason: an alert '
  'that disappears without one cannot be reconciled against the condition that raised it.';
COMMENT ON COLUMN dispatch_notices.severity IS
  'Copied from the rule at raise time so that later re-tuning a rule does not rewrite the history '
  'of what was blocking at the time.';
