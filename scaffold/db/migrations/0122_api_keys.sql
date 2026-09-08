-- 0122_api_keys.sql
-- Integration: credentials for the outward API, the tablet client and webhook subscriptions.
-- Hash at rest, shown once, always scoped. See docs/10_INTEGRATION.md sections 3.5 to 3.7.

CREATE TABLE IF NOT EXISTS api_keys (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            TEXT NOT NULL CHECK (kind IN ('api','mobile','webhook','internal')),
  label           TEXT NOT NULL,

  key_hash        TEXT NOT NULL CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  key_prefix      TEXT NOT NULL,
  secret_hash     TEXT CHECK (secret_hash IS NULL OR secret_hash ~ '^[0-9a-f]{64}$'),

  owner_user_id   UUID REFERENCES users (id),
  subject_id      UUID REFERENCES people (id),
  org_unit_id     UUID REFERENCES org_units (id),
  capabilities    TEXT[] NOT NULL DEFAULT '{}',
  scope           TEXT NOT NULL DEFAULT 'assigned'
                    CHECK (scope IN ('own','assigned','team','all')),

  issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  issued_by       UUID REFERENCES users (id),
  expires_at      TIMESTAMPTZ NOT NULL,
  last_used_at    TIMESTAMPTZ,
  use_count       BIGINT NOT NULL DEFAULT 0 CHECK (use_count >= 0),

  rotated_to_id   UUID REFERENCES api_keys (id),
  revoked_at      TIMESTAMPTZ,
  revoked_by      UUID REFERENCES users (id),
  revoke_reason   TEXT,
  deleted_at      TIMESTAMPTZ,

  CONSTRAINT api_keys_scoped
    CHECK (kind = 'internal' OR array_length(capabilities, 1) IS NOT NULL),
  CONSTRAINT api_keys_revoked_complete
    CHECK (revoked_at IS NULL OR (revoked_by IS NOT NULL AND revoke_reason IS NOT NULL)),
  CONSTRAINT api_keys_mobile_has_subject
    CHECK (kind <> 'mobile' OR (subject_id IS NOT NULL AND owner_user_id IS NOT NULL)),
  CONSTRAINT api_keys_no_self_rotation
    CHECK (rotated_to_id IS NULL OR rotated_to_id <> id)
);

CREATE UNIQUE INDEX IF NOT EXISTS api_keys_hash_uk ON api_keys (key_hash);
CREATE INDEX IF NOT EXISTS api_keys_live_idx
  ON api_keys (kind, expires_at)
  WHERE revoked_at IS NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS api_keys_owner_idx
  ON api_keys (owner_user_id) WHERE revoked_at IS NULL AND deleted_at IS NULL;

COMMENT ON TABLE  api_keys IS
  'Every credential the platform issues: outward API keys, tablet bearer tokens, webhook signing '
  'subscriptions and the internal automation token. The plaintext is generated from 32 random '
  'bytes, shown once, and never stored - only its SHA-256 hash and a display prefix. A key that '
  'can read everything is a finding, so a capability list is mandatory for every kind but internal.';
COMMENT ON COLUMN api_keys.kind IS
  'api | mobile | webhook | internal. Tablet tokens live here so that revocation, expiry and '
  'rotation are one mechanism rather than three.';
COMMENT ON COLUMN api_keys.rotated_to_id IS
  'Refresh issues the new credential BEFORE revoking the old one and links them here, so a failed '
  'refresh leaves the holder logged in rather than locked out.';
COMMENT ON COLUMN api_keys.expires_at IS
  'Mandatory. A credential with no expiry is a permanent one, and permanent credentials outlive '
  'the reason they were issued.';
