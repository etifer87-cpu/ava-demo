/**
 * components/charts/chart-tokens.ts
 *
 * The ONLY place a chart colour is resolved. docs/07_VISUALISATION.md §3.
 *
 * Colours come from data, never from literals in a component:
 *   - competency colours from `competencies.colour` (docs/03 §2), so a rebrand
 *     or a framework edit is an UPDATE rather than a code change;
 *   - grade colours from the grade scale (docs/03 §4);
 *   - band and surface colours from the design tokens.
 * A hex literal inside a chart component is a defect.
 *
 * Pure and server-renderable: no CSS custom properties are read at runtime,
 * because the PDF renderer receives no stylesheet. Every colour is resolved to a
 * concrete value here and written into the SVG as a presentation attribute.
 */

export interface CompetencyToken {
  readonly competencyId: string;
  readonly code: string;        // the redundant channel: printed wherever colour encodes series
  readonly name: string;
  readonly colour: string;
}

export interface GradeToken {
  readonly grade: number;
  readonly colour: string;
  readonly label: string;
}

export interface ChartTokens {
  readonly competencies: readonly CompetencyToken[];
  readonly grades: readonly GradeToken[];
  readonly bands: Readonly<Record<'green' | 'amber' | 'red' | 'neutral' | 'muted', string>>;
  readonly surface: {
    readonly bg: string;
    readonly ink: string;
    readonly inkMuted: string;
    readonly grid: string;
    readonly border: string;
    readonly halo: string;      // dot outline, so a mark stays legible over a fill
  };
  readonly series: {
    readonly primary: string;   // the subject
    readonly secondary: string; // the peer group - deliberately quieter
    readonly secondaryFill: string;
  };
  readonly fontStack: string;
}

/** Looks up a competency colour by id. Never by name: a name is not a key. */
export function competencyColour(tokens: ChartTokens, competencyId: string): string {
  return (
    tokens.competencies.find((c) => c.competencyId === competencyId)?.colour ??
    tokens.surface.inkMuted
  );
}

export function competencyCode(tokens: ChartTokens, competencyId: string): string {
  return tokens.competencies.find((c) => c.competencyId === competencyId)?.code ?? '';
}

/** Grade colour by value. An out-of-scale value renders muted rather than throwing in a render path. */
export function gradeColour(tokens: ChartTokens, grade: number | null): string {
  if (grade === null) return tokens.surface.inkMuted;
  return tokens.grades.find((g) => g.grade === grade)?.colour ?? tokens.surface.inkMuted;
}

/**
 * Readable ink for text drawn on a filled mark. Relative luminance per WCAG,
 * so a competency colour swapped by an operator still yields legible labels.
 */
export function onColour(background: string, tokens: ChartTokens): string {
  return relativeLuminance(background) > 0.45 ? tokens.surface.ink : '#FFFFFF';
}

/** Contrast ratio, for the seeder's colour check and for tests. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

/**
 * Builds the token set from framework rows and grade-scale rows.
 * Called on the server, once per render, and passed down as a prop. Components
 * never build their own tokens: two builders would drift.
 */
export function buildChartTokens(input: {
  competencies: readonly CompetencyToken[];
  grades: readonly GradeToken[];
}): ChartTokens {
  return {
    competencies: input.competencies,
    grades: input.grades,
    bands: {
      green: '#15803D',
      amber: '#B45309',
      red: '#B91C1C',
      neutral: '#334155',
      muted: '#94A3B8',
    },
    surface: {
      bg: '#FFFFFF',
      ink: '#0F172A',
      inkMuted: '#64748B',
      grid: '#E2E8F0',
      border: '#CBD5E1',
      halo: '#FFFFFF',
    },
    series: {
      primary: '#0F172A',
      secondary: '#94A3B8',
      secondaryFill: 'rgba(148,163,184,0.16)',
    },
    // Ends in a generic family: the PDF renderer loads no web font.
    fontStack: 'ui-sans-serif, system-ui, "Segoe UI", Helvetica, Arial, sans-serif',
  };
}

/** Shared cartesian geometry. docs/07 §6. */
export const PAD = { left: 22, right: 8, top: 8, bottom: 20 } as const;

export function plotBox(width: number, height: number) {
  return {
    innerW: width - PAD.left - PAD.right,
    innerH: height - PAD.top - PAD.bottom,
  };
}

export function xAt(i: number, n: number, width: number): number {
  const innerW = width - PAD.left - PAD.right;
  return PAD.left + (n > 1 ? (i / (n - 1)) * innerW : innerW / 2);
}

export function yAt(value: number, lo: number, hi: number, height: number): number {
  const innerH = height - PAD.top - PAD.bottom;
  const span = hi - lo || 1;
  return PAD.top + innerH - ((value - lo) / span) * innerH;
}

/**
 * Deterministic element id for an SVG's internal references (`<title>`, gradients, clip paths).
 *
 * WHY THIS IS NOT `useId`. `useId` is a hook, and a hook cannot run in a React server component.
 * The chart components are documented as renderable in the browser AND inside the PDF renderer,
 * which means they must be server components; a hook in one of them turns every server page that
 * imports it into a render-time error, and the workaround - wrapping them in a client boundary -
 * quietly makes the whole chart set client-only.
 *
 * So the id is a REQUIRED PROP instead. The caller owns it, which also makes the SVG markup stable
 * across renders: the same subject page produces byte-identical ids on the server, in the browser
 * and in the PDF, so the two outputs can be diffed against each other. Two charts on one page must
 * be given two different `id` values; that is the caller's job and it is the only rule.
 *
 * The value is slugified rather than trusted, because an id reaches the DOM and an unescaped one
 * from a database column would not survive `getElementById` or a `url(#...)` reference.
 */
export function chartId(id: string): string {
  const slug = String(id)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) {
    throw new Error(
      'chart id prop is required and must contain at least one alphanumeric character. It ' +
        'namespaces the SVG element ids, so two charts on one page need two different values.',
    );
  }
  return `c-${slug}`;
}
