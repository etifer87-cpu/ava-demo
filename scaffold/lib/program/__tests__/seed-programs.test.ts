/**
 * seed-programs.test.ts - every generated program definition in data/programs/ parses clean,
 * builds a tree without problems, raises no blocking finding, and projects for the instructor
 * and the record. Run against the real files so a generator change that breaks a program is
 * caught before it reaches a database.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ProgramVocab } from '../shape';
import { buildTree, type ElementRow } from '../model';
import { evaluate, type RuleRegistry } from '../rules';
import { instructorProjection, subjectProjection } from '../projection';

const vocab: ProgramVocab = {
  sectionKinds: new Set(['module', 'session', 'block']),
  phases: new Map([['brief', 'Briefing'], ['eval', 'Evaluation'], ['mt', 'Manoeuvres training'], ['sbt', 'Scenario-based training'], ['transit', 'Transit'], ['reinf', 'Additional training'], ['debrief', 'Debriefing']]),
  pfSeats: new Set(['CM1', 'CM2']),
};
const registry = parseYaml(readFileSync(path.resolve(process.cwd(), 'config/rules.yaml'), 'utf8')) as RuleRegistry;
const DIR = process.env.PROGRAM_DATA_DIR ?? path.resolve(process.cwd(), '..', 'data', 'programs');
const files = readdirSync(DIR).filter((f) => f.endsWith('.json') && f !== 'retired.json');

type Def = { template: { code: string; kind: string; setup: unknown }; elements: { key: string; type: string; title: string; content?: unknown; children?: Def['elements'] }[] };
function rows(def: Def): ElementRow[] {
  const out: ElementRow[] = [];
  const walk = (els: Def['elements'], parent: string | null) => els.forEach((e, i) => {
    out.push({ element_key: e.key, parent_key: parent, element_type: e.type, title: e.title, external_ref: null, position: i, is_mandatory: false, is_graded: e.type === 'task', max_attempts: null, content: (e.content ?? {}) as Record<string, unknown> });
    walk(e.children ?? [], e.key);
  });
  walk(def.elements, null);
  return out;
}

describe('generated program definitions', () => {
  it('finds the set', () => { expect(files.length).toBeGreaterThanOrEqual(37); });
  for (const f of files) {
    it(`${f}: parses, builds, has no blocker and projects`, () => {
      const def = JSON.parse(readFileSync(path.join(DIR, f), 'utf8')) as Def;
      const built = buildTree(rows(def), def.template.setup, def.template.kind, vocab);
      expect(built.problems.map((p) => `${p.elementKey}: ${p.path} ${p.message}`)).toEqual([]);
      const findings = evaluate(built.tree, registry);
      expect(findings.filter((x) => x.severity === 'block').map((x) => `${x.rule} at ${x.at}`)).toEqual([]);
      expect(findings.filter((x) => x.rule === 'time.budget')).toEqual([]);
      const view = instructorProjection(built.tree, { runtime: null });
      expect(view.order.length).toBeGreaterThan(3);
      const report = subjectProjection(built.tree);
      expect(report.sections.flatMap((s) => s.rows).some((r) => r.grading.task_outcome_mode !== 'none' || r.grading.competency_grade_mode !== 'none')).toBe(true);
    });
  }
});
