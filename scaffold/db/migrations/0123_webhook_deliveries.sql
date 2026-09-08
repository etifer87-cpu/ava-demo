-- 0123_webhook_deliveries.sql
-- Integration: one row per event per subscription. A notification, never the system of record.
-- See docs/10_INTEGRATION.md section 3.7.

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id        UUID REFERENCES api_keys (id),
  endpoint          TEXT NOT NULL,

  event             TEXT NOT NULL CHECK (event IN (
                      'record.signed','record.unsigned','record.finalized',
                      'qualification.alert_raised','qualification.granted',
                      'qualification.expiring','qualification.expired',
                      'document.approved','document.expiring',
                      'sync.failed','test.ping')),
  event_id          TEXT NOT NULL,
  payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
  signature_alg     TEXT NOT NULL DEFAULT 'hmac-sha256',

  state             TEXT NOT NULL DEFAULT 'queued'
                      CHECK (state IN ('queued','delivering','delivered','failed','dead')),
  attempts          INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts      INTEGER NOT NULL DEFAULT 8 CHECK (max_attempts >= 1),
  queued_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  next_attempt_at   TIMESTAMPTZ,
  delivered_at      TIMESTAMPTZ,
  failed_at         TIMESTAMPTZ,
  response_status   INTEGER,
  error             TEXT,
  deleted_at        TIMESTAMPTZ,

  CONSTRAINT webhook_deliveries_delivered_complete
    CHECK (state <> 'delivered' OR delivered_at IS NOT NULL),
  CONSTRAINT webhook_deliveries_dead_complete
    CHECK (state <> 'dead' OR (failed_at IS NOT NULL AND error IS NOT NULL)),
  CONSTRAINT webhook_deliveries_attempts_bounded
    CHECK (attempts <= max_attempts)
);

-- One delivery per event per subscription. Retries increment attempts on this row; they never
-- insert a second one, or a consumer that deduplicates on event_id still sees a storm.
CREATE UNIQUE INDEX IF NOT EXISTS webhook_deliveries_event_uk
  ON webhook_deliveries (api_key_id, event_id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS webhook_deliveries_due_idx
  ON webhook_deliveries (next_attempt_at)
  WHERE state IN ('queued','failed') AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS webhook_deliveries_dead_idx
  ON webhook_deliveries (failed_at DESC) WHERE state = 'dead';

COMMENT ON TABLE  webhook_deliveries IS
  'Outbound event notifications with their full delivery record. Payloads carry ids only - never a '
  'document body, a narrative or a grade. Webhooks notify; the outward API with updated_since is '
  'the source of truth, and that is stated in the consumer documentation so a missed delivery '
  'during an outage is recoverable rather than permanent.';
COMMENT ON COLUMN webhook_deliveries.event_id IS
  'Stable across every retry. Consumers deduplicate on it; the unique index makes it stable on '
  'this side too.';
COMMENT ON COLUMN webhook_deliveries.delivered_at IS
  'Null with queued_at set is the queued state. That single nullable timestamp is the whole '
  'delivery record and is the pattern reused by dispatch_notices.';
COMMENT ON COLUMN webhook_deliveries.signature_alg IS
  'The body is signed with the subscription secret, with the timestamp inside the signed string so '
  'a captured delivery cannot be replayed.';
