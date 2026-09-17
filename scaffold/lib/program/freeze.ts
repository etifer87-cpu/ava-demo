import 'server-only';
import { query, queryOne, transaction } from '@/lib/db';
import { can, type ResolvedAccess } from '@/lib/access';
import { gradeNum } from '@/lib/grades';
import { policy, signatureStatements, gradeScale } from '@/lib/config';
import { loadProgramVersion } from '@/lib/program';
import { instructorProjection } from '@/lib/program/projection';
import { contentDigest, signMethodFor, SignRefused } from '@/lib/program/signing';
import { storeRecordPdf } from '@/lib/program/record-pdf';
import { PdfUnavailable } from '@/lib/pdf';

/**
 * lib/program/freeze.ts - the objection, and the freeze into a record. docs/04_ETR.md §6.
 *
 * THE FREEZE IS THE POINT OF THE WHOLE MODULE. Up to here a record is a join: grades in
 * element_grades and competency_grades, titles in template_elements, competency names in the
 * framework, all of it live. A training record has to outlive every one of those - the program gets a
 * new version, the competency wording is revised, the template is retired - and still render exactly
 * as it was signed. So finalising writes:
 *
 *   records                one row per assessed pilot, source 'app', with the frozen fleet, date,
 *                          assessor, outcome and the content hash the signatures attest to;
 *   record_tasks           EVERY attempt, not the last one (0029 says why in as many words);
 *   record_competencies    the grade, its remark and the OB ids as an array, plus the proposal the
 *                          instructor graded against (0149);
 *   line_sectors           re-pointed at the record, keeping their session link;
 *   record_pdfs            the rendered PDF, at finalisation, so the paper is part of what was frozen
 *                          rather than re-made later by whatever the code does that day (0152);
 *   records.snapshot       everything a reader needs with NO lookups at all - template name and
 *                          version, task titles, competency names, OB texts, both signatures, the
 *                          objection. components/program/RecordDialog.tsx renders this and nothing
 *                          else, which is what makes a five-year-old record still legible.
 *
 * WHY THE ANALYTICS ARE NOT REFRESHED HERE. `refresh_assessor_analytics()` rebuilds nine materialised
 * views and takes the best part of a minute on three years of seeded history (migration 0147). That
 * cannot sit inside a button press. The bench pages read mv_*; a record finalised today appears there
 * after `npm run analytics:refresh`, and the pilot's own pages read `records` directly and show it at
 * once. This is a deliberate split, not an oversight.
 */

export class FreezeRefused extends Error {}

/* ------------------------------------------------------------------ the objection */

export interface ObjectInput {
  readonly sessionId: string;
  readonly personId: string;
  readonly reason: string;
  /** The pilot's own password, or their employee id where they have no account. */
  readonly secret: string;
  readonly userId: string;
}

/**
 * The pilot objects instead of signing.
 *
 * Identity is asserted exactly as a signature is, because an objection is an attestation too - it is
 * the pilot's own statement that they do not accept the record, and it goes to a manager with their
 * name on it. The reason is required and is never summarised anywhere: what the manager reads is what
 * the pilot wrote.
 */
export async function objectToRecord(input: ObjectInput, access: ResolvedAccess): Promise<{ at: string; notified: number }> {
  if (!can(access, 'training.sessions.sign')) throw new FreezeRefused('This account may not record an objection.');
  const reason = input.reason.trim();
  if (reason.length < 3) throw new FreezeRefused('The objection needs the pilot\'s reasons.');
  if (!signatureStatements(null).objection.allowed) throw new FreezeRefused('This operator does not allow an objection.');

  const head = await queryOne<{
    status: string; assessor_signed_at: string | null; subject_signed_at: string | null; objected_at: string | null;
    external_id: string | null; hide: boolean;
  }>(
    `SELECT s.status, s.assessor_signed_at::text AS assessor_signed_at, ss.subject_signed_at::text AS subject_signed_at,
            ss.objected_at::text AS objected_at, p.external_id, COALESCE(v.hide_record_from_subject, false) AS hide
       FROM sessions s
       JOIN session_subjects ss ON ss.session_id = s.id AND ss.person_id = $2::uuid
       JOIN people p ON p.id = ss.person_id
       LEFT JOIN session_template_versions v ON v.id = s.template_version_id
      WHERE s.id = $1::uuid AND s.deleted_at IS NULL`,
    [input.sessionId, input.personId],
  );
  if (!head) throw new FreezeRefused('not_found');
  if (head.hide) throw new FreezeRefused('This record is internal: the pilot does not see it and cannot object to it.');
  if (head.status === 'finalized') throw new FreezeRefused('This session is finalised. An objection after that is an amendment.');
  if (!head.assessor_signed_at) throw new FreezeRefused('The instructor signs first. There is nothing to object to yet.');
  if (head.subject_signed_at) throw new FreezeRefused('The pilot has already signed this record.');
  if (head.objected_at) throw new FreezeRefused('An objection is already recorded.');

  // The pilot proves who they are the same way they would to sign.
  const method = await signMethodFor(input.personId);
  let by = input.userId;
  if (method === 'password') {
    const account = await queryOne<{ id: string; ok: boolean }>(
      `SELECT u.id::text AS id, (u.password_hash = crypt($2, u.password_hash)) AS ok
         FROM users u WHERE u.person_id = $1::uuid AND u.deleted_at IS NULL AND u.is_active LIMIT 1`,
      [input.personId, input.secret],
    );
    if (!account?.ok) throw new FreezeRefused('That password was not accepted.');
    by = account.id;
  } else if ((head.external_id ?? '').trim().toLowerCase() !== input.secret.trim().toLowerCase()) {
    throw new FreezeRefused('That is not the pilot\'s employee id.');
  }

  const notified = await transaction(async (client) => {
    await client.query(
      `UPDATE session_subjects SET objected_at = now(), objection_reason = $3, objection_by = $4::uuid
        WHERE session_id = $1::uuid AND person_id = $2::uuid`,
      [input.sessionId, input.personId, reason, by],
    );
    return notifyObjection(client, input.sessionId, input.personId, reason);
  });
  return { at: new Date().toISOString(), notified };
}

interface Client { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }

/**
 * One in-app notice per holder of the role policy.yaml names, through the kit's own dispatch table
 * (0125) rather than a table of this module's own. A notice is queued, not sent: there is no mail in
 * this instance and an objection is read where the work is, on a manager's screen.
 *
 * Recipients are the live holders of the role whose grant reaches this fleet - unbound, or bound to
 * the session's own asset class. A manager bound to the B787 is not told about an A320 objection.
 */
async function notifyObjection(client: Client, sessionId: string, personId: string, reason: string): Promise<number> {
  const role = signatureStatements(null).objection.notifiesRole;
  if (!role) return 0;
  const rows = await client.query(
    `INSERT INTO dispatch_notices (event_kind, severity, subject_id, recipient_user_id, recipient_person_id, org_unit_id,
                                   target_kind, target_id, dedup_key, title, body, payload, channel, state)
     SELECT 'training.record.objected', 'hard', $2::uuid, u.id, u.person_id, s.org_unit_id,
            'session', $1::text, concat('objection:', $1::text, ':', $2::text),
            concat(p.full_name, ' objected to a training record'),
            $4::text,
            jsonb_build_object('session_id', $1::text, 'person_id', $2::text, 'role', $3::text),
            'in_app', 'queued'
       FROM sessions s
       JOIN people p ON p.id = $2::uuid
       JOIN user_roles ur ON ur.role_code = $3 AND (ur.expires_at IS NULL OR ur.expires_at > now())
       JOIN users u ON u.id = ur.user_id AND u.deleted_at IS NULL AND u.is_active
      WHERE s.id = $1::uuid
        AND (ur.asset_class_id IS NULL OR ur.asset_class_id = s.asset_class_id)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [sessionId, personId, role, reason],
  );
  // Nobody holding the role is a configuration fault, not a reason to lose the objection - it is
  // already on the record. The count goes back to the caller, which audits it and tells the pilot.
  return rows.rows.length;
}

/* ------------------------------------------------------------------ the freeze */

export interface FinaliseInput {
  readonly sessionId: string;
  readonly personId: string;
  readonly userId: string;
}

export interface FinaliseResult {
  readonly recordId: string;
  readonly outcome: string | null;
  readonly tasks: number;
  readonly competencies: number;
  /** Null when the PDF was rendered and stored; the reason it was not, otherwise. */
  readonly pdfProblem: string | null;
}

interface FreezeHead {
  status: string; session_date: string; facility: string | null; facility_kind: string | null;
  template_version_id: string; framework_id: string | null; org_unit_id: string | null; asset_class_id: string | null;
  asset_class: string | null; assessor_person_id: string | null; assessor_signed_at: string | null;
  content_hash: string | null; remarks: string | null; setup: Record<string, unknown> | null;
  template_code: string; template_name: string; template_kind: string; kind_label: string | null; version_no: number;
  hide: boolean; seat_role: string | null; outcome: string | null; subject_signed_at: string | null;
  objected_at: string | null; objection_reason: string | null; objection_by_name: string | null;
  subject_external_id: string; subject_name: string; subject_position: string | null;
  assessor_external_id: string | null; assessor_name: string | null; assessor_roles: string[] | null;
}

/**
 * Freezes one pilot's part of a signed session into a record.
 *
 * Refuses unless the instructor has signed AND the pilot has signed, objected, or never sees the
 * record at all. Refuses if the content no longer hashes to what was signed - that would freeze a
 * document nobody attested to. Refuses a second time for the same pilot, through the unique index
 * `records_session_person_uniq` rather than a check that could race with itself.
 */
export async function finaliseRecord(input: FinaliseInput, access: ResolvedAccess): Promise<FinaliseResult> {
  const frozen = await freezeIntoRecord(input, access);

  /* The PDF is part of what was frozen, but it is a RENDERING of the record and not the record. If the
     renderer is down at this moment the record still exists, signed and hashed; the download link
     renders it then. So this is deliberately outside the transaction and deliberately not fatal. */
  let pdfProblem: string | null = null;
  try {
    await storeRecordPdf(frozen.recordId, input.userId);
  } catch (err) {
    pdfProblem = err instanceof PdfUnavailable ? err.message : 'The PDF could not be rendered.';
    console.error('[finalise] record', frozen.recordId, 'has no PDF -', pdfProblem);
  }
  return { ...frozen, pdfProblem };
}

async function freezeIntoRecord(input: FinaliseInput, access: ResolvedAccess): Promise<Omit<FinaliseResult, 'pdfProblem'>> {
  if (!can(access, 'training.sessions.finalize')) throw new FreezeRefused('This account may not finalise a session.');

  const head = await queryOne<FreezeHead>(
    `SELECT s.status, s.session_date::text AS session_date, s.facility, s.facility_kind,
            s.template_version_id::text AS template_version_id, s.framework_id::text AS framework_id,
            s.org_unit_id::text AS org_unit_id, s.asset_class_id::text AS asset_class_id, ac.code AS asset_class,
            s.assessor_person_id::text AS assessor_person_id, s.assessor_signed_at::text AS assessor_signed_at,
            ss.content_hash, s.remarks, s.setup,
            t.code AS template_code, t.name AS template_name, t.template_kind, k.label AS kind_label, v.version AS version_no,
            COALESCE(v.hide_record_from_subject, false) AS hide,
            ss.seat_role, ss.outcome, ss.subject_signed_at::text AS subject_signed_at,
            ss.objected_at::text AS objected_at, ss.objection_reason, ob.full_name AS objection_by_name,
            sp.external_id AS subject_external_id, sp.full_name AS subject_name, sp.position AS subject_position,
            ap.external_id AS assessor_external_id, ap.full_name AS assessor_name,
            COALESCE(ap.instructor_roles, '{}') AS assessor_roles
       FROM sessions s
       JOIN session_subjects ss ON ss.session_id = s.id AND ss.person_id = $2::uuid
       JOIN people sp ON sp.id = ss.person_id
       JOIN session_template_versions v ON v.id = s.template_version_id
       JOIN session_templates t ON t.id = v.template_id
       LEFT JOIN template_kinds k ON k.code = t.template_kind
       LEFT JOIN asset_classes ac ON ac.id = s.asset_class_id
       LEFT JOIN people ap ON ap.id = s.assessor_person_id
       LEFT JOIN users obu ON obu.id = ss.objection_by
       LEFT JOIN people ob ON ob.id = obu.person_id
      WHERE s.id = $1::uuid AND s.deleted_at IS NULL`,
    [input.sessionId, input.personId],
  );
  if (!head) throw new FreezeRefused('not_found');
  if (head.status === 'finalized') throw new FreezeRefused('This session is already finalised.');
  if (head.status === 'void') throw new FreezeRefused('This session is void.');
  if (!head.assessor_signed_at) throw new FreezeRefused('The instructor has not signed.');
  if (!head.subject_signed_at && !head.objected_at && !head.hide) {
    throw new FreezeRefused('The pilot has neither signed nor objected. A record is not frozen over their head.');
  }

  const live = await contentDigest(input.sessionId, input.personId).catch((e) => {
    if (e instanceof SignRefused) throw new FreezeRefused('not_found');
    throw e;
  });
  // This pilot's hash, stamped when the instructor signed (migration 0153). Reading the session's
  // instead would compare one pilot's content with another pilot's hash, and refuse every freeze on
  // a crewed session.
  if (head.content_hash && head.content_hash !== live) {
    throw new FreezeRefused('The content has changed since it was signed. Remove the signatures, review it and sign again.');
  }

  /* ---- the pieces, read once ------------------------------------------------------------------ */
  const program = await loadProgramVersion(head.template_version_id);
  const titles = new Map<string, { title: string; position: number }>();
  if (program) {
    let n = 0;
    for (const section of instructorProjection(program.tree, { runtime: null }).sections) {
      for (const step of section.steps) { titles.set(step.key, { title: step.title, position: n }); n += 1; }
      titles.set(section.key, { title: section.title, position: n }); n += 1;
    }
  }

  const [tasks, comps, sectors] = await Promise.all([
    query<{ element_key: string; attempt: number; grade: string | null; remark: string | null; seat: string | null }>(
      `SELECT element_key, attempt, grade, remark, value_text AS seat
         FROM element_grades WHERE session_id = $1::uuid AND person_id = $2::uuid AND instance_no = 1
        ORDER BY element_key, attempt`,
      [input.sessionId, input.personId],
    ),
    query<{ competency_id: string; code: string; name: string; grade: string | null; remark: string | null; proposed: string | null; basis: unknown; ob_ids: string[]; ob_codes: string[]; ob_texts: string[] }>(
      `SELECT cg.competency_id::text AS competency_id, c.code, c.name, cg.grade, cg.remark,
              cg.proposed_grade AS proposed, cg.proposed_basis AS basis,
              COALESCE((SELECT array_agg(ob.id ORDER BY ob.code) FROM competency_grade_obs x JOIN observable_behaviours ob ON ob.id = x.observable_behaviour_id WHERE x.competency_grade_id = cg.id), '{}') AS ob_ids,
              COALESCE((SELECT array_agg(ob.code ORDER BY ob.code) FROM competency_grade_obs x JOIN observable_behaviours ob ON ob.id = x.observable_behaviour_id WHERE x.competency_grade_id = cg.id), '{}') AS ob_codes,
              COALESCE((SELECT array_agg(ob.text ORDER BY ob.code) FROM competency_grade_obs x JOIN observable_behaviours ob ON ob.id = x.observable_behaviour_id WHERE x.competency_grade_id = cg.id), '{}') AS ob_texts
         FROM competency_grades cg JOIN competencies c ON c.id = cg.competency_id
        WHERE cg.session_id = $1::uuid AND cg.person_id = $2::uuid
        ORDER BY c.position, c.code`,
      [input.sessionId, input.personId],
    ),
    query<{ sector_number: number; departure: string | null; arrival: string | null }>(
      `SELECT sector_number, departure, arrival FROM line_sectors
        WHERE session_id = $1::uuid AND person_id = $2::uuid AND deleted_at IS NULL ORDER BY sector_number`,
      [input.sessionId, input.personId],
    ),
  ]);

  /* ---- the outcome an objection changes, and the finding it must not lose --------------------- */
  const objection = signatureStatements(head.template_kind).objection;
  const assessed = head.outcome;
  const outcome = head.objected_at ? objection.marksRecord || assessed : assessed;

  const scale = gradeScale();
  const scored = comps.filter((c) => gradeNum(c.grade, scale) !== null);
  const unscored = comps.filter((c) => gradeNum(c.grade, scale) === null && c.grade !== null);

  const snapshot = {
    kind: head.template_kind,
    template: { code: head.template_code, name: head.template_name, kind: head.template_kind, kind_label: head.kind_label ?? head.template_kind, version: head.version_no },
    subject: { external_id: head.subject_external_id, full_name: head.subject_name, position: head.subject_position, seat: head.seat_role ?? undefined },
    assessor: head.assessor_external_id
      ? { external_id: head.assessor_external_id, full_name: head.assessor_name ?? '', roles: head.assessor_roles ?? [] }
      : undefined,
    session: {
      date: head.session_date,
      facility: head.facility ?? undefined,
      check: typeof head.setup?.check === 'string' ? head.setup.check : undefined,
      aircraft_type: head.asset_class ?? undefined,
      departure: sectors[0]?.departure ?? undefined,
      arrival: sectors[sectors.length - 1]?.arrival ?? undefined,
      sector_number: sectors.length === 1 ? sectors[0]?.sector_number : undefined,
    },
    tasks: tasks
      .filter((t) => t.grade !== null || (t.remark ?? '') !== '')
      .map((t) => ({
        element_key: t.element_key,
        task_name: titles.get(t.element_key)?.title ?? t.element_key,
        attempt: t.attempt,
        grade: t.grade,
        remark: t.remark,
        role: t.seat,
      })),
    competency_scores: scored.map((c) => ({ code: c.code, name: c.name, score: gradeNum(c.grade, scale) as number })),
    competency_results: unscored.map((c) => ({ code: c.code, name: c.name, result: c.grade as string })),
    competency_remarks: comps.filter((c) => (c.remark ?? '') !== '').map((c) => ({ code: c.code, remark: c.remark as string })),
    competency_proposed: comps.filter((c) => c.proposed !== null).map((c) => ({ code: c.code, proposed: c.proposed as string, agreed: c.proposed === c.grade })),
    observable_behaviours: comps.flatMap((c) => c.ob_codes.map((code, i) => ({ competency: c.code, code, text: c.ob_texts[i] ?? '' }))),
    signatures: { assessor_at: head.assessor_signed_at, subject_at: head.subject_signed_at },
    objection: head.objected_at
      ? { reason: head.objection_reason ?? '', by: head.objection_by_name ?? head.subject_name, at: head.objected_at }
      : undefined,
    outcome,
    /** What the instructor found, kept when an objection changed the record's own outcome. */
    outcome_assessed: assessed,
    content_hash: head.content_hash ?? live,
    remarks: head.remarks ?? undefined,
  };

  return transaction(async (client) => {
    // A plain INSERT, and the race is caught by the unique index rather than by ON CONFLICT. The
    // index is PARTIAL (`records_session_person_uniq ... WHERE session_id IS NOT NULL AND deleted_at
    // IS NULL`), and an ON CONFLICT that has to infer a partial index is one more thing that can fail
    // at run time for a reason the caller cannot read. A duplicate here is a 23505, which says
    // exactly what happened.
    const already = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM records WHERE session_id = $1::uuid AND person_id = $2::uuid AND deleted_at IS NULL`,
      [input.sessionId, input.personId],
    );
    if (already.rows[0]) throw new FreezeRefused('A record already exists for this pilot on this session.');

    let rec;
    try {
      rec = await client.query<{ id: string }>(
        `INSERT INTO records (session_id, person_id, source, record_kind, title, template_version_id, framework_id,
                              org_unit_id, asset_class_id, training_date, assessor_person_id, outcome, remarks,
                              is_hidden_from_subject, snapshot, content_hash, created_by)
         VALUES ($1::uuid, $2::uuid, 'app', $3, $4, $5::uuid, $6::uuid, $7::uuid, $8::uuid, $9::date, $10::uuid,
                 $11, $12, $13, $14::jsonb, $15, $16::uuid)
         RETURNING id::text AS id`,
        [input.sessionId, input.personId, head.template_kind, head.template_name, head.template_version_id,
          head.framework_id, head.org_unit_id, head.asset_class_id, head.session_date, head.assessor_person_id,
          outcome, head.remarks, head.hide, JSON.stringify(snapshot), head.content_hash ?? live, input.userId],
      );
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new FreezeRefused('A record already exists for this pilot on this session.');
      throw e;
    }
    const recordId = rec.rows[0]?.id;
    if (!recordId) throw new FreezeRefused('The record could not be written.');

    // instance_no is part of the uniqueness and of the row. Migration 0034 REPLACED 0029's
    // (record_id, element_key, attempt) with (record_id, element_key, instance_no, attempt) on
    // record_tasks exactly as it did on element_grades, so an ON CONFLICT naming the old three
    // columns matches no constraint and PostgreSQL answers 42P10. The frozen copy also carries the
    // seat in value_text, the same column the live row uses, so the record loses nothing.
    for (const t of tasks) {
      await client.query(
        `INSERT INTO record_tasks (record_id, element_key, task_name, position, instance_no, attempt, grade, remark, value_text)
         VALUES ($1::uuid, $2, $3, $4, 1, $5, $6, $7, $8)
         ON CONFLICT (record_id, element_key, instance_no, attempt) DO NOTHING`,
        [recordId, t.element_key, titles.get(t.element_key)?.title ?? t.element_key, titles.get(t.element_key)?.position ?? 0, t.attempt, t.grade, t.remark, t.seat],
      );
    }

    for (const c of comps) {
      await client.query(
        `INSERT INTO record_competencies (record_id, framework_id, competency_id, grade, remark,
                                          observable_behaviour_ids, proposed_grade, proposed_basis)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid[], $7, $8::jsonb)
         ON CONFLICT (record_id, competency_id) DO NOTHING`,
        [recordId, head.framework_id, c.competency_id, c.grade, c.remark, c.ob_ids, c.proposed, JSON.stringify(c.basis ?? {})],
      );
    }

    // The sectors were graded against the session; the record now owns them too. Both links are kept
    // on purpose (0030): the session is where they were flown, the record is where they are read.
    await client.query(
      `UPDATE line_sectors SET record_id = $3::uuid WHERE session_id = $1::uuid AND person_id = $2::uuid AND record_id IS NULL`,
      [input.sessionId, input.personId, recordId],
    );

    // The session is finalised once no assessed pilot on it is still without a record.
    const left = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM session_subjects ss
        WHERE ss.session_id = $1::uuid AND ss.is_assessed
          AND NOT EXISTS (SELECT 1 FROM records r WHERE r.session_id = ss.session_id AND r.person_id = ss.person_id AND r.deleted_at IS NULL)`,
      [input.sessionId],
    );
    if ((left.rows[0]?.n ?? 0) === 0) {
      await client.query(`UPDATE sessions SET status = 'finalized' WHERE id = $1::uuid`, [input.sessionId]);
    }

    return { recordId, outcome, tasks: tasks.length, competencies: comps.length };
  });
}

/** The outcomes this operator records, for a screen that offers them. */
export function outcomeVocabulary(): string[] {
  return policy().grading?.outcomes ?? [];
}
