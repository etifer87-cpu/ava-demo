-- 0119_av_currency.sql
-- Analytics layer, part 20 of 20. docs/06_ANALYTICS.md §12.
-- Currency and expiry inputs.
--
-- The STATUS ITSELF IS NOT COMPUTED HERE. It is derived on read by
-- lib/analytics/currency.ts from an injected asOf, because a status stored (or
-- frozen into a view built on CURRENT_DATE) is wrong the day after it is
-- written and cannot be reproduced for an as-at report. This view supplies the
-- dates and the per-type policy the function needs.

CREATE OR REPLACE VIEW av_qual_policy AS
SELECT qt.code                                        AS qual_type_code,
       qt.name,
       qt.category,
       qt.is_active,
       qtv.id                                         AS qual_type_version_id,
       (qtv.definition ->> 'validity_months')::INT    AS validity_months,
       COALESCE((qtv.definition ->> 'warning_days')::INT,
                analytics_int('currency.default_warning_days'))       AS warning_days,
       COALESCE((qtv.definition ->> 'grace_days')::INT,
                analytics_int('currency.default_grace_days'))         AS grace_days,
       COALESCE((qtv.definition ->> 'early_renewal_days')::INT,
                analytics_int('currency.default_early_renewal_days')) AS early_renewal_days,
       COALESCE(qtv.definition -> 'requires', '[]'::JSONB)            AS requires,
       COALESCE(qtv.definition ->> 'source', 'document')              AS evidence_source,
       (qtv.definition ->> 'validity_months' IS NULL)                 AS is_one_time
FROM qual_types qt
LEFT JOIN qual_type_versions qtv
       ON qtv.qual_type_code = qt.code
      AND qtv.status = 'published'
      AND qtv.deleted_at IS NULL
WHERE qt.deleted_at IS NULL;

COMMENT ON VIEW av_qual_policy IS
  'One row per qualification type with its published version''s validity policy. Per-type values win; '
  'where a type leaves a field null the default from currency.* in analytics_config fills in, so a '
  'policy gap is a stated default rather than an implicit zero. is_one_time is derived from the '
  'absence of validity_months rather than from a separate flag that could contradict it.';

-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW av_qualification_input AS
SELECT q.id                          AS qualification_id,
       q.subject_id,
       q.qual_type_code,
       p.name                        AS qual_type_name,
       p.category,
       q.org_unit_id,
       q.asset_class_id,
       q.valid_from,
       q.anchor_date,
       -- computeValidUntil: an interval type derives its expiry from the anchor
       -- date; a date-driven type stores it; a one-time type has none.
       CASE
         WHEN p.is_one_time THEN NULL
         WHEN p.validity_months IS NOT NULL AND q.anchor_date IS NOT NULL
           THEN (q.anchor_date + (p.validity_months || ' months')::INTERVAL)::DATE
         ELSE q.valid_until
       END                           AS valid_until,
       q.valid_until                 AS stored_valid_until,
       q.status_override,
       p.validity_months,
       p.warning_days,
       p.grace_days,
       p.early_renewal_days,
       p.is_one_time,
       q.source,
       (q.superseded_at IS NOT NULL) AS is_superseded
FROM qualifications q
JOIN av_qual_policy p ON p.qual_type_code = q.qual_type_code
WHERE q.deleted_at IS NULL;

COMMENT ON VIEW av_qualification_input IS
  'One row per live qualification with its computed expiry date and the policy fields the status '
  'function needs. valid_until is COMPUTED for interval types from the anchor date rather than trusted '
  'from storage, so a stale stored value cannot make an expired qualification read as valid; the '
  'stored value is kept alongside as stored_valid_until so a mismatch is visible rather than silently '
  'overwritten. No status is assigned here: deriveStatus runs in lib/analytics/currency.ts against an '
  'injected asOf, which is what makes an as-at compliance report reproducible.';

-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW av_qualification_plan AS
SELECT qa.subject_id,
       qa.qual_type_code,
       qa.qualification_id,
       min(qa.raised_at)::DATE                    AS opened_on,
       min(qa.evaluated_as_of)                    AS evaluated_as_of,
       bool_or(qa.rules_met)                      AS rules_met,
       true                                       AS has_open_approval
FROM qual_approvals qa
WHERE qa.state = 'open'
GROUP BY qa.subject_id, qa.qual_type_code, qa.qualification_id;

COMMENT ON VIEW av_qualification_plan IS
  'One row per (subject, qualification type) with an OPEN approval in flight - the platform''s only '
  'evidence that a renewal is actually planned. PLANNED is a distinct state from VALID and from DUE: '
  'currency.planned_excluded_from_due keeps a planned renewal out of the due-soon count, so a '
  'well-managed renewal does not read as an overdue one. Whether PLANNED counts toward compliance is '
  'a config choice (currency.compliant_statuses), because operators genuinely disagree about it.';
