import 'server-only';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

/**
 * config.ts - the only reader of scaffold/config/*.yaml.
 *
 * SERVER ONLY.
 *
 * Contract rule 7: no threshold, band boundary, weight, colour or product name is inline in code.
 * They live in YAML, are read here once per process, and are passed DOWN as values. Nothing deeper
 * in the tree reads a file or a global, which is what keeps every analytics function pure and
 * testable with a literal config object.
 *
 * Caching is per process and deliberate: a config change is a reload, and a reload is a restart or
 * an explicit bump through config_versions. A file re-read on every request would make two requests
 * in the same report disagree.
 */

const CONFIG_DIR = path.resolve(process.cwd(), 'config');

const cache = new Map<string, unknown>();

function load<T>(file: string): T {
  const hit = cache.get(file);
  if (hit) return hit as T;
  const raw = readFileSync(path.join(CONFIG_DIR, file), 'utf8');
  const parsed = parse(raw) as T;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`config/${file} did not parse to an object`);
  }
  cache.set(file, parsed);
  return parsed;
}

/* ------------------------------------------------------------------ */
/* brand.yaml                                                          */
/* ------------------------------------------------------------------ */

export interface ColourSet {
  primary: string;
  primary_ink: string;
  /** Optional header pair; the header falls back to primary / primary_ink when absent. */
  header?: string;
  header_ink?: string;
  accent: string;
  accent_ink: string;
  surface: string;
  surface_raised: string;
  surface_sunken: string;
  ink: string;
  ink_muted: string;
  border: string;
  border_strong: string;
}

export interface StateSet {
  good: string;
  warn: string;
  bad: string;
  info: string;
  neutral: string;
}

export interface FontFace {
  family: string;
  src: string;
  weight: string;
  style: string;
  unicode_range?: string;
}

export interface BrandConfig {
  version: string;
  /** "light" pins the light palette; "auto" (default) follows prefers-color-scheme. */
  scheme?: 'light' | 'auto';
  product: { name: string; short_name: string; environment_label: string };
  logo: { path: string; alt: string; height_px: number };
  colour: { light: ColourSet; dark: ColourSet };
  state: { light: StateSet; dark: StateSet };
  grade_palette: Record<string, { colour: string; label: string }>;
  /** Keyed by policy.yaml program.phases codes; emitted as --phase-<code>. Optional. */
  phase_palette?: Record<string, { colour: string; label?: string }>;
  font: { sans: string; mono: string; display: string; faces?: FontFace[] };
  shape: { radius_px: number; radius_small_px: number; focus_ring_px: number };
}

export function brand(): BrandConfig {
  return load<BrandConfig>('brand.yaml');
}

/**
 * The token block written into :root by app/layout.tsx.
 *
 * Emitted as two rule sets - light on :root, dark inside the scheme override - so that the CSS in
 * globals.css can rely on the properties existing without knowing their values, and an operator's
 * edit to brand.yaml is the whole rebrand.
 */
export function brandCss(b: BrandConfig = brand()): string {
  const vars = (c: ColourSet, s: StateSet) =>
    [
      `--brand-primary:${c.primary}`,
      `--brand-primary-ink:${c.primary_ink}`,
      `--brand-accent:${c.accent}`,
      `--brand-accent-ink:${c.accent_ink}`,
      `--header:${c.header ?? c.primary}`,
      `--header-ink:${c.header_ink ?? c.primary_ink}`,
      `--surface:${c.surface}`,
      `--surface-raised:${c.surface_raised}`,
      `--surface-sunken:${c.surface_sunken}`,
      `--ink:${c.ink}`,
      `--ink-muted:${c.ink_muted}`,
      `--border:${c.border}`,
      `--border-strong:${c.border_strong}`,
      `--state-good:${s.good}`,
      `--state-warn:${s.warn}`,
      `--state-bad:${s.bad}`,
      `--state-info:${s.info}`,
      `--state-neutral:${s.neutral}`,
    ].join(';');

  const shape = [
    `--font-sans:${b.font.sans}`,
    `--font-mono:${b.font.mono}`,
    `--font-display:${b.font.display}`,
    `--radius:${b.shape.radius_px}px`,
    `--radius-sm:${b.shape.radius_small_px}px`,
    `--focus-ring:${b.shape.focus_ring_px}px`,
  ].join(';');

  const faces = (b.font.faces ?? [])
    .map(
      (f) =>
        `@font-face{font-family:${JSON.stringify(f.family)};src:url(${JSON.stringify(f.src)}) format("woff2");` +
        `font-weight:${f.weight};font-style:${f.style};font-display:swap` +
        (f.unicode_range ? `;unicode-range:${f.unicode_range}` : '') +
        `}`,
    )
    .join('\n');

  const phases = Object.entries(b.phase_palette ?? {})
    .filter(([code, v]) => /^[a-z][a-z0-9_-]*$/.test(code) && typeof v?.colour === 'string')
    .map(([code, v]) => `--phase-${code}:${v.colour}`)
    .join(';');

  const light = `:root{${vars(b.colour.light, b.state.light)};${shape}${phases ? `;${phases}` : ''}}`;
  // scheme "light" pins the palette: no dark override is emitted and the UA is told so.
  const dark =
    b.scheme === 'light'
      ? `:root{color-scheme:light}`
      : `@media (prefers-color-scheme: dark){:root{${vars(b.colour.dark, b.state.dark)}}}`;

  return [faces, light, dark].filter(Boolean).join('\n');
}

/** Phase colour for one code, or null when the palette has no entry - the caller draws the neutral border. */
export function phaseColour(code: string | null, b: BrandConfig = brand()): string | null {
  if (!code) return null;
  return b.phase_palette?.[code]?.colour ?? null;
}

/** Grade colours for the chart token builder. Keyed by the numeric grade, sorted ascending. */
export function gradePalette(b: BrandConfig = brand()): { grade: number; colour: string; label: string }[] {
  return Object.entries(b.grade_palette)
    .map(([grade, v]) => ({ grade: Number(grade), colour: v.colour, label: v.label }))
    .filter((g) => Number.isFinite(g.grade))
    .sort((a, z) => a.grade - z.grade);
}

/* ------------------------------------------------------------------ */
/* analytics.yaml                                                      */
/* ------------------------------------------------------------------ */

/**
 * The analytics configuration, shaped exactly like the YAML. It is returned as `unknown`-free but
 * intentionally loose: `lib/analytics/types.ts` owns the strict shape, and casting here would put
 * two definitions of the same object in the tree.
 */
export function analyticsConfig<T = Record<string, unknown>>(): T {
  return load<T>('analytics.yaml');
}

/** The grade-scale slice, the one lib/grades.ts needs injected. */
export function gradeScale(): {
  valid_pattern: string;
  min: number;
  max: number;
  non_scoring: string[];
  below_standard_max: number;
  meets_standard_min: number;
  critical_grade: number;
} {
  const cfg = analyticsConfig<{ grade_scale: ReturnType<typeof gradeScale> }>();
  if (!cfg.grade_scale) throw new Error('config/analytics.yaml has no grade_scale block');
  return cfg.grade_scale;
}

/* ------------------------------------------------------------------ */
/* policy.yaml - the operator's vocabularies                            */
/* ------------------------------------------------------------------ */

export interface LabelSet {
  subject: string;
  subject_plural: string;
  assessor: string;
  assessor_plural: string;
}

/** policy.yaml section 9: the program builder's operator vocabulary. */
export interface ProgramPolicy {
  section_kinds: string[];
  phases: { code: string; label: string }[];
  pf_seats: string[];
}

export interface PolicyConfig {
  version: string;
  labels?: Partial<LabelSet>;
  program?: ProgramPolicy;
  templates?: { element_key_pattern?: string };
  reserved_element_titles?: string[];
  signatures?: {
    statements?: { assessor?: string; subject?: string; subject_by_kind?: Record<string, string> };
    objection?: { allowed?: boolean; label?: string; prompt?: string; marks_record?: string; notifies_role?: string };
  };
  positions: string[];
  instructor_roles: string[];
  assessor_role_codes: string[];
  seats: { subject_roles: string[]; default_subject_role: string; pf_roles: string[]; max_subjects_per_session: number };
  template_kinds: { kind: string; label: string }[];
}

/** The training policy, loose like analyticsConfig: only the vocabularies screens read are typed. */
export function policy(): PolicyConfig {
  return load<PolicyConfig>('policy.yaml');
}

/**
 * The operator's display words. Falls back to the kit's neutral vocabulary when policy.yaml
 * carries no `labels` block, so a screen never renders an empty string.
 */
export function labels(): LabelSet {
  const l = policy().labels ?? {};
  return {
    subject: l.subject ?? 'Subject',
    subject_plural: l.subject_plural ?? 'Subjects',
    assessor: l.assessor ?? 'Assessor',
    assessor_plural: l.assessor_plural ?? 'Assessors',
  };
}

/* ------------------------------------------------------------------ */
/* rules.yaml - the program builder's findings                          */
/* ------------------------------------------------------------------ */

export interface RuleSpecConfig {
  id: string;
  severity: 'block' | 'warn';
  applies_to_kinds?: string[];
  params?: Record<string, unknown>;
  source?: string;
  message: string;
}

export interface RulesConfig {
  version: string;
  rules: RuleSpecConfig[];
}

/** The findings registry. lib/program/rules.ts asserts every id has an implementation. */
export function rules(): RulesConfig {
  const r = load<RulesConfig>('rules.yaml');
  if (!Array.isArray(r.rules)) throw new Error('config/rules.yaml has no rules list');
  return r;
}

/** The signature wording for one template kind, and the objection rule. Neutral fallbacks when policy.yaml is silent. */
export function signatureStatements(templateKind: string | null): { assessor: string; subject: string; subjectExtra: string | null; objection: { allowed: boolean; label: string; prompt: string; marksRecord: string; notifiesRole: string } } {
  const s = policy().signatures ?? {};
  const st = s.statements ?? {};
  const o = s.objection ?? {};
  return {
    assessor: st.assessor ?? 'By signing I confirm that these results were given to the trainee and explained.',
    subject: st.subject ?? 'By signing I confirm that these results were given to me and that I accept them.',
    subjectExtra: templateKind ? st.subject_by_kind?.[templateKind] ?? null : null,
    objection: { allowed: o.allowed ?? true, label: o.label ?? 'Object to the results', prompt: o.prompt ?? 'Say why you do not agree with the results.', marksRecord: o.marks_record ?? 'incomplete', notifiesRole: o.notifies_role ?? 'training_manager' },
  };
}

/** Test seam: forget everything read so far. Never called from a request path. */
export function resetConfigCache(): void {
  cache.clear();
}
