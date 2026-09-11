/**
 * lib/program/model.ts - the in-memory tree of one program template version.
 *
 * The database stores a FLAT ordered list (template_elements, nested by parent_key) because that
 * is what makes reordering cheap and keys stable. Every reader - the builder canvas, the
 * instructor projection, the findings rules, the seeder's validation - wants a tree. This module
 * builds it once, parses every element's content through lib/program/shape.ts as it goes, and
 * hands back the tree plus every shape problem it met, each tagged with the element it belongs
 * to. No caller re-parses content.
 *
 * PURE: no config.ts, no database. Rows in, tree out.
 */

import {
  parseNoteContent,
  parseOptionGroupContent,
  parseSectionContent,
  parseSetupContent,
  parseTaskContent,
  parseVersionSetup,
  type NoteContent,
  type OptionGroupContent,
  type ProgramVocab,
  type SectionContent,
  type SetupContent,
  type ShapeProblem,
  type TaskContent,
  type VersionSetup,
} from './shape';

/** One template_elements row, as the database returns it. */
export interface ElementRow {
  readonly element_key: string;
  readonly parent_key: string | null;
  readonly element_type: string;
  readonly title: string | null;
  readonly external_ref: string | null;
  readonly position: number;
  readonly is_mandatory: boolean;
  readonly is_graded: boolean;
  readonly max_attempts: number | null;
  readonly content: unknown;
}

export type NodeContent =
  | { readonly type: 'section'; readonly section: SectionContent }
  | { readonly type: 'task'; readonly task: TaskContent }
  | { readonly type: 'setup'; readonly setup: SetupContent }
  | { readonly type: 'event_option'; readonly options: OptionGroupContent }
  | { readonly type: 'note'; readonly note: NoteContent }
  | { readonly type: 'other'; readonly elementType: string; readonly raw: unknown };

export interface ProgramNode {
  readonly key: string;
  readonly parentKey: string | null;
  readonly title: string;
  readonly externalRef: string | null;
  readonly position: number;
  readonly isMandatory: boolean;
  readonly isGraded: boolean;
  readonly maxAttempts: number | null;
  readonly content: NodeContent;
  readonly children: readonly ProgramNode[];
}

export interface ProgramTree {
  readonly kind: string;
  readonly setup: VersionSetup;
  readonly roots: readonly ProgramNode[];
  readonly byKey: ReadonlyMap<string, ProgramNode>;
}

/** A shape problem, located. `elementKey` is null for the version-level setup. */
export interface LocatedProblem extends ShapeProblem {
  readonly elementKey: string | null;
}

export interface BuiltTree {
  readonly tree: ProgramTree;
  readonly problems: readonly LocatedProblem[];
}

function parseContent(row: ElementRow, vocab: ProgramVocab): { content: NodeContent; problems: readonly ShapeProblem[] } {
  switch (row.element_type) {
    case 'section': {
      const p = parseSectionContent(row.content, vocab);
      return { content: { type: 'section', section: p.value }, problems: p.problems };
    }
    case 'task': {
      const p = parseTaskContent(row.content, vocab);
      return { content: { type: 'task', task: p.value }, problems: p.problems };
    }
    case 'setup':
    case 'reset': {
      const p = parseSetupContent(row.content);
      return { content: { type: 'setup', setup: p.value }, problems: p.problems };
    }
    case 'event_option':
    case 'malfunction': {
      const p = parseOptionGroupContent(row.content);
      return { content: { type: 'event_option', options: p.value }, problems: p.problems };
    }
    case 'note':
    case 'text': {
      const p = parseNoteContent(row.content);
      return { content: { type: 'note', note: p.value }, problems: p.problems };
    }
    default:
      return { content: { type: 'other', elementType: row.element_type, raw: row.content }, problems: [] };
  }
}

/**
 * Builds the tree. Orphans (a parent_key that names no row) are reported and attached at the root
 * rather than dropped: a task nobody can see is a task nobody can fix. Cycles are broken at the
 * first repeated key and reported the same way.
 */
export function buildTree(rows: readonly ElementRow[], versionSetup: unknown, kind: string, vocab: ProgramVocab): BuiltTree {
  const problems: LocatedProblem[] = [];

  const setupParsed = parseVersionSetup(versionSetup);
  for (const p of setupParsed.problems) problems.push({ ...p, elementKey: null });

  const parsed = new Map<string, { row: ElementRow; content: NodeContent }>();
  for (const row of rows) {
    if (parsed.has(row.element_key)) {
      problems.push({ elementKey: row.element_key, path: 'element_key', message: 'used twice in one version' });
      continue;
    }
    const pc = parseContent(row, vocab);
    for (const p of pc.problems) problems.push({ ...p, elementKey: row.element_key });
    parsed.set(row.element_key, { row, content: pc.content });
  }

  const childrenOf = new Map<string | null, ElementRow[]>();
  for (const { row } of parsed.values()) {
    let parent: string | null = row.parent_key;
    if (parent !== null && !parsed.has(parent)) {
      problems.push({ elementKey: row.element_key, path: 'parent_key', message: `names "${parent}", which is not in this version; shown at the root` });
      parent = null;
    }
    if (parent === row.element_key) {
      problems.push({ elementKey: row.element_key, path: 'parent_key', message: 'is its own parent; shown at the root' });
      parent = null;
    }
    const list = childrenOf.get(parent) ?? [];
    list.push(row);
    childrenOf.set(parent, list);
  }
  for (const list of childrenOf.values()) list.sort((a, b) => a.position - b.position || a.element_key.localeCompare(b.element_key));

  const byKey = new Map<string, ProgramNode>();
  const buildNode = (row: ElementRow, parent: string | null, trail: ReadonlySet<string>): ProgramNode | null => {
    const entry = parsed.get(row.element_key);
    if (!entry) return null;
    const nextTrail = new Set([...trail, row.element_key]);
    const children: ProgramNode[] = [];
    for (const child of childrenOf.get(row.element_key) ?? []) {
      if (nextTrail.has(child.element_key)) {
        problems.push({ elementKey: child.element_key, path: 'parent_key', message: 'closes a parent cycle; the cycle is broken here' });
        continue;
      }
      const node = buildNode(child, row.element_key, nextTrail);
      if (node) children.push(node);
    }
    const node: ProgramNode = {
      key: row.element_key,
      parentKey: parent,
      title: row.title ?? '',
      externalRef: row.external_ref,
      position: row.position,
      isMandatory: row.is_mandatory,
      isGraded: row.is_graded,
      maxAttempts: row.max_attempts,
      content: entry.content,
      children,
    };
    byKey.set(node.key, node);
    return node;
  };

  const roots: ProgramNode[] = [];
  for (const row of childrenOf.get(null) ?? []) {
    const node = buildNode(row, null, new Set());
    if (node) roots.push(node);
  }

  // A cycle with no path from the root is unreachable by the walk above: every member names a
  // parent that names it back. Place its first member at the root, report it, and let the trail
  // check break the cycle where it closes - rather than letting the elements vanish.
  for (const { row } of parsed.values()) {
    if (byKey.has(row.element_key)) continue;
    problems.push({ elementKey: row.element_key, path: 'parent_key', message: 'unreachable from the root (a parent cycle); shown at the root' });
    const node = buildNode(row, null, new Set());
    if (node) roots.push(node);
  }

  return { tree: { kind, setup: setupParsed.value, roots, byKey }, problems };
}

/* ------------------------------------------------------------------ */
/* Walks and measures                                                   */
/* ------------------------------------------------------------------ */

export function* walk(nodes: readonly ProgramNode[]): Generator<ProgramNode> {
  for (const n of nodes) {
    yield n;
    yield* walk(n.children);
  }
}

export function tasksOf(tree: ProgramTree): ProgramNode[] {
  return [...walk(tree.roots)].filter((n) => n.content.type === 'task');
}

export function sectionsOf(tree: ProgramTree): ProgramNode[] {
  return [...walk(tree.roots)].filter((n) => n.content.type === 'section');
}

/** The nearest ancestor section carrying a phase, or null. */
export function phaseOf(tree: ProgramTree, node: ProgramNode): string | null {
  let cur: ProgramNode | undefined = node;
  while (cur) {
    if (cur.content.type === 'section' && cur.content.section.phase) return cur.content.section.phase;
    cur = cur.parentKey === null ? undefined : tree.byKey.get(cur.parentKey);
  }
  return null;
}

/** True when the node or any ancestor section is marked training-only. */
export function isTrainingOnly(tree: ProgramTree, node: ProgramNode): boolean {
  let cur: ProgramNode | undefined = node;
  while (cur) {
    if (cur.content.type === 'section' && cur.content.section.training_only) return true;
    cur = cur.parentKey === null ? undefined : tree.byKey.get(cur.parentKey);
  }
  return false;
}

/**
 * Planned minutes of a node. A section with its own time wins; otherwise the sum of its children;
 * a task is its own time. Null when nothing beneath states a time - null is "not stated", never 0.
 */
export function plannedMinutes(node: ProgramNode): number | null {
  if (node.content.type === 'task') return node.content.task.minutes;
  if (node.content.type === 'section' && node.content.section.minutes !== null) return node.content.section.minutes;
  let sum: number | null = null;
  for (const child of node.children) {
    const m = plannedMinutes(child);
    if (m !== null) sum = (sum ?? 0) + m;
  }
  return sum;
}

/** Sum of the root-level planned minutes; the number the ruler shows against the period. */
export function totalPlannedMinutes(tree: ProgramTree): number | null {
  let sum: number | null = null;
  for (const root of tree.roots) {
    const m = plannedMinutes(root);
    if (m !== null) sum = (sum ?? 0) + m;
  }
  return sum;
}
