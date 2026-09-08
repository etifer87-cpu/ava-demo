/**
 * verify/templates.mjs - would the builder still publish what the seeder published?
 *
 * The publish rules of docs/05_TEMPLATES_AND_BUILDER.md section 3 live in exactly one place,
 * scripts/lib/template-rules.mjs, and both the builder and the seeder validate through it. This
 * group closes the loop by reading each published version BACK OUT OF THE DATABASE, rebuilding
 * the definition the rules take, and re-running them. Seeded data the UI cannot open is the one
 * failure mode a starter template must never have, and it is invisible to any check that
 * validates the JSON file instead of the rows.
 *
 * THE DATE RULE. Rule 5 refuses an effective_from in the past, because backdating a publish
 * re-grades and re-renders nothing. Re-validation therefore runs each version AS OF ITS OWN
 * effective_from: the rule is about the act of publishing, not about a version already published,
 * and running it against today's date would fail every template the morning after a deploy. That
 * is the only substitution made, and every other rule runs unchanged.
 */

import { validateTemplate } from '../lib/template-rules.mjs';
import { readFrameworkFromDb } from '../lib/template-publish.mjs';

async function publishedVersions(client) {
  const { rows } = await client.query(`
    SELECT st.id AS template_id, st.code, st.name, st.template_kind, st.current_version_id,
           stv.id AS version_id, stv.version, stv.status, stv.effective_from, stv.published_at,
           stv.framework_id, stv.setup, stv.allowed_assessor_roles, stv.hide_record_from_subject
      FROM session_templates st
      LEFT JOIN session_template_versions stv ON stv.id = st.current_version_id
     WHERE st.deleted_at IS NULL
     ORDER BY st.code`);
  return rows;
}

export const checks = [
  {
    name: 'every seeded template has a published current version',
    async run({ client }) {
      const rows = await publishedVersions(client);
      const problems = rows.filter((r) => !r.current_version_id
        || r.status !== 'published' || !r.effective_from || !r.published_at)
        .map((r) => `${r.code}: ${!r.current_version_id ? 'no current version'
          : r.status !== 'published' ? `status ${r.status}`
          : !r.effective_from ? 'no effective_from' : 'no published_at'}`);
      return {
        ok: rows.length > 0 && problems.length === 0,
        detail: rows.length === 0 ? 'no templates at all; the template seed did not run'
          : problems.length === 0 ? `${rows.length} templates, all published`
          : problems.join('; '),
      };
    },
  },
  {
    name: 'every published version still passes the builder publish rules',
    async run({ client, policy }) {
      const framework = await readFrameworkFromDb(client);
      const competencyCodes = new Set(framework.competencyIdByCode.keys());
      const obCodes = new Set(framework.obIdByCode.keys());
      const rows = await publishedVersions(client);
      const problems = [];

      for (const row of rows) {
        if (!row.version_id) continue;   // already reported by the assertion above
        const { rows: elements } = await client.query(
          `SELECT element_key, parent_key, element_type, title, external_ref, position, content
             FROM template_elements WHERE template_version_id = $1 ORDER BY position`,
          [row.version_id],
        );
        const { rows: comps } = await client.query(
          `SELECT c.code FROM template_competencies tc
             JOIN competencies c ON c.id = tc.competency_id
            WHERE tc.template_version_id = $1 ORDER BY tc.position`,
          [row.version_id],
        );
        // The definition shape the rules take. `catalogue_type` is the seed vocabulary for what
        // migration 0033 stores as element_type unchanged; nothing is translated on the way back.
        const definition = {
          code: row.code,
          name: row.name,
          kind: row.template_kind,
          competencies: comps.map((c) => c.code),
          version: {
            setup: row.setup,
            allowed_assessor_roles: row.allowed_assessor_roles,
            hide_record_from_subject: row.hide_record_from_subject,
          },
          elements: elements.map((e) => ({
            element_key: e.element_key,
            parent_key: e.parent_key,
            catalogue_type: e.element_type,
            title: e.title,
            external_ref: e.external_ref,
            position: e.position,
            content: e.content ?? {},
          })),
        };
        const effectiveFrom = row.effective_from instanceof Date
          ? row.effective_from.toISOString().slice(0, 10)
          : String(row.effective_from).slice(0, 10);
        const errors = validateTemplate(definition, {
          policy, competencyCodes, obCodes, today: effectiveFrom, effectiveFrom,
        });
        for (const error of errors) problems.push(`${row.code}: ${error}`);
      }

      return {
        ok: rows.length > 0 && problems.length === 0,
        detail: problems.length === 0
          ? `${rows.length} versions re-validated, each as of its own effective_from`
          : problems.slice(0, 3).join('; ') + (problems.length > 3 ? ` (+${problems.length - 3})` : ''),
      };
    },
  },
  {
    name: 'element keys are unique inside a version and match the configured pattern',
    async run({ client, policy }) {
      // Stated in SQL as well as through the rules above, because element_key is what every
      // answer row references: a duplicate key inside one version makes an answer ambiguous, and
      // no amount of application care can disambiguate it afterwards.
      const { rows: dupes } = await client.query(`
        SELECT template_version_id, element_key, count(*)::int AS n
          FROM template_elements
         GROUP BY 1, 2 HAVING count(*) > 1`);
      const { rows: keys } = await client.query('SELECT DISTINCT element_key FROM template_elements');
      const pattern = new RegExp(policy.templates.element_key_pattern);
      const bad = keys.filter((k) => !pattern.test(k.element_key)).map((k) => k.element_key);
      return {
        ok: dupes.length === 0 && bad.length === 0,
        detail: dupes.length === 0 && bad.length === 0
          ? `${keys.length} distinct element keys, all matching ${policy.templates.element_key_pattern}`
          : `${dupes.length} duplicated within a version; ${bad.length} not matching the pattern`,
      };
    },
  },
];
