-- 0002_common_functions.sql
-- Core platform. Trigger functions shared by every later migration.

-- Maintains updated_at. The application never sets it; a row that is written twice in the same
-- millisecond still gets a monotonic value from the transaction clock.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Attached to append-only tables. Append-only by convention is not append-only: the first
-- data-fix script to touch the table removes the evidence it was there to preserve.
CREATE OR REPLACE FUNCTION deny_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only (attempted %)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END $$;

-- Attached where a hard DELETE is always a mistake. Deletion in this platform is
-- UPDATE ... SET deleted_at = now(), plus an audit_log row.
CREATE OR REPLACE FUNCTION deny_hard_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is soft-delete only; set deleted_at instead', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END $$;

COMMENT ON FUNCTION set_updated_at() IS 'BEFORE UPDATE trigger: maintains updated_at.';
COMMENT ON FUNCTION deny_mutation() IS 'BEFORE UPDATE OR DELETE trigger: enforces append-only tables.';
COMMENT ON FUNCTION deny_hard_delete() IS 'BEFORE DELETE trigger: enforces soft-delete-only tables.';
