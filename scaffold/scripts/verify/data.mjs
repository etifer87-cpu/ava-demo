/**
 * verify/data.mjs - is the data the schema's rules say is impossible actually absent?
 *
 * Every assertion here is an invariant the platform depends on and that no constraint can express
 * on its own: a vocabulary that lives in configuration, a key that resolves through a version, a
 * frozen copy that must exist, a delete that must never have happened.
 *
 * None of them takes a date, a floor or an ignore list. See the rules in scripts/verify.mjs.
 */

/** The grades a row is allowed to hold, assembled from configuration - never restated here. */
function allowedGrades({ analytics, policy }) {
  const pattern = new RegExp(analytics.text('grade_scale.valid_pattern'));
  const min = analytics.int('grade_scale.min');
  const max = analytics.int('grade_scale.max');
  const scale = [];
  for (let g = min; g <= max; g += 1) if (pattern.test(String(g))) scale.push(String(g));
  return new Set([
    ...scale,
    ...(analytics.json('grade_scale.non_scoring') ?? []),
    // Every non-numeric vocabulary policy.yaml defines for these columns, not just the first of
    // them. An element or competency that is not graded on the 1-5 scale stores one of these
    // tokens instead, and a check that knows only one of the three reports the other two as
    // corrupt data. They are read from policy, never listed here.
    ...(policy.grading.boolean_grade_values ?? []),
    ...(policy.grading.task_pass_fail_values ?? []),
    ...(policy.grading.competency_binary_values ?? []),
  ]);
}

const GRADE_COLUMNS = [
  ['element_grades', 'grade'],
  ['competency_grades', 'grade'],
  ['record_tasks', 'grade'],
  ['record_competencies', 'grade'],
];

export const checks = [
  {
    name: 'no grade outside the configured vocabulary',
    async run({ client, analytics, policy }) {
      const allowed = [...allowedGrades({ analytics, policy })];
      const problems = [];
      let checked = 0;
      for (const [table, column] of GRADE_COLUMNS) {
        const { rows } = await client.query(
          `SELECT ${column} AS grade, count(*)::int AS n FROM ${table}
            WHERE ${column} IS NOT NULL AND NOT (${column} = ANY($1))
            GROUP BY 1 ORDER BY 2 DESC`,
          [allowed],
        );
        const { rows: total } = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
        checked += total[0].n;
        for (const row of rows) problems.push(`${table}.${column}="${row.grade}" x${row.n}`);
      }
      return {
        ok: problems.length === 0,
        detail: problems.length === 0
          ? `${checked} graded rows, vocabulary ${allowed.join(' ')}`
          : problems.slice(0, 4).join('; '),
      };
    },
  },
  {
    name: 'every answer row resolves to an element_key in its own template version',
    async run({ client }) {
      // The whole reason answers key on element_key and never on the element row's id: an editor
      // that recreates a row changes the id and keeps the key. The invariant that makes that safe
      // is this one, and it is worth nothing unless something checks it.
      const { rows } = await client.query(`
        SELECT
          (SELECT count(*) FROM element_grades eg
             JOIN sessions s ON s.id = eg.session_id
            WHERE NOT EXISTS (SELECT 1 FROM template_elements te
                               WHERE te.template_version_id = s.template_version_id
                                 AND te.element_key = eg.element_key))::int AS session_answers,
          (SELECT count(*) FROM record_tasks rt
             JOIN records r ON r.id = rt.record_id
            WHERE r.template_version_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM template_elements te
                               WHERE te.template_version_id = r.template_version_id
                                 AND te.element_key = rt.element_key))::int AS record_tasks,
          (SELECT count(*) FROM element_grades)::int AS total_session_answers,
          (SELECT count(*) FROM record_tasks)::int AS total_record_tasks`);
      const r = rows[0];
      const bad = r.session_answers + r.record_tasks;
      return {
        ok: bad === 0,
        detail: bad === 0
          ? `${r.total_session_answers} element grades and ${r.total_record_tasks} record tasks all resolve`
          : `${r.session_answers} element grades and ${r.record_tasks} record tasks name a key their version does not have`,
      };
    },
  },
  {
    name: 'no record without a snapshot',
    async run({ client }) {
      // A record renders from its snapshot so that it still renders after its template is
      // retired. A record without one is a record that will render as an empty page on the day
      // the template changes, and not before - which is the worst possible day to find out.
      const { rows } = await client.query(`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE snapshot IS NULL)::int AS null_snapshot,
               count(*) FILTER (WHERE snapshot IS NOT NULL
                                  AND snapshot::text IN ('{}', 'null', '[]'))::int AS empty_snapshot,
               count(*) FILTER (WHERE snapshot IS NOT NULL
                                  AND NOT (snapshot ? 'tasks'))::int AS no_tasks
          FROM records WHERE deleted_at IS NULL`);
      const r = rows[0];
      const bad = r.null_snapshot + r.empty_snapshot + r.no_tasks;
      return {
        ok: r.total > 0 && bad === 0,
        detail: r.total === 0 ? 'no records at all; the synthetic seed did not run'
          : bad === 0 ? `${r.total} records, every one carrying a snapshot`
          : `${r.null_snapshot} null, ${r.empty_snapshot} empty, ${r.no_tasks} without a tasks array`,
      };
    },
  },
  {
    name: 'nothing was hard-deleted: no child points at a parent that is gone',
    async run({ client }) {
      // A hard delete leaves no row to find, so it is verified by its consequences and by its
      // guard. The guard itself is asserted in the schema group; here the question is whether any
      // row now references a parent that no longer exists - the shape a hard delete leaves behind
      // when it is performed with a constraint disabled, restored from a partial dump, or run by
      // hand. The soft-delete columns are checked too: a soft-deleted parent keeps its row and
      // must therefore keep its children, which is the point of soft deletion.
      const { rows } = await client.query(`
        SELECT
          (SELECT count(*) FROM element_grades eg
            WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = eg.session_id))::int AS grades_without_session,
          (SELECT count(*) FROM competency_grades cg
            WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = cg.session_id))::int AS competency_without_session,
          (SELECT count(*) FROM session_subjects ss
            WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = ss.session_id))::int AS subjects_without_session,
          (SELECT count(*) FROM record_tasks rt
            WHERE NOT EXISTS (SELECT 1 FROM records r WHERE r.id = rt.record_id))::int AS tasks_without_record,
          (SELECT count(*) FROM record_competencies rc
            WHERE NOT EXISTS (SELECT 1 FROM records r WHERE r.id = rc.record_id))::int AS competencies_without_record,
          (SELECT count(*) FROM line_sectors ls
            WHERE ls.record_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM records r WHERE r.id = ls.record_id))::int AS sectors_without_record,
          (SELECT count(*) FROM records r
            WHERE NOT EXISTS (SELECT 1 FROM people p WHERE p.id = r.person_id))::int AS records_without_person,
          (SELECT count(*) FROM competency_grade_obs o
            WHERE NOT EXISTS (SELECT 1 FROM competency_grades cg WHERE cg.id = o.competency_grade_id))::int AS obs_without_grade`);
      const r = rows[0];
      const bad = Object.values(r).reduce((a, b) => a + b, 0);
      return {
        ok: bad === 0,
        detail: bad === 0 ? 'every child row still has its parent'
          : Object.entries(r).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(', '),
      };
    },
  },
  {
    name: 'every graded or evidence-bearing row carries a framework',
    async run({ client }) {
      // Contract section 9: where a competency is involved, the row carries framework_id. A grade
      // without one cannot be read against any competency vocabulary, so it is invisible to every
      // analytics view rather than wrong in an obvious way.
      const { rows } = await client.query(`
        SELECT
          (SELECT count(*) FROM competency_grades WHERE framework_id IS NULL)::int AS competency_grades,
          (SELECT count(*) FROM record_competencies WHERE framework_id IS NULL)::int AS record_competencies,
          (SELECT count(*) FROM records WHERE framework_id IS NULL AND deleted_at IS NULL)::int AS records,
          (SELECT count(*) FROM sessions WHERE framework_id IS NULL AND deleted_at IS NULL)::int AS sessions,
          (SELECT count(*) FROM session_template_versions
            WHERE framework_id IS NULL AND status = 'published' AND deleted_at IS NULL)::int AS template_versions,
          (SELECT count(*) FROM analysis_runs WHERE framework_id IS NULL)::int AS analysis_runs`);
      const r = rows[0];
      const bad = Object.values(r).reduce((a, b) => a + b, 0);
      return {
        ok: bad === 0,
        detail: bad === 0 ? 'framework_id present on every grade, record, session, published version and analysis run'
          : Object.entries(r).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(', '),
      };
    },
  },
  {
    name: 'every grade names a competency and an element that exist',
    async run({ client }) {
      const { rows } = await client.query(`
        SELECT
          (SELECT count(*) FROM competency_grades cg
            WHERE NOT EXISTS (SELECT 1 FROM competencies c WHERE c.id = cg.competency_id))::int AS unknown_competency,
          (SELECT count(*) FROM competency_grade_obs o
            WHERE NOT EXISTS (SELECT 1 FROM observable_behaviours ob
                               WHERE ob.id = o.observable_behaviour_id))::int AS unknown_ob,
          (SELECT count(*) FROM record_competencies rc
            WHERE NOT EXISTS (SELECT 1 FROM competencies c WHERE c.id = rc.competency_id))::int AS unknown_record_competency`);
      const r = rows[0];
      const bad = Object.values(r).reduce((a, b) => a + b, 0);
      return {
        ok: bad === 0,
        detail: bad === 0 ? 'every competency and observable-behaviour reference resolves'
          : Object.entries(r).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(', '),
      };
    },
  },
];
