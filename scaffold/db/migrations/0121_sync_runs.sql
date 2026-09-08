-- 0121_sync_runs.sql
-- Integration: one row per execution of any feed, and the home of the cursor.
-- See docs/10_INTEGRATION.md section 2.

CREATE TABLE IF NOT EXISTS sync_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  interface       TEXT NOT NULL CHECK (interface ~ '^[a-z0-9_]{2,60}$'),
  direction       TEXT NOT NULL CHECK (direction IN ('inbound','outbound','bidirectional')),
  trigger_kind    TEXT NOT NULL DEFAULT 'scheduled'
                    CHECK (trigger_kind IN ('scheduled','manual','backfill','retry','webhook')),

  state           TEXT NOT NULL DEFAULT 'running'
                    CHECK (state IN ('running','succeeded','failed','partial','cancelled')),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,

  cursor_before   TEXT,
  cursor_after    TEXT,
  window_from     TIMESTAMPTZ,
  window_to       TIMESTAMPTZ,

  fetched_count   INTEGER NOT NULL DEFAULT 0 CHECK (fetched_count >= 0),
  created_count   INTEGER NOT NULL DEFAULT 0 CHECK (created_count >= 0),
  updated_count   INTEGER NOT NULL DEFAULT 0 CHECK (updated_count >= 0),
  held_count      INTEGER NOT NULL DEFAULT 0 CHECK (held_count >= 0),
  skipped_count   INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  failed_count    INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  page_count      INTEGER NOT NULL DEFAULT 0 CHECK (page_count >= 0),

  error           TEXT,
  held_reasons    JSONB NOT NULL DEFAULT '[]'::jsonb,
  params          JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_by      UUID REFERENCES users (id),
  deleted_at      TIMESTAMPTZ,

  CONSTRAINT sync_runs_finished_state
    CHECK (state = 'running' OR finished_at IS NOT NULL),
  CONSTRAINT sync_runs_failed_has_error
    CHECK (state <> 'failed' OR error IS NOT NULL),
  -- The cursor advances only on a successful load. A failed run must leave it where it was.
  CONSTRAINT sync_runs_cursor_only_on_success
    CHECK (state IN ('succeeded','partial','running')
           OR cursor_after IS NULL
           OR cursor_after IS NOT DISTINCT FROM cursor_before)
);

CREATE INDEX IF NOT EXISTS sync_runs_interface_idx
  ON sync_runs (interface, started_at DESC);
CREATE INDEX IF NOT EXISTS sync_runs_failed_idx
  ON sync_runs (started_at DESC) WHERE state IN ('failed','partial');

COMMENT ON TABLE  sync_runs IS
  'One row per feed execution, and the authoritative home of the feed cursor. A cursor kept in a '
  'file inside a container is reset by a redeploy, after which the feed either re-fetches the whole '
  'backlog or skips a window - both silently. Keeping it here makes the position durable and '
  'inspectable.';
COMMENT ON COLUMN sync_runs.cursor_after IS
  'Advanced only after the load completed successfully. The CHECK prevents a failed run from '
  'recording forward progress it did not make.';
COMMENT ON COLUMN sync_runs.held_count IS
  'Records deliberately not imported and logged with a reason: subject and assessor the same '
  'person, or a record with no task grades, no competency grades and no narrative. That filter '
  'removes test rows while still admitting narrative-only records, which are real.';
COMMENT ON COLUMN sync_runs.page_count IS
  'Pages actually read. Compared against the processed count to catch a server-side row cap that '
  'ignored the requested limit and returned a partial list with no error.';
