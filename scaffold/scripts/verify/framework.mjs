/**
 * verify/framework.mjs - is the competency vocabulary the one that was seeded?
 *
 * Every grade in the platform points at a competency_id and every selection at an
 * observable_behaviour_id, so a framework that loaded partially is a framework that silently
 * removes grades from view. The counts are NOT restated here: they are compared against
 * db/seed/competency_framework.json, the artefact the seeder loads, so this file cannot drift
 * from it and neither can be edited alone to make the other pass.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { SCAFFOLD_ROOT } from '../lib/kit-seed.mjs';

const SEED_FILE = path.join(SCAFFOLD_ROOT, 'db', 'seed', 'competency_framework.json');

async function seedCounts() {
  const seed = JSON.parse(await readFile(SEED_FILE, 'utf8'));
  const ordered = [...(seed.competencies ?? [])].sort((a, b) => a.position - b.position);
  const byCode = new Map(ordered.map((c) => [c.code, (c.observable_behaviours ?? []).length]));
  return {
    code: seed.framework.code,
    byCode,
    // The seed file states its own expected shape; comparing the file to itself as well as to the
    // database is what catches a hand-edit of the generated file.
    expected: seed.expected,
    sequence: ordered.map((c) => (c.observable_behaviours ?? []).length),
    total: [...byCode.values()].reduce((a, b) => a + b, 0),
  };
}

export const checks = [
  {
    name: 'exactly one active framework, and it is the seeded one',
    async run({ client }) {
      const seed = await seedCounts();
      const { rows } = await client.query(
        'SELECT id, code FROM competency_frameworks WHERE is_active',
      );
      const ok = rows.length === 1 && rows[0].code === seed.code;
      return {
        ok,
        detail: ok ? `framework ${rows[0].code}`
          : `${rows.length} active framework(s): ${rows.map((r) => r.code).join(', ') || '(none)'}, seed names ${seed.code}`,
      };
    },
  },
  {
    name: 'competency and observable-behaviour counts match the seed exactly',
    async run({ client }) {
      const seed = await seedCounts();
      const { rows } = await client.query(`
        SELECT c.code, c.position, count(ob.id)::int AS obs
          FROM competencies c
          JOIN competency_frameworks f ON f.id = c.framework_id AND f.is_active
          LEFT JOIN observable_behaviours ob
                 ON ob.competency_id = c.id AND ob.is_active
         WHERE c.is_active
         GROUP BY c.code, c.position ORDER BY c.position`);
      const byCode = new Map(rows.map((r) => [r.code, r.obs]));
      const problems = [];
      for (const [code, expected] of seed.byCode) {
        if (!byCode.has(code)) { problems.push(`${code} absent`); continue; }
        if (byCode.get(code) !== expected) {
          problems.push(`${code} has ${byCode.get(code)} OBs, seed has ${expected}`);
        }
      }
      for (const code of byCode.keys()) {
        if (!seed.byCode.has(code)) problems.push(`${code} is in the database and not in the seed`);
      }
      const total = [...byCode.values()].reduce((a, b) => a + b, 0);
      const sequence = rows.map((r) => r.obs);
      if (seed.expected) {
        if (seed.expected.competency_count !== rows.length) {
          problems.push(`${rows.length} competencies, seed expects ${seed.expected.competency_count}`);
        }
        if (seed.expected.ob_total !== total) {
          problems.push(`${total} observable behaviours, seed expects ${seed.expected.ob_total}`);
        }
        if ((seed.expected.ob_counts ?? []).join(',') !== sequence.join(',')) {
          problems.push(`per-competency counts ${sequence.join(',')}, seed expects ${(seed.expected.ob_counts ?? []).join(',')}`);
        }
        if ((seed.expected.ob_counts ?? []).join(',') !== seed.sequence.join(',')) {
          problems.push('the seed file disagrees with its own expected counts; it has been hand-edited');
        }
      }
      return {
        ok: problems.length === 0 && rows.length === seed.byCode.size && total === seed.total,
        detail: problems.length === 0
          ? `${rows.length} competencies, ${total} observable behaviours, `
            + `per competency ${sequence.join(',')}`
          : problems.join('; '),
      };
    },
  },
  {
    name: 'no observable behaviour is orphaned or in the wrong framework',
    async run({ client }) {
      const { rows } = await client.query(`
        SELECT
          (SELECT count(*) FROM observable_behaviours ob
             LEFT JOIN competencies c ON c.id = ob.competency_id
            WHERE c.id IS NULL)::int AS no_competency,
          (SELECT count(*) FROM observable_behaviours ob
             JOIN competencies c ON c.id = ob.competency_id
            WHERE ob.framework_id IS DISTINCT FROM c.framework_id)::int AS wrong_framework,
          (SELECT count(*) FROM competencies c
            WHERE c.is_active
              AND NOT EXISTS (SELECT 1 FROM observable_behaviours ob
                               WHERE ob.competency_id = c.id AND ob.is_active))::int AS empty_competency,
          (SELECT count(*) FROM observable_behaviours WHERE framework_id IS NULL)::int AS no_framework`);
      const r = rows[0];
      const bad = r.no_competency + r.wrong_framework + r.empty_competency + r.no_framework;
      return {
        ok: bad === 0,
        detail: bad === 0 ? 'every OB has a live parent, the parent framework, and no competency is empty'
          : `orphaned ${r.no_competency}, wrong framework ${r.wrong_framework}, `
            + `null framework ${r.no_framework}, empty competencies ${r.empty_competency}`,
      };
    },
  },
];
