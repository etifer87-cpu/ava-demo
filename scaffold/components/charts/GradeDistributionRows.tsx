/**
 * GradeDistributionRows.tsx - the population grade distribution, one bar per grade.
 *
 * WHY NOT THE 100 PER CENT STACKED BAR (GradeDistributionBar, which this took the last caller of -
 * it is kept because it does the diverging subject-against-peer comparison this one does not).
 * A stacked bar answers "what is the mix"; this answers "how many sat at each grade", and on a
 * roster of five hundred pilots those are different questions with different failure modes. In the
 * stacked form the two grades anybody actually asks about - the 1s and the 2s - are a pair of
 * slivers a few pixels wide, too narrow to carry their own label, while 3 and 4 fill the bar. One
 * baseline per grade fixes that: a 1.6 per cent bar is still a bar with a number beside it.
 *
 * COLOUR IS REDUNDANT HERE, DELIBERATELY. The grade palette is an ordered 1-5 hue ramp, and its
 * adjacent pairs are close: measured against the colour-vision checks, grade 3 against grade 4 is
 * dE 4.5 to normal vision and 3.3 under protanopia. Re-stepping the ramp only moves the problem to
 * 1 against 2. So colour is never load-bearing on this chart - every row prints the numeral, the
 * operator's word for it, the count and the share, which is what brand.yaml says the grade palette
 * is for. The chart survives greyscale, a colour-blind reader and a fax.
 *
 * NO HOOKS and NO ELEMENT IDS: every colour is resolved to a concrete value here, so this renders
 * identically on the server, in the browser and in the PDF, which receives no stylesheet - and it
 * can be rendered twice on one page (inline and enlarged) without two copies colliding.
 */

import type { ChartTokens } from './chart-tokens';
import { gradeColour, gradeInk, gradeTint } from './chart-tokens';
import { chartType } from './chart-tokens';

export interface GradeRowCount {
  readonly grade: number;
  readonly count: number;
}

export interface GradeDistributionRowsProps {
  readonly id: string;
  readonly counts: readonly GradeRowCount[];
  readonly tokens: ChartTokens;
  /**
   * Rendered pixels per viewBox unit, for the type scale. Defaults to the measured inline
   * ratio; an enlarged copy in a dialog has a different one and must pass it. See
   * CHART_TYPE_PX.
   */
  readonly pxPerUnit?: number;
  /** The operator's word for each grade, from brand.yaml. Absent is fine; the numeral carries it. */
  readonly gradeLabels?: Readonly<Record<number, string>>;
  readonly min: number;
  readonly max: number;
  /** Grades at or below this are below standard. From config; never a literal here. */
  readonly belowStandardMax: number;
  readonly label: string;
  readonly emptyText?: string;
  /**
   * When present, each row becomes a link to `${hrefForGrade(grade)}`, and `selectedGrade` draws the
   * chosen row as chosen. A PLAIN SVG <a>, deliberately: these links carry a query string on the
   * SAME route, and Next's <Link> keys its client cache by route rather than by search params, so a
   * <Link> here would be a cache hit and the row would read as dead. Same fix as the grading
   * screen's pilot tabs and the analysis run list.
   */
  readonly hrefForGrade?: (grade: number) => string;
  readonly selectedGrade?: number | null;
}

const ROW = 30;
const GAP = 4;
const W = 560;
const X_NUM = 0;
const X_WORD = 26;
const X_BAR = 168;
const BAR_W = 250;
const X_COUNT = 470;
const X_PCT = 556;

export function GradeDistributionRows({
  id, counts, tokens, gradeLabels, min, max, belowStandardMax, label,
  pxPerUnit = 0.98,
  emptyText = 'No competency grade has been recorded in this window.',
  hrefForGrade, selectedGrade = null,
}: GradeDistributionRowsProps) {
  const byGrade = new Map(counts.filter((c) => Number.isFinite(c.count)).map((c) => [c.grade, c.count]));
  // Every grade on the scale gets a row, including the ones nobody awarded. A missing 1 is a
  // finding - "nobody has been graded 1 in twelve months" - and a chart that simply omits the row
  // makes that invisible, which is the same defect as drawing a gap in a trend as a zero.
  const grades: number[] = [];
  for (let g = max; g >= min; g -= 1) grades.push(g);

  const total = grades.reduce((a, g) => a + (byGrade.get(g) ?? 0), 0);
  // Measured 2026-09-21: 560 units render in 550px. Declared before the empty-state return below,
  // which also prints text. See CHART_TYPE_PX.
  const FS = chartType(pxPerUnit);
  if (!(total > 0)) {
    return (
      <svg viewBox={`0 0 ${W} 40`} width="100%" role="img" aria-label={label}
           style={{ display: 'block', background: tokens.surface.bg }} fontFamily={tokens.fontStack}>
        <rect x={0} y={4} width={W} height={32} fill="none" stroke={tokens.surface.border} />
        <text x={W / 2} y={20} fontSize={FS.label} fill={tokens.surface.inkMuted}
              textAnchor="middle" dominantBaseline="middle">{emptyText}</text>
      </svg>
    );
  }

  const peak = Math.max(...grades.map((g) => byGrade.get(g) ?? 0));
  const below = grades.filter((g) => g <= belowStandardMax).reduce((a, g) => a + (byGrade.get(g) ?? 0), 0);
  const mean = grades.reduce((a, g) => a + g * (byGrade.get(g) ?? 0), 0) / total;
  const pct = (n: number) => (n / total) * 100;
  // One decimal below ten per cent, none above: 1.6% is a different claim from 2%, and 47.8% is
  // not a more precise claim than 48%.
  const showPct = (n: number) => { const v = pct(n); return v < 10 ? `${v.toFixed(1)}%` : `${Math.round(v)}%`; };
  const num = (n: number) => n.toLocaleString('en-GB');

  // The rule sits between the last meeting grade and the first below-standard one.
  const splitAfter = grades.findIndex((g) => g <= belowStandardMax);
  const RULE = 22;
  const height = grades.length * (ROW + GAP) + (splitAfter > 0 ? RULE : 0) + 34;
  const yOf = (i: number) => i * (ROW + GAP) + (splitAfter > 0 && i >= splitAfter ? RULE : 0);

  return (
    <svg viewBox={`0 0 ${W} ${height}`} width="100%" role="img" aria-label={label}
         style={{ display: 'block', background: tokens.surface.bg }} fontFamily={tokens.fontStack}>
      {grades.map((g, i) => {
        const n = byGrade.get(g) ?? 0;
        const y = yOf(i);
        const w = peak > 0 ? (n / peak) * BAR_W : 0;
        const colour = gradeColour(tokens, g);
        const word = gradeLabels?.[g];
        const chosen = selectedGrade === g;
        const body = (
          <g>
            {/* ONE string child. React puts a comment node between adjacent text children on the
                server, the browser's SVG parser drops it, and hydration fails on the difference -
                the trap LeniencyInterval documents at the top of its file and this had walked
                straight into. Build the sentence in JS, interpolate once. */}
            <title>
              {`Grade ${g}${word ? `, ${word}` : ''}: ${num(n)} grades, ${showPct(n)} of ${num(total)}`
                + (hrefForGrade ? ' \u2014 open to see which competencies' : '')}
            </title>
            {chosen ? (
              <rect x={-4} y={y + 2} width={W + 8} height={ROW - 4} rx={4}
                    fill="none" stroke={tokens.surface.border} />
            ) : null}
            <rect x={X_NUM} y={y + 6} width={18} height={18} rx={3} fill={colour} />
            {/* The ink comes from the palette, not from a literal: white on some grades in this
                ramp is 2.15:1. brand.yaml resolves it; the chart is handed the answer because the
                PDF renderer cannot read a CSS custom property. */}
            <text x={X_NUM + 9} y={y + 15.5} fontSize={FS.label} fontWeight={700} fill={gradeInk(tokens, g)}
                  textAnchor="middle" dominantBaseline="middle">{g}</text>
            {word ? (
              <text x={X_WORD} y={y + 15.5} fontSize={FS.label} fill={tokens.surface.ink} dominantBaseline="middle">{word}</text>
            ) : null}
            {/* The track shows what the bar is a share OF, so a short bar reads as small rather than
                as a rendering accident. */}
            {/* The track is the grade's own pale wash, so a short bar still reads as "of this row"
                rather than floating in neutral grey. */}
            <rect x={X_BAR} y={y + 9} width={BAR_W} height={12} rx={3} fill={gradeTint(tokens, g)}
                  stroke={tokens.surface.border} strokeWidth={0.5} />
            {n > 0 ? <rect x={X_BAR} y={y + 9} width={Math.max(2, w)} height={12} rx={3} fill={colour} /> : null}
            <text x={X_COUNT} y={y + 15.5} fontSize={FS.label} fill={tokens.surface.ink} textAnchor="end"
                  dominantBaseline="middle" fontFamily={tokens.fontStack}>{num(n)}</text>
            <text x={X_PCT} y={y + 15.5} fontSize={FS.label} fill={n === 0 ? tokens.surface.inkMuted : tokens.surface.ink}
                  textAnchor="end" dominantBaseline="middle">{n === 0 ? 'none' : showPct(n)}</text>
          </g>
        );
        /* A row with no grades is not a link: there is nothing behind it to open, and a link that
           leads to an empty panel teaches people not to click the ones that do. */
        return hrefForGrade && n > 0
          ? <a key={g} href={hrefForGrade(g)} style={{ cursor: 'pointer' }}>{body}</a>
          : <g key={g}>{body}</g>;
      })}

      {splitAfter > 0 ? (
        <g>
          <line x1={0} x2={W} y1={yOf(splitAfter) - RULE / 2} y2={yOf(splitAfter) - RULE / 2}
                stroke={tokens.surface.border} strokeDasharray="3 3" />
          <rect x={0} y={yOf(splitAfter) - RULE / 2 - 8} width={126} height={16} fill={tokens.surface.bg} />
          <text x={0} y={yOf(splitAfter) - RULE / 2} fontSize={FS.axis} fill={tokens.surface.inkMuted}
                dominantBaseline="middle">below standard, {num(below)} · {showPct(below)}</text>
        </g>
      ) : null}

      <text x={0} y={height - 8} fontSize={FS.axis} fill={tokens.surface.inkMuted}>
        {num(total)} competency grades · mean {mean.toFixed(2)} · {num(below)} at or under {belowStandardMax}
      </text>
      <desc>
        {grades.map((g) => `Grade ${g}: ${num(byGrade.get(g) ?? 0)} (${showPct(byGrade.get(g) ?? 0)})`).join('. ')}
      </desc>
    </svg>
  );
}

export default GradeDistributionRows;
