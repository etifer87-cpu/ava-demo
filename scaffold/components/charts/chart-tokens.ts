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
  /** The pale wash of the same hue, for a surface behind a mark. Null where the operator set none. */
  readonly tint?: string | null;
  /** The readable ink ON `colour`, resolved from brand.yaml. The PDF gets no stylesheet, so a chart
   *  cannot read --grade-N-ink and is handed the value instead. */
  readonly ink?: string;
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

/** The pale wash for a grade, for a track or a band behind a mark. Falls back to the grid colour. */
export function gradeTint(tokens: ChartTokens, grade: number | null): string {
  if (grade === null) return tokens.surface.grid;
  return tokens.grades.find((g) => g.grade === grade)?.tint ?? tokens.surface.grid;
}

/** The readable ink ON a grade's fill, as resolved by brand.yaml rather than guessed per chart. */
export function gradeInk(tokens: ChartTokens, grade: number | null): string {
  const t = grade === null ? undefined : tokens.grades.find((g) => g.grade === grade);
  return t?.ink ?? onColour(t?.colour ?? tokens.surface.bg, tokens);
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
  const [r = 0, g = 0, b = 0] = parseHex(hex).map((c) => {
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

/* ------------------------------------------------------------------ type */

/**
 * THE TYPE SCALE, IN PIXELS THE ROOM WILL SEE.
 *
 * SVG text is sized in viewBox units, so the same `fontSize` renders at a different apparent size
 * in every chart: apparent px = units × renderedWidthPx ÷ viewBoxWidth. Measured on 2026-09-21 the
 * ratio ran from 1.02 (KPI tile, 220 units in 224px) to 1.80 (radar, 300 units in 541px), which is
 * why the literals scattered through these components produced 9.2px in one chart and 14.6px in
 * another while all reading "9". A single shared number scale would preserve that spread exactly.
 *
 * So the scale is stated in PIXELS and converted per chart from its own measured ratio. Change a
 * number here and every chart moves together in apparent size rather than in units.
 *
 * Each chart passes its own RATIO - rendered pixels per viewBox unit - measured in the browser on
 * 2026-09-21 at a ~1540px window, the shape a demonstration is given in:
 *
 *   PeerCompare        560 units in  550px   0.98
 *   GradeDistribution  560 units in  550px   0.98
 *   KpiTile            220 units in  224px   1.02   (284px on /analytics, so 1.02 is the floor)
 *   AsiHistogram       460 units in  590px   1.28
 *   DeltaScatter       900 units in 1150px   1.28
 *   LeniencyInterval   900 units in 1150px   1.28
 *   TrendSparkline     760 units in 1150px   1.51   (200 units in 360px elsewhere, 1.80)
 *   CompetencyRadar    300 units in  541px   1.80
 *   TwoLineTrend       560 units in 1150px   2.05
 *
 * The ratio, not the width, is what stays put: a chart given a different `width` prop keeps it.
 * Where one component renders at two ratios, the LOWER one is used, which makes CHART_TYPE_PX a
 * floor rather than an exact size - text is never smaller than this, and is larger in a roomier
 * container. That spread is inherent to a viewBox; what was wrong before was that the spread ran
 * from 9.1px to 20.5px with every source file saying "9.5".
 *
 * The floor of 12.5 is what a projector at the back of a training department can still read.
 */
export const CHART_TYPE_PX = {
  /** Tick labels, axis captions, band names - the smallest thing a chart is allowed to print. */
  axis: 12.5,
  /** A number printed on or beside a mark. */
  value: 13.5,
  /** A series or category name; the thing a reader matches against a legend. */
  label: 14.5,
  /** The one figure a tile exists to show. */
  emphasis: 30,
} as const;

export type ChartType = Record<keyof typeof CHART_TYPE_PX, number>;

/**
 * Convert the pixel scale into this chart's viewBox units.
 *
 * @param pxPerUnit rendered pixels per viewBox unit for this chart - the table above
 */
export function chartType(pxPerUnit: number): ChartType {
  const unitsPerPx = 1 / pxPerUnit;
  const at = (px: number) => Math.round(px * unitsPerPx * 10) / 10;
  return {
    axis: at(CHART_TYPE_PX.axis),
    value: at(CHART_TYPE_PX.value),
    label: at(CHART_TYPE_PX.label),
    emphasis: at(CHART_TYPE_PX.emphasis),
  };
}
