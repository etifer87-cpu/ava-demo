import 'server-only';
import { createHash } from 'node:crypto';
import { query, queryOne, transaction } from '@/lib/db';
import { can, type ResolvedAccess } from '@/lib/access';
import { judgeStoredOutcome } from './outcome-standard';

/**
 * lib/program/signing.ts - the content hash, the signature, and taking one back. docs/04_ETR.md §5.
 *
 * THE HASH IS THE POINT. policy.yaml's signature statements end with "any later change voids them",
 * and that sentence is worth nothing unless something can tell that a change happened. So a signature
 * here is over a VALUE: a SHA-256 of the canonical grading content of one pilot's part of one session.
 * It is computed on the first signature and stored (migration 0150); every render recomputes it and
 * says so if the two differ. Nothing in this file prevents a change - the lock in
 * lib/program/grading.ts does that - but a lock can be lifted, and after that the hash is the only
 * thing that knows.
 *
 * CANONICAL means the same content always produces the same digest: every list is sorted by a stable
 * key, every object is built literally in a fixed order, and nothing that is not content goes in. In
 * particular the hash does NOT include when a grade was written or by whom, because re-grading the
 * same value at a different minute is not a change to what was signed.
 *
 * WHAT A SIGNATURE IS HERE. There are no certificates in this platform and no drawn squiggles: the
 * signer re-enters THEIR OWN ACCOUNT PASSWORD and confirms the statement. A password is the only
 * secret in this system that belongs to one person - an employee id is on a roster every colleague
 * can read, so typing one proves nothing about who typed it. The password is verified BY POSTGRES
 * with pgcrypto's crypt(), exactly as sign-in does (0006), so no plaintext is compared in the
 * application and nothing is stored or logged.
 *
 * The pilot signs on the instructor's screen at the debrief - and signs as THEMSELVES: their own
 * account is what is verified, and `subject_signer_id` is their own user id, not the device holder's.
 * A pilot with no account cannot do that, so for them the fallback is the employee id typed on the
 * device, and `subject_signature_method` records which of the two actually happened - the weaker
 * assertion is never silently presented as the stronger one. The right fix for that case is an
 * account, not a better fallback.
 *
 * PRODUCTION, NOT DEMO (docs/07_PRODUCTION_GAPS.md). The employee-id fallback exists so a demo can
 * be driven with pilots who have no logins. On a live instance with real training records, EVERY
 * pilot who signs holds an account and every signature is therefore password-verified: an employee
 * id is on a roster that every colleague can read, so a record signed that way cannot be defended if
 * the pilot later says it was not them. Nothing in the code needs to change for that - the method is
 * chosen by whether the person has an account - but the ACCOUNTS have to exist before the first real
 * session, and `subject_signature_method = 'employee_id_on_device'` on a production row is a finding,
 * not a detail. The same file records that this endpoint has no rate limit or lockout of its own.
 *
 * ORDER AND STATE. The assessor signs first (the pilot attests to a completed assessment, not to a
 * draft). The first signature moves the session to `submitted` and locks it; the second to `signed`.
 * A record that the pilot never sees (`hide_record_from_subject`) reaches `signed` on the assessor's
 * signature alone.
 */

export class SignRefused extends Error {}

/** How a party's identity was asserted. Stored per signature, never inferred at read time. */
export type SignMethod = 'password' | 'employee_id';

/**
 * Verifies a password the way sign-in does: in the database, with crypt(). Nothing here ever holds a
 * hash or compares one, and the password reaches no log.
 */
async function passwordOk(userId: string, password: string): Promise<boolean> {
  if (password.length === 0) return false;
  const row = await queryOne<{ ok: boolean }>(
    `SELECT (u.password_hash = crypt($2, u.password_hash)) AS ok
       FROM users u WHERE u.id = $1::uuid AND u.deleted_at IS NULL AND u.is_active`,
    [userId, password],
  );
  return row?.ok === true;
}

/** The live account of one person, when they have one. A pilot often does not. */
async function accountOf(personId: string): Promise<string | null> {
  const row = await queryOne<{ id: string }>(
    `SELECT id::text AS id FROM users WHERE person_id = $1::uuid AND deleted_at IS NULL AND is_active LIMIT 1`,
    [personId],
  );
  return row?.id ?? null;
}

/** Whether this person signs with a password or, having no account, with their employee id. */
export async function signMethodFor(personId: string | null): Promise<SignMethod> {
  if (!personId) return 'employee_id';
  return (await accountOf(personId)) === null ? 'employee_id' : 'password';
}

/* ------------------------------------------------------------------ the hash */

interface HashTask { element_key: string; instance_no: number; attempt: number; grade: string | null; remark: string | null; value_text: string | null }
interface HashComp { code: string; grade: string | null; remark: string | null; proposed_grade: string | null; obs: string[] }

/**
 * The canonical digest of what one pilot was graded in one session.
 *
 * Includes the session's identity (so the same grades in another session are a different document),
 * every attempt of every element, every competency grade with its behaviours and the proposal it was
 * entered against, the outcome and the remarks. Excludes timestamps, ids of rows, and who wrote what.
 */
export async function contentDigest(sessionId: string, personId: string): Promise<string> {
  const [head, tasks, comps] = await Promise.all([
    queryOne<{ session_date: string; facility: string | null; facility_kind: string | null; template_version_id: string; assessor_person_id: string | null; remarks: string | null; seat_role: string | null; outcome: string | null }>(
      `SELECT s.session_date::text AS session_date, s.facility, s.facility_kind,
              s.template_version_id::text AS template_version_id, s.assessor_person_id::text AS assessor_person_id,
              s.remarks, ss.seat_role, ss.outcome
         FROM sessions s LEFT JOIN session_subjects ss ON ss.session_id = s.id AND ss.person_id = $2::uuid
        WHERE s.id = $1::uuid`,
      [sessionId, personId],
    ),
    query<HashTask>(
      `SELECT element_key, instance_no, attempt, grade, remark, value_text
         FROM element_grades WHERE session_id = $1::uuid AND person_id = $2::uuid
        ORDER BY element_key, instance_no, attempt`,
      [sessionId, personId],
    ),
    query<HashComp>(
      `SELECT c.code, cg.grade, cg.remark, cg.proposed_grade,
              COALESCE((SELECT array_agg(ob.code ORDER BY ob.code)
                          FROM competency_grade_obs x JOIN observable_behaviours ob ON ob.id = x.observable_behaviour_id
                         WHERE x.competency_grade_id = cg.id), '{}') AS obs
         FROM competency_grades cg JOIN competencies c ON c.id = cg.competency_id
        WHERE cg.session_id = $1::uuid AND cg.person_id = $2::uuid
        ORDER BY c.code`,
      [sessionId, personId],
    ),
  ]);
  if (!head) throw new SignRefused('not_found');

  const payload = {
    v: 1,
    session: {
      id: sessionId,
      date: head.session_date,
      facility: head.facility ?? null,
      facility_kind: head.facility_kind ?? null,
      template_version_id: head.template_version_id,
      assessor_person_id: head.assessor_person_id ?? null,
      remarks: head.remarks ?? null,
    },
    subject: { person_id: personId, seat_role: head.seat_role ?? null, outcome: head.outcome ?? null },
    tasks: tasks.map((t) => ({
      element_key: t.element_key, instance_no: t.instance_no, attempt: t.attempt,
      grade: t.grade ?? null, remark: t.remark ?? null, answer: t.value_text ?? null,
    })),
    competencies: comps.map((c) => ({
      code: c.code, grade: c.grade ?? null, remark: c.remark ?? null,
      proposed: c.proposed_grade ?? null, obs: [...c.obs].sort(),
    })),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/* ------------------------------------------------------------------ reading the state */

export interface SignatureState {
  /** The hash the signatures attest to, or null before the first one. */
  readonly storedHash: string | null;
  /** The hash of the content as it stands now. */
  readonly liveHash: string;
  /** False when the content has moved since it was signed - the whole reason the hash exists. */
  readonly matches: boolean;
  readonly assessor: { readonly at: string; readonly name: string | null; readonly method: string | null } | null;
  readonly subject: { readonly at: string; readonly method: string | null } | null;
  readonly objection: { readonly at: string; readonly reason: string | null } | null;
  readonly unsigned: { readonly at: string; readonly by: string | null; readonly reason: string | null } | null;
  /** The frozen record, once there is one. */
  readonly recordId: string | null;
  readonly hiddenFromSubject: boolean;
  readonly status: string;
  /** What each party is asked for. `employee_id` only where that person has no account at all. */
  readonly assessorMethod: SignMethod;
  readonly subjectMethod: SignMethod;
}

export async function signatureState(sessionId: string, personId: string): Promise<SignatureState> {
  const row = await queryOne<{
    status: string; content_hash: string | null; assessor_signed_at: string | null; assessor_signature_method: string | null;
    assessor_name: string | null; assessor_person_id: string | null; subject_signed_at: string | null; subject_signature_method: string | null;
    objected_at: string | null; objection_reason: string | null;
    unsigned_at: string | null; unsigned_by: string | null; unsigned_reason: string | null; hide: boolean;
    record_id: string | null;
  }>(
    `SELECT s.status, ss.content_hash, s.assessor_signed_at::text AS assessor_signed_at, s.assessor_signature_method,
            ap.full_name AS assessor_name, s.assessor_person_id::text AS assessor_person_id,
            ss.subject_signed_at::text AS subject_signed_at, ss.subject_signature_method,
            ss.objected_at::text AS objected_at, ss.objection_reason,
            s.unsigned_at::text AS unsigned_at, uu.username AS unsigned_by, s.unsigned_reason,
            COALESCE(v.hide_record_from_subject, false) AS hide,
            (SELECT r.id::text FROM records r WHERE r.session_id = s.id AND r.person_id = $2::uuid AND r.deleted_at IS NULL) AS record_id
       FROM sessions s
       LEFT JOIN session_subjects ss ON ss.session_id = s.id AND ss.person_id = $2::uuid
       LEFT JOIN people ap ON ap.id = s.assessor_person_id
       LEFT JOIN users uu ON uu.id = s.unsigned_by
       LEFT JOIN session_template_versions v ON v.id = s.template_version_id
      WHERE s.id = $1::uuid AND s.deleted_at IS NULL`,
    [sessionId, personId],
  );
  if (!row) throw new SignRefused('not_found');
  const liveHash = await contentDigest(sessionId, personId);
  const [assessorMethod, subjectMethod] = await Promise.all([
    signMethodFor(row.assessor_person_id),
    signMethodFor(personId),
  ]);
  return {
    assessorMethod,
    subjectMethod,
    storedHash: row.content_hash,
    liveHash,
    matches: row.content_hash === null || row.content_hash === liveHash,
    assessor: row.assessor_signed_at ? { at: row.assessor_signed_at, name: row.assessor_name, method: row.assessor_signature_method } : null,
    subject: row.subject_signed_at ? { at: row.subject_signed_at, method: row.subject_signature_method } : null,
    objection: row.objected_at ? { at: row.objected_at, reason: row.objection_reason } : null,
    recordId: row.record_id,
    unsigned: row.unsigned_at ? { at: row.unsigned_at, by: row.unsigned_by, reason: row.unsigned_reason } : null,
    hiddenFromSubject: row.hide,
    status: row.status,
  };
}

/* ------------------------------------------------------------------ signing */

export type SignParty = 'assessor' | 'subject';

export interface SignInput {
  readonly sessionId: string;
  readonly personId: string;
  readonly party: SignParty;
  /**
   * What the signer typed: their account password, or - only where the signer has no account - their
   * employee id. Never stored, never logged, and never compared in the application.
   */
  readonly secret: string;
  readonly userId: string;
  /** The signing account's own roster row, for the assessor check. */
  readonly actorPersonId: string | null;
}

export interface SignResult { readonly hash: string; readonly at: string; readonly status: string; readonly method: SignMethod }

export async function signSession(input: SignInput, access: ResolvedAccess): Promise<SignResult> {
  if (!can(access, 'training.sessions.sign')) throw new SignRefused('Your account may not sign a session.');
  const secret = input.secret;
  if (secret.trim().length === 0) throw new SignRefused('Enter the password to sign.');

  const head = await queryOne<{
    status: string; assessor_person_id: string | null; second_assessor_person_id: string | null;
    assessor_signed_at: string | null; subject_signed_at: string | null; outcome: string | null;
    assessor_external_id: string | null; subject_external_id: string | null; hide: boolean; content_hash: string | null;
  }>(
    `SELECT s.status, s.assessor_person_id::text AS assessor_person_id, s.second_assessor_person_id::text AS second_assessor_person_id,
            s.assessor_signed_at::text AS assessor_signed_at, ss.subject_signed_at::text AS subject_signed_at,
            ss.outcome, ap.external_id AS assessor_external_id, sp.external_id AS subject_external_id,
            COALESCE(v.hide_record_from_subject, false) AS hide, ss.content_hash
       FROM sessions s
       LEFT JOIN session_subjects ss ON ss.session_id = s.id AND ss.person_id = $2::uuid
       LEFT JOIN people ap ON ap.id = s.assessor_person_id
       LEFT JOIN people sp ON sp.id = $2::uuid
       LEFT JOIN session_template_versions v ON v.id = s.template_version_id
      WHERE s.id = $1::uuid AND s.deleted_at IS NULL`,
    [input.sessionId, input.personId],
  );
  if (!head) throw new SignRefused('not_found');
  if (head.status === 'finalized') throw new SignRefused('This session is finalised. Its record is frozen.');
  if (head.status === 'void') throw new SignRefused('This session is void.');

  const sameId = (a: string | null) => a !== null && a.trim().toLowerCase() === secret.trim().toLowerCase();
  let method: SignMethod;
  /** The account whose signature this is: the signer's own, never the device holder's. */
  let signerUserId: string;

  if (input.party === 'assessor') {
    if (head.assessor_signed_at) throw new SignRefused('The instructor has already signed.');
    const isAssessor = input.actorPersonId !== null
      && (input.actorPersonId === head.assessor_person_id || input.actorPersonId === head.second_assessor_person_id);
    if (!isAssessor) throw new SignRefused('Only the instructor named on this session can sign as the instructor.');
    // The assessor is signed in - their own password is what is verified.
    if (!(await passwordOk(input.userId, secret))) throw new SignRefused('That password was not accepted.');
    method = 'password';
    signerUserId = input.userId;
    // The outcome is the assessor's word and the record's conclusion; signing without one would
    // attest to an assessment that reaches no finding. policy.yaml: outcome_is_always_explicit.
    if (!head.outcome) throw new SignRefused('Enter the outcome before signing.');
    // The operator's standard, checked again here. saveSessionFields refuses a passing outcome that
    // breaches it, but a grade can be lowered AFTER the outcome was stored - so the state that gets
    // signed is not necessarily the state that was written, and this is the last moment anyone can
    // tell. lib/program/outcome-standard.ts.
    const standard = await judgeStoredOutcome(input.sessionId, input.personId, head.outcome);
    if (!standard.allowed) throw new SignRefused(standard.reason ?? 'These grades cannot carry this outcome.');
  } else {
    if (head.hide) throw new SignRefused('This record is internal: the pilot does not see it and does not sign it.');
    if (head.subject_signed_at) throw new SignRefused('The pilot has already signed.');
    if (!head.assessor_signed_at) throw new SignRefused('The instructor signs first.');
    const pilotAccount = await accountOf(input.personId);
    if (pilotAccount) {
      // The pilot signs as themselves, on the instructor's screen. Their account is what is checked
      // and what the row records, so the signature is theirs and not the device holder's.
      if (!(await passwordOk(pilotAccount, secret))) throw new SignRefused('That password was not accepted.');
      method = 'password';
      signerUserId = pilotAccount;
    } else {
      // No account: the weaker assertion, recorded as what it is. An account is the fix, not a
      // cleverer fallback.
      if (!sameId(head.subject_external_id)) throw new SignRefused('That is not the pilot\'s employee id.');
      method = 'employee_id';
      signerUserId = input.userId;
    }
  }

  const hash = await contentDigest(input.sessionId, input.personId);
  // A second signature on content that has moved since the first is refused rather than recorded:
  // the two parties must attest to the SAME document, which is the only thing a hash can guarantee.
  // The comparison is against THIS pilot's stored hash. It used to be against the session's, which
  // in a two-pilot session is the other pilot's digest and never matches - migration 0153.
  if (head.content_hash !== null && head.content_hash !== hash) {
    throw new SignRefused('The content has changed since the first signature. Unsign, review it again, and sign afresh.');
  }

  /*
   * The instructor signs ONCE for the session, and that one act freezes the content for every pilot
   * on it. So the assessor's signature stamps each assessed subject with THAT SUBJECT'S OWN digest,
   * computed here, before the transaction, because contentDigest reads outside it. A pilot who signs
   * afterwards is then compared against a hash taken at the instant the instructor signed - which is
   * what "both signatures attest to the same content" has to mean when there are two pilots and one
   * instructor.
   */
  const subjectHashes: { personId: string; hash: string }[] = [];
  if (input.party === 'assessor') {
    const subjects = await query<{ person_id: string }>(
      `SELECT person_id::text AS person_id FROM session_subjects
        WHERE session_id = $1::uuid AND is_assessed ORDER BY person_id`,
      [input.sessionId],
    );
    for (const sub of subjects) {
      subjectHashes.push({
        personId: sub.person_id,
        hash: sub.person_id === input.personId ? hash : await contentDigest(input.sessionId, sub.person_id),
      });
    }
  }

  return transaction(async (client) => {
    if (input.party === 'assessor') {
      await client.query(
        `UPDATE sessions
            SET assessor_signed_at = now(), assessor_signer_id = $2::uuid, assessor_signature_method = $4,
                content_hash = COALESCE(content_hash, $3), status = 'submitted'
          WHERE id = $1::uuid`,
        [input.sessionId, signerUserId, hash, method],
      );
      // One hash per pilot, each of that pilot's own content. COALESCE so a re-run cannot move a
      // hash somebody has already attested to.
      for (const sub of subjectHashes) {
        await client.query(
          `UPDATE session_subjects SET content_hash = COALESCE(content_hash, $3)
            WHERE session_id = $1::uuid AND person_id = $2::uuid`,
          [input.sessionId, sub.personId, sub.hash],
        );
      }
    } else {
      await client.query(
        `UPDATE session_subjects
            SET subject_signed_at = now(), subject_signer_id = $3::uuid, subject_signature_method = $4,
                content_hash = COALESCE(content_hash, $5)
          WHERE session_id = $1::uuid AND person_id = $2::uuid`,
        [input.sessionId, input.personId, signerUserId, method === 'password' ? 'password' : 'employee_id_on_device', hash],
      );
      await client.query(`UPDATE sessions SET content_hash = COALESCE(content_hash, $2) WHERE id = $1::uuid`, [input.sessionId, hash]);
    }

    // `signed` means every signature this record needs is in place: both parties, or the assessor
    // alone where the pilot never sees the record. Finalising is a separate, deliberate act.
    // Every placeholder in the statement is used and every parameter is referenced. PostgreSQL
    // prepares by the highest $n it sees, so passing a parameter the SQL never mentions fails with
    // "could not determine data type of parameter $2" - which is exactly what broke the first
    // signature here, and reached the surface as a bare 500.
    const done = await client.query<{ ready: boolean }>(
      `SELECT (s.assessor_signed_at IS NOT NULL
               AND ($2::boolean OR NOT EXISTS (
                 SELECT 1 FROM session_subjects x
                  WHERE x.session_id = s.id AND x.is_assessed AND x.subject_signed_at IS NULL))) AS ready
         FROM sessions s WHERE s.id = $1::uuid`,
      [input.sessionId, head.hide],
    );
    if (done.rows[0]?.ready) {
      await client.query(`UPDATE sessions SET status = 'signed' WHERE id = $1::uuid`, [input.sessionId]);
    }
    const back = await client.query<{ status: string; at: string }>(
      `SELECT s.status, COALESCE(ss.subject_signed_at, s.assessor_signed_at)::text AS at
         FROM sessions s LEFT JOIN session_subjects ss ON ss.session_id = s.id AND ss.person_id = $2::uuid
        WHERE s.id = $1::uuid`,
      [input.sessionId, input.personId],
    );
    return { hash, at: back.rows[0]?.at ?? new Date().toISOString(), status: back.rows[0]?.status ?? 'submitted', method };
  });
}

/* ------------------------------------------------------------------ unsigning */

export interface UnsignInput {
  readonly sessionId: string;
  /** The password of the account doing this. Verified in the database; never stored or logged. */
  readonly password: string;
  readonly reason: string;
  readonly userId: string;
}

/**
 * Removes EVERY signature on the session and unlocks it again.
 *
 * Three things make this different from any other write. The password is re-entered, because undoing
 * an attestation is itself an attestation and a single button on a screen somebody has walked away
 * from must not be enough - the same reasoning, and the same check, as a signature.
 *
 * The reason is required and is stored on the session as well as in the log, because "why was this
 * signed twice" is the first question anybody asks. And the content hash is cleared: the old hash
 * attested to a document nobody is attesting to any more, and keeping it would let a later render
 * claim the content still matches.
 *
 * A finalised session is not unsigned - it is amended, which is a different capability and leaves the
 * record in place.
 */
export async function unsignSession(input: UnsignInput, access: ResolvedAccess): Promise<{ at: string }> {
  if (!can(access, 'training.sessions.unsign')) throw new SignRefused('Your account may not remove a signature.');
  const reason = input.reason.trim();
  if (reason.length < 3) throw new SignRefused('Say why the signatures are being removed.');

  if (!(await passwordOk(input.userId, input.password))) throw new SignRefused('That password was not accepted.');

  const head = await queryOne<{ status: string; signed: boolean }>(
    `SELECT s.status,
            (s.assessor_signed_at IS NOT NULL OR EXISTS (
               SELECT 1 FROM session_subjects x WHERE x.session_id = s.id AND x.subject_signed_at IS NOT NULL)) AS signed
       FROM sessions s WHERE s.id = $1::uuid AND s.deleted_at IS NULL`,
    [input.sessionId],
  );
  if (!head) throw new SignRefused('not_found');
  if (head.status === 'finalized') throw new SignRefused('This session is finalised. A finalised record is amended, never unsigned.');
  if (!head.signed) throw new SignRefused('Nothing is signed on this session.');

  return transaction(async (client) => {
    await client.query(
      `UPDATE sessions
          SET assessor_signed_at = NULL, assessor_signer_id = NULL, assessor_signature_method = NULL,
              content_hash = NULL, status = 'in_progress',
              unsigned_at = now(), unsigned_by = $2::uuid, unsigned_reason = $3
        WHERE id = $1::uuid`,
      [input.sessionId, input.userId, reason],
    );
    // The per-pilot hashes go with the signatures they attested to. Leaving one behind would let a
    // later render claim the content still matches something nobody is attesting to any more.
    await client.query(
      `UPDATE session_subjects
          SET subject_signed_at = NULL, subject_signer_id = NULL, subject_signature_method = NULL,
              content_hash = NULL
        WHERE session_id = $1::uuid`,
      [input.sessionId],
    );
    return { at: new Date().toISOString() };
  });
}
