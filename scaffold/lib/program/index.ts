import 'server-only';
import { policy, rules } from '@/lib/config';
import { query } from '@/lib/db';
import { buildTree, type BuiltTree, type ElementRow } from './model';
import { assertRegistryComplete, evaluate, type Finding, type RuleRegistry } from './rules';
import type { ProgramVocab } from './shape';

/**
 * lib/program/index.ts - the server seam for the program builder.
 *
 * The only file under lib/program/ that reads config.ts or the database. Everything it calls is
 * pure and takes what it needs as a value: the vocabulary from policy.yaml, the registry from
 * rules.yaml, the rows from template_elements. Screens import from here; tests import the pure
 * modules beneath.
 */

export type { ProgramVocab, TaskContent, SectionContent, Finding };
export { buildTree, evaluate };

let vocabCache: ProgramVocab | null = null;

/** The operator's program vocabulary, from policy.yaml section 9. */
export function programVocab(): ProgramVocab {
  if (vocabCache) return vocabCache;
  const p = policy().program;
  if (!p) throw new Error('config/policy.yaml has no program block (section 9)');
  vocabCache = {
    sectionKinds: new Set(p.section_kinds),
    phases: new Map(p.phases.map((ph) => [ph.code, ph.label])),
    pfSeats: new Set(p.pf_seats),
  };
  return vocabCache;
}

let registryCache: RuleRegistry | null = null;

/** The findings registry, checked against its implementations once per process. */
export function ruleRegistry(): RuleRegistry {
  if (registryCache) return registryCache;
  const r = rules();
  assertRegistryComplete(r);
  registryCache = r;
  return registryCache;
}

interface VersionRow {
  id: string;
  template_id: string;
  version: number;
  status: string;
  setup: unknown;
  template_kind: string;
  code: string;
  name: string;
}

export interface LoadedProgram extends BuiltTree {
  readonly version: VersionRow;
  readonly findings: readonly Finding[];
}

/** One template version as a tree, with its shape problems and its findings. Null when absent. */
export async function loadProgramVersion(versionId: string): Promise<LoadedProgram | null> {
  const versions = await query<VersionRow>(
    `SELECT v.id, v.template_id, v.version, v.status, v.setup, t.template_kind, t.code, t.name
       FROM session_template_versions v JOIN session_templates t ON t.id = v.template_id
      WHERE v.id = $1::uuid AND v.deleted_at IS NULL AND t.deleted_at IS NULL`,
    [versionId],
  );
  const version = versions[0];
  if (!version) return null;
  const rows = await query<ElementRow>(
    `SELECT element_key, parent_key, element_type, title, external_ref, position, is_mandatory, is_graded, max_attempts, content
       FROM template_elements WHERE template_version_id = $1::uuid ORDER BY position, element_key`,
    [versionId],
  );
  const built = buildTree(rows, version.setup, version.template_kind, programVocab());
  const findings = evaluate(built.tree, ruleRegistry());
  return { ...built, version, findings };
}
