-- 0141 - operator template kinds (Avianca context, policy.yaml v1.2).
--
-- policy.yaml section 1 and the template_kinds catalogue MUST AGREE (0032). The operator is on
-- EBT: an EBT recurrent module is its own kind, not a flavour of "simulator, recurrent", and a type
-- rating course is graded in the simulator with repeatable attempts. OPC / LPC stays as the label
-- of proficiency_check. Forward-only, idempotent, no rows removed: retiring a kind is is_active =
-- false, never a DELETE.

INSERT INTO template_kinds
  (code, label, facility_kind, fan_out_on_signature, supports_attempts,
   one_record_per_sector, hide_record_from_subject, position, is_active, note)
VALUES
  ('ebt_recurrent', 'EBT recurrent module', 'ffs', false, true, false, false, 0, true,
     'Evaluation, Manoeuvres and Scenario phases are sections of the template, not kinds.'),
  ('type_rating',   'Type rating',          'ffs', false, true, false, false, 13, true, NULL)
ON CONFLICT (code) DO UPDATE
  SET label = EXCLUDED.label, facility_kind = EXCLUDED.facility_kind, is_active = true;

UPDATE template_kinds SET label = 'OPC / LPC' WHERE code = 'proficiency_check';

DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM template_kinds WHERE is_active;
  RAISE NOTICE '0141: template_kinds now carries % active codes (ebt_recurrent, type_rating added; proficiency_check relabelled OPC / LPC)', n;
END $$;
