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
  product: { name: string; short_name: string; environment_label: string; vendor_line?: string };
  logo: { path: string; alt: string; height_px: number };
  colour: { light: ColourSet; dark: ColourSet };
  state: { light: StateSet; dark: StateSet };
  grade_palette: Record<string, { colour: string; tint?: string; label: string }>;
  /** One ink for every grade numeral. Absent: each is chosen by luminance instead. */
  grade_ink?: string;
  /** Keyed by policy.yaml program.phases codes; emitted as --phase-<code>. Optional. */
  phase_palette?: Record<string, { colour: string; label?: string }>;
  average_bands?: { from: number; colour: string; label?: string }[];
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
/**
 * The readable ink for text drawn ON a fill. WCAG relative luminance, the same rule
 * components/charts/chart-tokens.ts applies to a label on a mark - stated once here for CSS and
 * once there for SVG because the PDF renderer receives no stylesheet and cannot read a custom
 * property. A malformed colour falls back to the dark ink rather than throwing in a render path.
 */
function readableInk(hex: string, b: BrandConfig): string {
  // An operator who states one ink for the whole ramp gets it, unmeasured and unargued with; the
  // measurement lives beside the key in brand.yaml so the choice is made with the numbers in view.
  if (typeof b.grade_ink === 'string' && b.grade_ink.trim() !== '') return b.grade_ink.trim();
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return b.colour.light.ink;
  const n = parseInt(m[1]!, 16);
  const channel = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
  return lum > 0.45 ? b.colour.light.ink : '#FFFFFF';
}

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

  // --grade-1 .. --grade-5 from grade_palette, so a CLIENT component can colour a grade without
  // being handed the palette as a prop. The numeral is always rendered beside the colour; nothing
  // encodes a grade by colour alone (brand.yaml says so above the palette).
  //
  // Each colour also gets a --grade-N-INK: the readable ink FOR that fill, chosen here rather than
  // stated in the YAML, so an operator who changes a grade colour cannot leave a numeral unreadable
  // on it. It is the rule components/charts/chart-tokens.ts already uses for text on a mark - WCAG
  // relative luminance - and it matters: white on the 2026-09-17 grade 2 is 1.40:1, an invisible
  // digit, while dark ink on it is 12.71:1.
  const gradeVars = Object.entries(b.grade_palette ?? {})
    .filter(([g, v]) => /^[0-9]{1,2}$/.test(g) && typeof v?.colour === 'string')
    .flatMap(([g, v]) => [
      `--grade-${g}:${v.colour}`,
      `--grade-${g}-ink:${readableInk(v.colour, b)}`,
      ...(v.tint ? [`--grade-${g}-tint:${v.tint}`] : []),
    ])
    .join(';');

  const light = `:root{${vars(b.colour.light, b.state.light)};${shape}${phases ? `;${phases}` : ''}${gradeVars ? `;${gradeVars}` : ''}}`;
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

/** A competency's compact display name where space is tight; the full framework name otherwise. */
export function competencyDisplayName(code: string, fullName: string, p: PolicyConfig = policy()): string {
  return p.competency_display_names?.[code] ?? fullName;
}

/** The colour an average grade (a mean, 1-5) is shown in: the band whose lower bound it reaches. */
/** One template kind as policy.yaml declares it. */
export type TemplateKind = PolicyConfig['template_kinds'][number];

/** The kind by code, or null. The vocabulary is configuration; nothing here hardcodes a member. */
export function templateKind(kind: string | null | undefined, p: PolicyConfig = policy()): TemplateKind | null {
  return p.template_kinds.find((k) => k.kind === kind) ?? null;
}

/**
 * The template kinds the operator marks `is_check` in policy.yaml - the checks, as opposed to
 * training. Read by the instructor check-versus-training comparison, so nothing splits a population
 * by matching on a label.
 */
export function checkKinds(p: PolicyConfig = policy()): string[] {
  return p.template_kinds.filter((k) => k.is_check).map((k) => k.kind);
}

/**
 * The outcome values that READ as a failure, from policy.yaml `grading.outcomes` and
 * `outcome_equivalents`: 'FAIL' itself plus anything the operator maps to it (NOT PROFICIENT in EBT
 * vocabulary). PARTIAL PASS is deliberately absent - the config says it is never folded into either
 * side, so a surface that needs a pass/fail reading of it must ask, not assume.
 */
export function failOutcomes(p: PolicyConfig = policy()): string[] {
  const eq = p.grading?.outcome_equivalents ?? {};
  const mapped = Object.entries(eq).filter(([, v]) => String(v).toUpperCase() === 'FAIL').map(([k]) => k);
  return [...new Set(['FAIL', ...mapped])];
}

/**
 * The pair of tokens a non-numeric grading mode stores, [meets standard, below standard], from
 * `policy.yaml grading`. `task_pass_fail_values` for a `pass_fail` task element,
 * `competency_binary_values` for a `competent_not_competent` competency. A surface asks for the
 * pair; nothing writes PASS or C as a literal.
 */
export function gradeTokens(which: 'task_pass_fail' | 'competency_binary', p: PolicyConfig = policy()): readonly [string, string] {
  const key = which === 'task_pass_fail' ? 'task_pass_fail_values' : 'competency_binary_values';
  const list = p.grading?.[key] ?? [];
  const [ok, not] = list;
  if (!ok || !not) throw new Error(`policy.yaml grading.${key} must name two values, [meets standard, below standard]`);
  return [ok, not];
}

export interface LeniencyZone { to: number | null; colour: string; label: string }

/**
 * brand.yaml `leniency_zones`, innermost first, with `to` as a multiple of the outlier threshold.
 * Returns an empty list when none is configured, so a chart draws no zones rather than guessing
 * where the boundaries are.
 */
export function leniencyZones(b: BrandConfig = brand()): LeniencyZone[] {
  const z = (b as unknown as { leniency_zones?: LeniencyZone[] }).leniency_zones ?? [];
  return [...z].sort((x, y) => (x.to ?? Number.POSITIVE_INFINITY) - (y.to ?? Number.POSITIVE_INFINITY));
}

export interface ResidualScale { lenient: string; strict: string; neutral: string; full: number }

/**
 * brand.yaml `residual_scale`: the two ends of the diverging tint the bias heatmap uses, and the
 * difference at which the tint saturates. Returns null when the operator has not defined one, so a
 * surface can fall back to printing numbers with no colour rather than inventing a palette.
 */
export function residualScale(b: BrandConfig = brand()): ResidualScale | null {
  const s = (b as unknown as { residual_scale?: ResidualScale }).residual_scale;
  return s && s.lenient && s.strict ? { ...s, full: s.full || 0.75 } : null;
}

export function averageBand(mean: number | null, b: BrandConfig = brand()): { colour: string; label: string } | null {
  if (mean === null || !Number.isFinite(mean)) return null;
  const bands = [...(b.average_bands ?? [])].sort((x, y) => x.from - y.from);
  let hit: { from: number; colour: string; label?: string } | null = null;
  for (const band of bands) if (mean + 1e-9 >= band.from) hit = band;
  return hit ? { colour: hit.colour, label: hit.label ?? '' } : null;
}

/** Grade colours for the chart token builder. Keyed by the numeric grade, sorted ascending. */
export function gradePalette(b: BrandConfig = brand()): { grade: number; colour: string; tint: string | null; ink: string; label: string }[] {
  return Object.entries(b.grade_palette)
    .map(([grade, v]) => ({ grade: Number(grade), colour: v.colour, tint: v.tint ?? null, ink: readableInk(v.colour, b), label: v.label }))
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
  /** See config/analytics.yaml. Optional so a config written before 2026-09-16 still loads. */
  outcome_standard?: { warn_at: number; refuse_pass_grade: number; refuse_pass_at: number };
  code_meanings?: Record<string, string>;
} {
  const cfg = analyticsConfig<{ grade_scale: ReturnType<typeof gradeScale> }>();
  if (!cfg.grade_scale) throw new Error('config/analytics.yaml has no grade_scale block');
  return cfg.grade_scale;
}

/**
 * The non-scoring code that means one particular thing, from
 * `analytics.yaml grade_scale.code_meanings` - `notScoringCode('not_observed')` is how a surface
 * stores "not observed" without writing NO into a column. Throws when the meaning is not named or
 * names a code outside `non_scoring`: a silent fallback would put an unparseable value in a grade
 * column, which lib/grades.ts counts as a data-quality fault rather than a code.
 */
export function nonScoringCode(meaning: string, scale = gradeScale()): string {
  const code = (scale.code_meanings ?? {})[meaning];
  if (!code) throw new Error(`analytics.yaml grade_scale.code_meanings has no ${meaning}`);
  if (!scale.non_scoring.includes(code)) throw new Error(`grade_scale.code_meanings.${meaning} = ${code}, which is not in non_scoring`);
  return code;
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
  grading?: {
    outcomes?: string[];
    outcome_equivalents?: Record<string, string>;
    target_grade?: number;
    task_pass_fail_values?: string[];
    competency_binary_values?: string[];
  };
  competency_display_names?: Record<string, string>;
  training_status?: { warning_days: number; items: { key: string; label: string; kind: string; validity_months: number }[]; stages: Record<string, string>; check_stages?: string[]; released_label?: string; board?: { finishing_days: number } };
  positions: string[];
  instructor_roles: string[];
  assessor_role_codes: string[];
  seats: { subject_roles: string[]; default_subject_role: string; pf_roles: string[]; max_subjects_per_session: number };
  template_kinds: { kind: string; label: string; is_check?: boolean; check_options?: string[]; facility_kind?: string; fan_out_on_signature?: boolean; supports_attempts?: boolean }[];
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
export function signatureStatements(kindCode: string | null): { assessor: string; subject: string; subjectExtra: string | null; objection: { allowed: boolean; label: string; prompt: string; marksRecord: string; notifiesRole: string } } {
  const s = policy().signatures ?? {};
  const st = s.statements ?? {};
  const o = s.objection ?? {};
  return {
    assessor: st.assessor ?? 'By signing I confirm that these results were given to the trainee and explained.',
    subject: st.subject ?? 'By signing I confirm that these results were given to me and that I accept them.',
    subjectExtra: kindCode ? st.subject_by_kind?.[kindCode] ?? null : null,
    objection: { allowed: o.allowed ?? true, label: o.label ?? 'Object to the results', prompt: o.prompt ?? 'Say why you do not agree with the results.', marksRecord: o.marks_record ?? 'incomplete', notifiesRole: o.notifies_role ?? 'training_manager' },
  };
}

/** Test seam: forget everything read so far. Never called from a request path. */
export function resetConfigCache(): void {
  cache.clear();
}
