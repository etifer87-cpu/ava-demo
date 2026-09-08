#!/usr/bin/env node
/**
 * seed-templates.mjs - loads the four starter templates and publishes version 1 of each.
 *
 * Source: scaffold/db/seed/templates/*.json (docs/05_TEMPLATES_AND_BUILDER.md section 6).
 *
 * It validates through scripts/lib/template-rules.mjs, which is THE SAME function the builder's
 * publish action uses. If this script accepts something the builder would reject, the script is
 * wrong, not the builder.
 *
 * Three ordering facts are load-bearing:
 *   1. the framework must already be seeded, because competencies are referenced by CODE in the
 *      JSON and resolved to ids here - a template never stores a competency name;
 *   2. a version is inserted as a DRAFT, filled, and only then published. Migration 0021 blocks
 *      every write to the children of a published version with a trigger, so publishing first
 *      makes the elements unwritable;
 *   3. a published version is immutable. Re-running this script does not edit one; it reports the
 *      existing version and moves on. Editing means a new version.
 *
 * Usage:
 *   node scripts/seed-templates.mjs
 *   node scripts/seed-templates.mjs --dry-run                validate only, no database needed
 *   node scripts/seed-templates.mjs --effective-from 2026-09-01
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  KIT_ROOT, argFlag, argValue, connect, loadPolicy, renderTable,
} from './lib/kit-seed.mjs';
import { validateTemplate } from './lib/template-rules.mjs';
import {
  TemplateSeedError, allowedCheckValues, allowedTemplateKinds, publishDefinition, readFrameworkFromDb,
} from './lib/template-publish.mjs';

const SEED_DIR = path.resolve(KIT_ROOT, 'scaffold', 'db', 'seed', 'templates');
const FRAMEWORK_SEED = path.resolve(KIT_ROOT, 'scaffold', 'db', 'seed', 'competency_framework.json');
const DRY_RUN = argFlag('--dry-run');

async function loadDefinitions() {
  const names = (await readdir(SEED_DIR)).filter((n) => n.endsWith('.json')).sort();
  const out = [];
  for (const name of names) {
    const text = await readFile(path.join(SEED_DIR, name), 'utf8');
    out.push({ file: name, definition: JSON.parse(text) });
  }
  if (out.length === 0) throw new TemplateSeedError(`no template definitions found in ${SEED_DIR}`);
  return out;
}

async function readFrameworkFromSeedFile() {
  const data = JSON.parse(await readFile(FRAMEWORK_SEED, 'utf8'));
  const competencyIdByCode = new Map();
  const obIdByCode = new Map();
  for (const c of data.competencies) {
    competencyIdByCode.set(c.code, null);
    for (const ob of c.observable_behaviours) obIdByCode.set(ob.code, null);
  }
  return {
    frameworkId: null,
    frameworkCode: data.framework.code,
    competencyIdByCode,
    competencyOrder: data.competencies.map((c) => c.code),
    obIdByCode,
  };
}

async function main() {
  const policyFile = await loadPolicy();
  const policy = policyFile.data;
  const definitions = await loadDefinitions();

  const today = new Date().toISOString().slice(0, 10);
  const effectiveFrom = argValue('--effective-from', today);

  const client = DRY_RUN ? null : await connect();
  const framework = client ? await readFrameworkFromDb(client) : await readFrameworkFromSeedFile();
  const competencyCodes = new Set(framework.competencyIdByCode.keys());
  const obCodes = new Set(framework.obIdByCode.keys());

  // Validate everything BEFORE writing anything. A partial publish leaves the builder's list in a
  // state no author asked for.
  const failures = [];
  for (const entry of definitions) {
    const errors = validateTemplate(entry.definition, {
      policy, competencyCodes, obCodes, today, effectiveFrom,
    });
    if (errors.length > 0) failures.push({ file: entry.file, errors });
  }
  if (failures.length > 0) {
    for (const f of failures) {
      console.error(`\n${f.file} would be REJECTED by the builder:`);
      for (const e of f.errors) console.error(`  - ${e}`);
    }
    throw new TemplateSeedError(
      `${failures.length} template definition(s) failed the publish rules. The seeder enforces the ` +
        'same rules as the builder; nothing was written.',
    );
  }
  console.log(`validated ${definitions.length} template definitions against the publish rules`);

  if (DRY_RUN) {
    console.log('--dry-run: nothing written');
    console.log(renderTable(
      ['file', 'code', 'kind', 'elements', 'competencies'],
      definitions.map((d) => [
        d.file, d.definition.code, d.definition.kind,
        d.definition.elements.length, d.definition.competencies.length,
      ]),
    ));
    return;
  }

  // template_kind is a foreign key into the template_kinds catalogue (migration 0032); element_type
  // is still a CHECK (migration 0033), because one vocabulary is the operator's and the other is the
  // renderer's. Both are read from the database rather than restated here.
  const allowedKinds = await allowedTemplateKinds(client);
  const allowedElementTypes = await allowedCheckValues(client, 'template_elements', 'element_type');

  const results = [];
  try {
    await client.query('BEGIN');
    for (const entry of definitions) {
      results.push(await publishDefinition(client, entry, {
        policy, framework, effectiveFrom, allowedKinds, allowedElementTypes,
      }));
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }

  console.log(`\nframework ${framework.frameworkCode}, effective_from ${effectiveFrom}\n`);
  console.log(renderTable(
    ['file', 'code', 'kind', 'elements', 'competencies', 'action'],
    results.map((r) => [r.file, r.code, r.kind, r.elements, r.competencies, r.action]),
  ));
  console.log('\nNext: node scripts/seed-synthetic.mjs');
}

main().catch((err) => {
  if (err instanceof TemplateSeedError) console.error(`\ntemplate seed REJECTED: ${err.message}\n`);
  else console.error(err);
  process.exit(1);
});
