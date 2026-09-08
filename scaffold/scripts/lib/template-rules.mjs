/**
 * template-rules.mjs - the publish rules of docs/05_TEMPLATES_AND_BUILDER.md section 3.
 *
 * ONE FUNCTION, TWO CALLERS. The builder's publish action and scripts/seed-templates.mjs both
 * validate through validateTemplate() below. Two copies of these rules drift, and the drift shows
 * up as seeded data the UI cannot open - which is the one failure mode a starter template must
 * never have. If the seeder passes something the builder would reject, the seeder is wrong.
 *
 * TODO(kit): when the template builder route lands it imports THIS module (or this module moves to
 * scaffold/lib/etr/ and the seeder imports it from there). It does not re-implement the list.
 *
 * Nothing here hardcodes a vocabulary. The element-key pattern, the reserved titles, the element
 * catalogue and the template-kind list all come from scaffold/config/policy.yaml; the competency
 * and observable-behaviour codes come from the database.
 *
 * NAMING NOTE. A seed definition calls an element's type `catalogue_type`. Since migration 0033
 * that is simply a synonym for `template_elements.element_type`: the value is written into that
 * column unchanged. The field name predates the widening, when the catalogue was richer than the
 * column and the two had to be told apart.
 */

/** Rule 6 is a database question and is checked by the caller; every other rule is here. */
export const PUBLISH_RULES = [
  'element_key unique within the version and matching the configured pattern',
  'no reserved titles, no empty template, no section with no children',
  'every competency and observable behaviour exists in the framework',
  'every visible_when.element_key resolves inside the same version',
  'effective_from present and not in the past',
  'no published version with the same effective_from (checked against the database)',
];

const norm = (s) => String(s ?? '').trim().toLowerCase();

/**
 * @param {object} definition  a seed template definition
 * @param {object} context     { policy, competencyCodes:Set, obCodes:Set, today:'YYYY-MM-DD', effectiveFrom:'YYYY-MM-DD' }
 * @returns {string[]} errors; empty means publishable
 */
export function validateTemplate(definition, context) {
  const errors = [];
  const add = (message) => errors.push(message);
  const { policy, competencyCodes, obCodes, today, effectiveFrom } = context;

  const keyPattern = new RegExp(policy.templates.element_key_pattern);
  const reserved = new Set(policy.reserved_element_titles.map(norm));
  const catalogue = policy.element_catalogue;
  const kinds = new Map(policy.template_kinds.map((k) => [k.kind, k]));

  // --- identity -----------------------------------------------------------
  if (!definition.code) add('template has no code');
  if (!definition.name || !definition.name.trim()) add('template has no name; an empty name is a hard failure');
  const kind = kinds.get(definition.kind);
  if (!kind) {
    add(
      `template_kind "${definition.kind}" is not in policy.yaml template_kinds. ` +
        'A kind is configuration; add it there rather than widening a CHECK.',
    );
  }

  // --- elements -----------------------------------------------------------
  const elements = Array.isArray(definition.elements) ? definition.elements : [];
  if (elements.length === 0) add('template has no elements; an empty template is never publishable');

  const keys = new Set();
  const byKey = new Map();
  for (const el of elements) {
    const key = el.element_key;
    if (!key) { add('an element has no element_key'); continue; }
    if (!keyPattern.test(key)) {
      add(`element_key "${key}" does not match ${policy.templates.element_key_pattern}`);
    }
    if (keys.has(key)) add(`element_key "${key}" is used twice; keys are unique within a version`);
    keys.add(key);
    byKey.set(key, el);

    const entry = catalogue[el.catalogue_type];
    if (!entry) {
      add(`element "${key}" has unknown catalogue type "${el.catalogue_type}"`);
    }
    if (el.title && reserved.has(norm(el.title))) {
      add(
        `element "${key}" uses the reserved title "${el.title}". The renderer owns the subject ` +
          'cards, the competency block, the outcome selector, the session remarks and the ' +
          'signature blocks; a template that declares one produces a visible duplicate in the report.',
      );
    }
    if (typeof el.position !== 'number') add(`element "${key}" has no numeric position`);
  }

  // parents, and the "no section with no children" rule
  const childCount = new Map();
  for (const el of elements) {
    const parent = el.parent_key;
    if (parent === undefined || parent === null) continue;
    if (!keys.has(parent)) {
      add(`element "${el.element_key}" names parent "${parent}", which is not in this version`);
      continue;
    }
    if (parent === el.element_key) add(`element "${el.element_key}" is its own parent`);
    childCount.set(parent, (childCount.get(parent) ?? 0) + 1);
  }
  for (const el of elements) {
    if (el.catalogue_type !== 'section' && el.catalogue_type !== 'group') continue;
    if ((childCount.get(el.element_key) ?? 0) === 0) {
      add(`section "${el.element_key}" has no children; an empty section renders as a bare band`);
    }
  }

  // conditional visibility must resolve inside the same version
  for (const el of elements) {
    const condition = el.content?.visible_when;
    if (!condition) continue;
    if (!condition.element_key || !keys.has(condition.element_key)) {
      add(
        `element "${el.element_key}" has visible_when.element_key "${condition.element_key}", ` +
          'which does not resolve inside this version',
      );
    }
  }

  // --- framework references, by CODE, resolved against the database --------
  const referenced = new Set(definition.competencies ?? []);
  for (const el of elements) {
    for (const code of el.content?.competency_codes ?? []) referenced.add(code);
  }
  for (const code of referenced) {
    if (!competencyCodes.has(code)) {
      add(
        `competency code "${code}" is not in the active framework. Unknown codes are REJECTED, ` +
          'never substituted with a default: a silent substitution grades someone against a ' +
          'competency nobody chose.',
      );
    }
  }
  for (const el of elements) {
    for (const code of el.content?.observable_behaviour_codes ?? []) {
      if (!obCodes.has(code)) add(`observable behaviour "${code}" is not in the active framework`);
    }
  }
  if (referenced.size === 0) add('template references no competencies');

  // --- effective date -----------------------------------------------------
  if (!effectiveFrom) {
    add('effective_from is required at publish');
  } else if (effectiveFrom < today) {
    add(
      `effective_from ${effectiveFrom} is in the past (today is ${today}). Backdating a publish ` +
        'does not retroactively re-grade or re-render anything, so it is refused rather than ' +
        'quietly accepted.',
    );
  }

  return errors;
}

/**
 * Resolves a policy template kind to the value stored in session_templates.template_kind - which is
 * the SAME STRING. There is no mapping any more: migration 0032 replaced 0020's six-family CHECK
 * with the operator-editable template_kinds catalogue, so the process kind the author chose is what
 * the database records.
 *
 * `allowedKinds` is the set of codes actually present in that catalogue, read from the database by
 * the caller. Checking against it turns "this kind is not seeded" into a sentence with the kind's
 * name in it, instead of a foreign-key violation quoting a constraint name.
 */
export function resolveTemplateKind(policy, kindName, allowedKinds) {
  const kind = policy.template_kinds.find((k) => k.kind === kindName);
  if (!kind) throw new Error(`template kind "${kindName}" is not defined in policy.yaml`);
  if (allowedKinds && !allowedKinds.has(kind.kind)) {
    throw new Error(
      `template kind "${kindName}" is in policy.yaml but not in the template_kinds catalogue ` +
        `(migration 0032). Present: ${[...allowedKinds].sort().join(', ')}. Insert the kind ` +
        'rather than widening anything: the catalogue is the operator-editable copy of this list.',
    );
  }
  return kind.kind;
}

/**
 * Resolves a catalogue type to the stored element_type - again the same string, since migration
 * 0033 widened the CHECK to exactly the eight catalogue types of docs/05 section 2. Returns the
 * catalogue entry so the caller can read `graded`.
 */
export function resolveElementType(policy, catalogueType, allowedTypes) {
  const entry = policy.element_catalogue[catalogueType];
  if (!entry) throw new Error(`element catalogue has no entry for "${catalogueType}"`);
  if (allowedTypes && !allowedTypes.has(catalogueType)) {
    throw new Error(
      `element catalogue type "${catalogueType}" is not allowed by template_elements.element_type ` +
        `(migration 0033). Allowed: ${[...allowedTypes].sort().join(', ')}.`,
    );
  }
  return { type: catalogueType, graded: entry.graded === true };
}
