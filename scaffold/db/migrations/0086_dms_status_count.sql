-- 0086_dms_status_count.sql
-- DMS: a status column must never contradict its adjacent count column, in EITHER direction.
-- See docs/09_DMS.md section 8.

CREATE OR REPLACE FUNCTION dms_assert_status_count()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
BEGIN
  -- Direction 1: a clear status while findings are open.
  IF NEW.finding_state = 'clear' AND NEW.open_finding_count > 0 THEN
    RAISE EXCEPTION
      'status_contradicts_count: documents.finding_state=clear with open_finding_count=% (id=%)',
      NEW.open_finding_count, NEW.id
      USING ERRCODE = 'check_violation',
            HINT = 'Recount from the source rows in this transaction; never repair one column by '
                   'trusting the other.';
  END IF;

  -- Direction 2: an open status with nothing actually open.
  IF NEW.finding_state = 'open' AND NEW.open_finding_count = 0 THEN
    RAISE EXCEPTION
      'status_contradicts_count: documents.finding_state=open with open_finding_count=0 (id=%)',
      NEW.id
      USING ERRCODE = 'check_violation',
            HINT = 'Clearing the last finding must set finding_state=clear in the same statement.';
  END IF;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION dms_assert_status_count() IS
  'Enforces the symmetric invariant between a status column and its adjacent count column. '
  'Deliberately a constraint trigger rather than a CHECK: it can be deferred to commit time, it '
  'names the invariant in the error, and the same function is reused for any further status/count '
  'pair introduced later.';

DROP TRIGGER IF EXISTS documents_status_count_trg ON documents;

CREATE CONSTRAINT TRIGGER documents_status_count_trg
  AFTER INSERT OR UPDATE OF finding_state, open_finding_count ON documents
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION dms_assert_status_count();

COMMENT ON TRIGGER documents_status_count_trg ON documents IS
  'Deferred to commit: a transaction that writes the status and the count in two statements '
  'commits; one that leaves them contradicting each other at commit time fails.';
