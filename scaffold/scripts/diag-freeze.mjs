#!/usr/bin/env node
/**
 * diag-freeze.mjs - why did finalising fail?
 *
 *   npm run diag:freeze                      the newest signed session
 *   npm run diag:freeze -- <session-uuid>    a particular one
 *
 * Runs the freeze's OWN statements, one at a time, inside a transaction that is ALWAYS ROLLED BACK.
 * It writes nothing and it fixes nothing: it prints which statement fails and what PostgreSQL said,
 * which is the one thing a 500 in the browser does not tell you. The shape of every INSERT here is
 * copied from lib/program/freeze.ts; if the two drift, this script is the one to correct.
 */
import { connect } from './lib/kit-seed.mjs';

const arg = process.argv[2] ?? null;
const client = await connect();
let step = 0;
const run = async (label, sql, params = []) => {
  step += 1;
  try {
    const { rows } = await client.query(sql, params);
    console.log(`  ${String(step).padStart(2)}. ok    ${label}${rows.length ? ` -> ${JSON.stringify(rows[0]).slice(0, 160)}` : ''}`);
    return rows;
  } catch (e) {
    console.log(`  ${String(step).padStart(2)}. FAIL  ${label}`);
    console.log(`      ${e.code ?? ''} ${e.message}`);
    if (e.detail) console.log(`      detail: ${e.detail}`);
    if (e.constraint) console.log(`      constraint: ${e.constraint}`);
    if (e.column) console.log(`      column: ${e.column}`);
    throw e;
  }
};

try {
  await client.query('SET statement_timeout = 0');

  // ---- the columns this slice added. A missing one is the whole answer. -------------------------
  const cols = await client.query(`
    SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public'
       AND (table_name, column_name) IN (
         ('sessions','content_hash'), ('sessions','assessor_signature_method'), ('sessions','unsigned_reason'),
         ('session_subjects','subject_signature_method'), ('session_subjects','objected_at'),
         ('session_subjects','objection_reason'), ('session_subjects','objection_by'),
         ('records','content_hash'), ('competency_grades','proposed_grade'), ('competency_grades','proposed_basis'),
         ('record_competencies','proposed_grade'), ('record_competencies','proposed_basis'))
     ORDER BY 1, 2`);
  const want = 12;
  console.log(`\n== migrations 0149 / 0150 / 0151 columns: ${cols.rows.length}/${want} present`);
  if (cols.rows.length < want) {
    const have = new Set(cols.rows.map((r) => `${r.table_name}.${r.column_name}`));
    for (const c of ['sessions.content_hash', 'sessions.assessor_signature_method', 'sessions.unsigned_reason',
      'session_subjects.subject_signature_method', 'session_subjects.objected_at', 'session_subjects.objection_reason',
      'session_subjects.objection_by', 'records.content_hash', 'competency_grades.proposed_grade',
      'competency_grades.proposed_basis', 'record_competencies.proposed_grade', 'record_competencies.proposed_basis']) {
      if (!have.has(c)) console.log(`   MISSING ${c}  -> run npm run migrate`);
    }
  }

  // ---- pick the session --------------------------------------------------------------------------
  const pick = await client.query(
    arg
      ? `SELECT s.id::text, ss.person_id::text AS person_id, s.status FROM sessions s
           JOIN session_subjects ss ON ss.session_id = s.id AND ss.is_assessed
          WHERE s.id = $1::uuid AND s.deleted_at IS NULL LIMIT 1`
      : `SELECT s.id::text, ss.person_id::text AS person_id, s.status FROM sessions s
           JOIN session_subjects ss ON ss.session_id = s.id AND ss.is_assessed
          WHERE s.deleted_at IS NULL AND s.assessor_signed_at IS NOT NULL AND s.status <> 'finalized'
          ORDER BY s.assessor_signed_at DESC LIMIT 1`,
    arg ? [arg] : [],
  );
  const target = pick.rows[0];
  if (!target) { console.log('\nNo signed, unfinalised session found. Sign one first, or pass a session id.'); process.exit(0); }
  console.log(`\n== session ${target.id} (${target.status}), pilot ${target.person_id}`);

  // ---- the freeze, statement by statement, then rolled back --------------------------------------
  console.log('\n== the freeze, in a transaction that will be rolled back');
  await client.query('BEGIN');
  try {
    await run('read the head', `
      SELECT s.status, s.session_date::text AS session_date, s.facility, s.facility_kind,
             s.template_version_id::text AS template_version_id, s.framework_id::text AS framework_id,
             s.org_unit_id::text AS org_unit_id, s.asset_class_id::text AS asset_class_id, ac.code AS asset_class,
             s.assessor_person_id::text AS assessor_person_id, s.assessor_signed_at::text AS assessor_signed_at,
             s.content_hash, s.remarks, s.setup,
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
       WHERE s.id = $1::uuid AND s.deleted_at IS NULL`, [target.id, target.person_id]);

    await run('read the task grades', `
      SELECT element_key, attempt, grade, remark, value_text AS seat FROM element_grades
       WHERE session_id = $1::uuid AND person_id = $2::uuid AND instance_no = 1 ORDER BY element_key, attempt`,
      [target.id, target.person_id]);

    await run('read the competency grades', `
      SELECT cg.competency_id::text AS competency_id, c.code, c.name, cg.grade, cg.remark,
             cg.proposed_grade AS proposed, cg.proposed_basis AS basis,
             COALESCE((SELECT array_agg(ob.id ORDER BY ob.code) FROM competency_grade_obs x JOIN observable_behaviours ob ON ob.id = x.observable_behaviour_id WHERE x.competency_grade_id = cg.id), '{}') AS ob_ids
        FROM competency_grades cg JOIN competencies c ON c.id = cg.competency_id
       WHERE cg.session_id = $1::uuid AND cg.person_id = $2::uuid ORDER BY c.position, c.code`,
      [target.id, target.person_id]);

    await run('read the sectors', `
      SELECT sector_number, departure, arrival FROM line_sectors
       WHERE session_id = $1::uuid AND person_id = $2::uuid AND deleted_at IS NULL ORDER BY sector_number`,
      [target.id, target.person_id]);

    await run('is there already a record', `
      SELECT id::text AS id FROM records WHERE session_id = $1::uuid AND person_id = $2::uuid AND deleted_at IS NULL`,
      [target.id, target.person_id]);

    const rec = await run('INSERT the record', `
      INSERT INTO records (session_id, person_id, source, record_kind, title, template_version_id, framework_id,
                           org_unit_id, asset_class_id, training_date, assessor_person_id, outcome, remarks,
                           is_hidden_from_subject, snapshot, content_hash, created_by)
      SELECT s.id, $2::uuid, 'app', t.template_kind, t.name, s.template_version_id, s.framework_id,
             s.org_unit_id, s.asset_class_id, s.session_date, s.assessor_person_id, ss.outcome, s.remarks,
             COALESCE(v.hide_record_from_subject, false), '{"diag":true}'::jsonb, s.content_hash, NULL
        FROM sessions s
        JOIN session_subjects ss ON ss.session_id = s.id AND ss.person_id = $2::uuid
        JOIN session_template_versions v ON v.id = s.template_version_id
        JOIN session_templates t ON t.id = v.template_id
       WHERE s.id = $1::uuid
      RETURNING id::text AS id`, [target.id, target.person_id]);

    const recordId = rec[0].id;

    await run('INSERT one record_task (uniqueness includes instance_no since 0034)', `
      INSERT INTO record_tasks (record_id, element_key, task_name, position, instance_no, attempt, grade, remark, value_text)
      VALUES ($1::uuid, 'diag.task', 'Diagnostic', 0, 1, 1, NULL, NULL, NULL)
      ON CONFLICT (record_id, element_key, instance_no, attempt) DO NOTHING RETURNING id::text AS id`, [recordId]);

    await run('INSERT one record_competency (with the 0149 columns)', `
      INSERT INTO record_competencies (record_id, framework_id, competency_id, grade, remark,
                                       observable_behaviour_ids, proposed_grade, proposed_basis)
      SELECT $1::uuid, cg.framework_id, cg.competency_id, cg.grade, cg.remark, '{}'::uuid[], cg.proposed_grade, COALESCE(cg.proposed_basis, '{}'::jsonb)
        FROM competency_grades cg WHERE cg.session_id = $2::uuid AND cg.person_id = $3::uuid LIMIT 1
      ON CONFLICT (record_id, competency_id) DO NOTHING RETURNING id::text AS id`,
      [recordId, target.id, target.person_id]);

    await run('UPDATE the sectors', `
      UPDATE line_sectors SET record_id = $3::uuid WHERE session_id = $1::uuid AND person_id = $2::uuid AND record_id IS NULL`,
      [target.id, target.person_id, recordId]);

    await run('count the pilots still without a record', `
      SELECT count(*)::int AS n FROM session_subjects ss
       WHERE ss.session_id = $1::uuid AND ss.is_assessed
         AND NOT EXISTS (SELECT 1 FROM records r WHERE r.session_id = ss.session_id AND r.person_id = ss.person_id AND r.deleted_at IS NULL)`,
      [target.id]);

    console.log('\n  every statement succeeded - the fault is in the application layer, not the SQL.');
  } finally {
    await client.query('ROLLBACK');
    console.log('\n== rolled back. Nothing was written.');
  }
} catch {
  process.exitCode = 1;
} finally {
  await client.end();
}
