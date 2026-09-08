-- 0142 - fleet-bound grants, the operator administrator and the fleet manager.
--
-- A role grant may now be bound to an ASSET CLASS (fleet) exactly as it may be bound to an org
-- unit: user_roles.asset_class_id, NULL = every fleet. The resolver (lib/access.ts) intersects each
-- scope's member set with the people currently on the bound fleets, so an instructor granted
-- `instructor` bound to A320 cannot reach an A330 record through any screen, and a dual-rated
-- instructor holds two grant rows. Roles stay generic; the binding carries the fleet.
--
-- Also: `operator_admin`, holding every capability at `all` (the kit ships no such role, on
-- purpose; the operator's own administrator needs one), and `fleet_manager`, read-only across
-- training evidence, meant to be granted fleet-bound. Role labels moved to the operator's titles.
-- Forward-only, idempotent.

ALTER TABLE user_roles ADD COLUMN IF NOT EXISTS asset_class_id UUID REFERENCES asset_classes(id);
COMMENT ON COLUMN user_roles.asset_class_id IS
  'Fleet the grant is bound to; NULL = every fleet. Intersected with the scope member set by lib/access.ts.';

-- Uniqueness must now include the fleet, or the same role could not be granted for two fleets.
DROP INDEX IF EXISTS user_roles_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS user_roles_uniq
  ON user_roles (user_id, role_code,
                 COALESCE(org_unit_id,    '00000000-0000-0000-0000-000000000000'::uuid),
                 COALESCE(asset_class_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX IF NOT EXISTS user_roles_asset_class ON user_roles (asset_class_id) WHERE asset_class_id IS NOT NULL;

INSERT INTO roles (code, name, module, description, position) VALUES
 ('operator_admin', 'Avianca administrator', 'platform',
  'Every capability at every scope, unbound. The operator''s own administrator account.', 5),
 ('fleet_manager',  'Fleet manager',         'training',
  'Read-only across records, sessions, analytics and qualifications for the fleet the grant is bound to. Never grades, never configures.', 25)
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, position = EXCLUDED.position;

-- operator_admin: everything, at 'all'. Includes non-overridable capabilities on purpose: this
-- role IS part of the published matrix, which is what the hard-gate rule requires.
INSERT INTO role_capabilities (role_code, capability_code, scope)
SELECT 'operator_admin', code, 'all' FROM capabilities
ON CONFLICT DO NOTHING;

INSERT INTO role_capabilities (role_code, capability_code, scope) VALUES
 ('fleet_manager', 'people.view',                        'all'),
 ('fleet_manager', 'training.templates.view',            'all'),
 ('fleet_manager', 'training.sessions.view',             'all'),
 ('fleet_manager', 'training.records.view',              'all'),
 ('fleet_manager', 'training.analysis.view',             'all'),
 ('fleet_manager', 'training.analytics.programme.view',  'all'),
 ('fleet_manager', 'training.analytics.assessor.view',   'all'),
 ('fleet_manager', 'training.certificates.view',         'all'),
 ('fleet_manager', 'qms.qualifications.view',            'all'),
 ('fleet_manager', 'qms.events.view',                    'all'),
 ('fleet_manager', 'dms.documents.view',                 'all'),
 ('fleet_manager', 'data.export',                        'all')
ON CONFLICT DO NOTHING;

-- Operator titles. Codes are unchanged: routes and guards name codes, people read labels.
UPDATE roles SET name = 'Training Standards Manager'            WHERE code = 'training_manager';
UPDATE roles SET name = 'Standardisation Manager'               WHERE code = 'assessment_manager';
UPDATE roles SET name = 'Examiner (TRE / SFE)'                  WHERE code = 'examiner';
UPDATE roles SET name = 'Instructor (TRI / SFI / LTC)'          WHERE code = 'instructor';
UPDATE roles SET name = 'Ground / CRM instructor (GI / CRMI)'   WHERE code = 'ground_instructor';
UPDATE roles SET name = 'Training records and compliance'       WHERE code = 'qms_admin';
UPDATE roles SET name = 'Auditor (read-only)'                   WHERE code = 'compliance_verifier';
UPDATE roles SET name = 'Pilot'                                 WHERE code = 'trainee';
UPDATE roles SET name = 'Planner (not in scope)', position = 900 WHERE code = 'planner';

DO $$
DECLARE r INT; g INT;
BEGIN
  SELECT count(*) INTO r FROM roles;
  SELECT count(*) INTO g FROM role_capabilities;
  RAISE NOTICE '0142: fleet-bound grants in place; % roles, % grants (operator_admin holds every capability at all)', r, g;
END $$;
