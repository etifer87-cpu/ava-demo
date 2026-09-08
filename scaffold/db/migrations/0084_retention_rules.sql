-- 0084_retention_rules.sql
-- DMS: retention classes, versioned by effective date. Configuration, never code.
-- See docs/09_DMS.md section 7 and docs/17_GOVERNANCE.md section 4.

CREATE TABLE IF NOT EXISTS retention_rules (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  record_class      TEXT NOT NULL CHECK (record_class IN (
                      'training','competency','medical','licence','certificate',
                      'report','correspondence','submission','audit_log','login_log',
                      'integration_log','user_content','other')),
  org_unit_id       UUID REFERENCES org_units (id),

  basis             TEXT NOT NULL CHECK (basis IN ('issue','expiry','separation','event')),
  min_retain_months INTEGER NOT NULL CHECK (min_retain_months >= 0),
  max_retain_months INTEGER CHECK (max_retain_months IS NULL OR max_retain_months >= 0),
  review_required   BOOLEAN NOT NULL DEFAULT FALSE,
  disposal_method   TEXT NOT NULL DEFAULT 'policy_purge'
                      CHECK (disposal_method IN ('policy_purge','anonymise','retain_indefinitely')),

  legal_ref         TEXT,
  notes             TEXT,
  effective_from    DATE NOT NULL,
  effective_to      DATE,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        UUID REFERENCES users (id),
  deleted_at        TIMESTAMPTZ,

  CONSTRAINT retention_rules_window_order
    CHECK (max_retain_months IS NULL OR max_retain_months >= min_retain_months),
  CONSTRAINT retention_rules_effective_order
    CHECK (effective_to IS NULL OR effective_to > effective_from)
);

-- One rule per class per org unit per effective date.
CREATE UNIQUE INDEX IF NOT EXISTS retention_rules_effective_uk
  ON retention_rules (record_class,
                      COALESCE(org_unit_id, '00000000-0000-0000-0000-000000000000'::uuid),
                      effective_from)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS retention_rules_class_idx
  ON retention_rules (record_class, effective_from DESC) WHERE deleted_at IS NULL;

COMMENT ON TABLE  retention_rules IS
  'Retention classes as configuration: a period, a basis, a disposal method and a free-text legal '
  'reference the operator fills in. No jurisdiction is encoded in the schema, so changing '
  'jurisdiction is never a code change. Rules are versioned by effective_from; documents freeze '
  'retain_until at approval so editing a rule cannot move a historical disposal date.';
COMMENT ON COLUMN retention_rules.basis IS
  'What the clock starts from: issue, expiry, separation (the subject leaving the organisation) or '
  'event. Getting this wrong is the most common retention defect and it is invisible for years.';
COMMENT ON COLUMN retention_rules.record_class IS
  'Includes login_log and user_content deliberately. A login log holds IP addresses and is personal '
  'data; user-submitted content incidentally captures other people. Both need a stated period, and '
  'a missing one is an open compliance gap rather than a neutral default.';
COMMENT ON COLUMN retention_rules.disposal_method IS
  'Physical destruction happens outside the application under this policy. The application only '
  'ever soft-deletes into the retention store; the purge is manual, authorised and audited.';
