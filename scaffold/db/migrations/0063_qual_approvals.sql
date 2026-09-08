-- 0063_qual_approvals.sql
-- QMS: the grant workflow instance. The engine may open one; only a human may decide one.
-- See docs/08_QMS.md section 7.

CREATE TABLE IF NOT EXISTS qual_approvals (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id            UUID NOT NULL REFERENCES people (id) ON DELETE RESTRICT,
  qual_type_code        TEXT NOT NULL REFERENCES qual_types (code) ON DELETE RESTRICT,
  qual_type_version_id  UUID NOT NULL REFERENCES qual_type_versions (id),
  qualification_id      UUID REFERENCES qualifications (id),

  mode                  TEXT NOT NULL DEFAULT 'single'
                          CHECK (mode IN ('single','two_step','waiver')),
  state                 TEXT NOT NULL DEFAULT 'open'
                          CHECK (state IN ('open','granted','rejected','waived','withdrawn')),

  evaluation            JSONB NOT NULL DEFAULT '{}'::jsonb,
  evaluated_as_of       DATE,
  rules_met             BOOLEAN NOT NULL DEFAULT FALSE,
  met_at                DATE,

  raised_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  raised_by             UUID REFERENCES users (id),

  first_approved_at     TIMESTAMPTZ,
  first_approved_by     UUID REFERENCES users (id),
  decided_at            TIMESTAMPTZ,
  decided_by            UUID REFERENCES users (id),
  decision_reason       TEXT,
  capability_used       TEXT,
  reauthenticated       BOOLEAN NOT NULL DEFAULT FALSE,

  proposed_valid_from   DATE,
  proposed_valid_until  DATE,
  unmet_at_decision     JSONB NOT NULL DEFAULT '[]'::jsonb,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at            TIMESTAMPTZ,

  CONSTRAINT qual_approvals_decided_complete
    CHECK (state = 'open'
           OR (decided_at IS NOT NULL AND decided_by IS NOT NULL)),
  -- The second approver must not be the first. Two-step approval by one person is one step.
  CONSTRAINT qual_approvals_two_step_distinct
    CHECK (mode <> 'two_step'
           OR state = 'open'
           OR (first_approved_by IS NOT NULL AND first_approved_by <> decided_by)),
  -- A waiver is a grant against unmet rules. It always carries a reason and what was unmet.
  CONSTRAINT qual_approvals_waiver_reason
    CHECK (state <> 'waived'
           OR (decision_reason IS NOT NULL AND jsonb_array_length(unmet_at_decision) > 0)),
  CONSTRAINT qual_approvals_reject_reason
    CHECK (state <> 'rejected' OR decision_reason IS NOT NULL)
);

-- One open approval per subject per type. Without this, two evaluation runs raise two alerts and
-- the same qualification is granted twice with different dates.
CREATE UNIQUE INDEX IF NOT EXISTS qual_approvals_one_open_uk
  ON qual_approvals (subject_id, qual_type_code)
  WHERE state = 'open' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS qual_approvals_queue_idx
  ON qual_approvals (raised_at)
  WHERE state = 'open' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS qual_approvals_subject_idx
  ON qual_approvals (subject_id, qual_type_code) WHERE deleted_at IS NULL;

COMMENT ON TABLE  qual_approvals IS
  'One row per grant workflow instance. The evaluation engine may only ever insert a row in state '
  'open; the transition to granted, rejected or waived is a human act carrying a capability, a '
  'password re-authentication and, where required, a reason. This table is the answer to the audit '
  'question "who is accountable for this qualification".';
COMMENT ON COLUMN qual_approvals.evaluation IS
  'Frozen snapshot of what the engine saw when the alert was raised: per condition met/unmet, '
  'met_at, evidence references, constraint results. The approver decides against this picture and '
  'an auditor later sees the same one.';
COMMENT ON COLUMN qual_approvals.mode IS
  'single | two_step | waiver. Copied from the definition at raise time so a later republish does '
  'not change the rules of an approval already in flight.';
COMMENT ON COLUMN qual_approvals.unmet_at_decision IS
  'For a waiver: the condition keys that were not met when the grant was made. Waivers are '
  'reported separately from compliant grants in every compliance figure; a waiver invisible in '
  'reporting is worse than no waiver mechanism.';
COMMENT ON COLUMN qual_approvals.reauthenticated IS
  'True when the deciding user re-entered their own password, verified server-side against their '
  'own hash. Fail-closed: a decision without it is refused, not recorded.';
