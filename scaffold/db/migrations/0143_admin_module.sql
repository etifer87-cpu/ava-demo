-- 0143 - the administration module: head of training, training manager's admin reach, tech tickets.
--
-- 1. head_of_training: a training_manager who also owns governance - accounts, roles, audit,
--    settings, tickets. training_manager relabelled "Training Manager" (code unchanged) and given
--    audit view + ticket triage so the admin area reads the same for both.
-- 2. platform.tickets.create: any signed-in role may report a problem. Granted to every role,
--    including trainee (own), because a report nobody can file is a defect nobody hears about.
-- 3. tech_tickets + tech_ticket_events: the tech log. Tickets are never deleted; they close.
--    Events are append-only and carry the status change they caused, so the history of a ticket
--    is the events, not a mutable column.
-- Forward-only, idempotent.

INSERT INTO roles (code, name, module, description, position) VALUES
 ('head_of_training', 'Head of Training', 'training',
  'Owns the training programme and its governance: everything the training manager holds, plus accounts, role grants, audit, settings and the tech log.', 15)
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, position = EXCLUDED.position;

UPDATE roles SET name = 'Training Manager' WHERE code = 'training_manager';

INSERT INTO capabilities (code, module, resource, action, is_scoped, is_overridable, description) VALUES
 ('platform.tickets.create', 'platform', 'tickets', 'create', false, true, 'File a tech-log ticket (report a problem with the application)')
ON CONFLICT (code) DO NOTHING;

-- operator_admin holds everything: pick up the new capability too.
INSERT INTO role_capabilities (role_code, capability_code, scope)
SELECT 'operator_admin', code, 'all' FROM capabilities
ON CONFLICT DO NOTHING;

-- head_of_training = training_manager's matrix + governance.
INSERT INTO role_capabilities (role_code, capability_code, scope)
SELECT 'head_of_training', capability_code, scope FROM role_capabilities WHERE role_code = 'training_manager'
ON CONFLICT DO NOTHING;
INSERT INTO role_capabilities (role_code, capability_code, scope) VALUES
 ('head_of_training', 'platform.users.manage',    'all'),
 ('head_of_training', 'platform.roles.assign',    'all'),
 ('head_of_training', 'platform.audit.view',      'all'),
 ('head_of_training', 'platform.settings.manage', 'all'),
 ('head_of_training', 'platform.tickets.triage',  'all'),
 ('training_manager', 'platform.audit.view',      'all'),
 ('training_manager', 'platform.tickets.triage',  'all')
ON CONFLICT DO NOTHING;

-- Everyone may report a problem.
INSERT INTO role_capabilities (role_code, capability_code, scope)
SELECT code, 'platform.tickets.create', 'own' FROM roles
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Tech log
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tech_tickets (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number           BIGINT GENERATED ALWAYS AS IDENTITY,          -- human reference, T-000123
  subject          TEXT        NOT NULL CHECK (length(subject) BETWEEN 3 AND 200),
  description      TEXT        NOT NULL CHECK (length(description) BETWEEN 3 AND 8000),
  category         TEXT        NOT NULL DEFAULT 'bug'
                               CHECK (category IN ('bug','data','access','request','question','other')),
  priority         TEXT        NOT NULL DEFAULT 'medium'
                               CHECK (priority IN ('low','medium','high','critical')),
  status           TEXT        NOT NULL DEFAULT 'open'
                               CHECK (status IN ('open','in_progress','resolved','wont_fix')),
  route            TEXT,                                          -- the page the reporter was on
  reporter_user_id UUID        REFERENCES users(id),
  reporter_label   TEXT        NOT NULL,                          -- survives the account
  assignee_user_id UUID        REFERENCES users(id),
  due_on           DATE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_event_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tech_tickets_status ON tech_tickets (status, priority, created_at DESC);
CREATE INDEX IF NOT EXISTS tech_tickets_reporter ON tech_tickets (reporter_user_id, created_at DESC);

DROP TRIGGER IF EXISTS tech_tickets_updated_at ON tech_tickets;
CREATE TRIGGER tech_tickets_updated_at BEFORE UPDATE ON tech_tickets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS tech_tickets_no_hard_delete ON tech_tickets;
CREATE TRIGGER tech_tickets_no_hard_delete BEFORE DELETE ON tech_tickets
  FOR EACH ROW EXECUTE FUNCTION deny_hard_delete();

COMMENT ON TABLE tech_tickets IS 'Tech log: problems and requests reported by users about the application. Never deleted; status moves to resolved or wont_fix. History lives in tech_ticket_events.';

CREATE TABLE IF NOT EXISTS tech_ticket_events (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id        UUID        NOT NULL REFERENCES tech_tickets(id),
  occurred_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_user_id    UUID        REFERENCES users(id),
  actor_label      TEXT        NOT NULL,
  kind             TEXT        NOT NULL CHECK (kind IN ('created','comment','status','priority','assigned','due')),
  status_from      TEXT,
  status_to        TEXT,
  note             TEXT
);
CREATE INDEX IF NOT EXISTS tech_ticket_events_ticket ON tech_ticket_events (ticket_id, occurred_at);

DROP TRIGGER IF EXISTS tech_ticket_events_immutable ON tech_ticket_events;
CREATE TRIGGER tech_ticket_events_immutable BEFORE UPDATE OR DELETE ON tech_ticket_events
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

COMMENT ON TABLE tech_ticket_events IS 'Append-only timeline of a tech ticket: creation, comments, status/priority/assignment/due changes, each with who and when.';

DO $$
DECLARE r INT; c INT;
BEGIN
  SELECT count(*) INTO r FROM roles;
  SELECT count(*) INTO c FROM capabilities;
  RAISE NOTICE '0143: admin module in place - % roles, % capabilities, tech_tickets + tech_ticket_events created', r, c;
END $$;
