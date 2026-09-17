-- 0153_subject_content_hash.sql - the content hash belongs to a pilot, not to a session.
--
-- WHY. `contentDigest(session, person)` hashes ONE pilot's part of a session: their element grades,
-- their competency grades with the behaviours and the proposal they were entered against, their
-- seat, their outcome, their remarks. Two pilots in one simulator session therefore have two
-- different, equally correct digests - they flew different seats and earned different grades.
--
-- The hash was stored on `sessions`, one per session. On the first signature the session kept the
-- digest of whichever pilot was on screen, and the second pilot's signature was then refused by the
-- guard that compares the stored hash with the live one:
--
--     "The content has changed since the first signature."
--
-- Nothing had changed. In a two-pilot session - which is every EBT and OPC/LPC session this
-- operator flies - the second pilot could never sign. It was never seen because the history seeder
-- writes signature rows directly and never calls signSession.
--
-- So the hash moves to `session_subjects`, where the thing it hashes already lives.
--
-- `sessions.content_hash` is LEFT IN PLACE and left written by the assessor's signature. It is now
-- a session-level trace and nothing reads it for a decision; dropping a signed-record column in the
-- same migration that changes how signatures work is two risks where one will do. A later migration
-- removes it once no deployment has rows that predate this one.

ALTER TABLE session_subjects
  ADD COLUMN IF NOT EXISTS content_hash TEXT;

COMMENT ON COLUMN session_subjects.content_hash IS
  'SHA-256 over this pilot''s canonical grading content, stamped when the instructor signs and cleared by an unsign. Both signatures on this pilot''s record attest to it.';

-- Backfill. Only where the session carries exactly ONE assessed subject is the session-level hash
-- unambiguously that subject's own. Where there is more than one, the stored hash belongs to at most
-- one of them and there is no way to tell which, so it is left null: null means "nothing has been
-- attested to yet", which is the safe reading and the one the guard already handles.
UPDATE session_subjects ss
   SET content_hash = s.content_hash
  FROM sessions s
 WHERE s.id = ss.session_id
   AND s.content_hash IS NOT NULL
   AND ss.content_hash IS NULL
   AND (SELECT count(*) FROM session_subjects x WHERE x.session_id = s.id) = 1;
