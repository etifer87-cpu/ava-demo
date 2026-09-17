/**
 * GradeDistributionBar.tsx - docs/07_VISUALISATION.md §5.4 charts 9 and 10.
 *
 * A 100 per cent stacked bar over the grade scale, optionally DIVERGING about
 * the meets-standard boundary so below-standard mass extends left.
 *
 * Every segment prints its share, so the colour ramp is redundant rather than
 * load-bearing - which is what makes the chart survive greyscale printing and a
 * colour-blind reader.
 *
 * NO HOOKS. The SVG element ids come from the required `id` prop through
 * chartId(), not from React's id hook, so this is a genuine server component and
 * its markup is byte-identical on the server, in the browser and in the PDF.
 */

import type { ChartTokens } from './chart-tokens';
import { chartId, gradeColour, onColour } from './chart-tokens';

export interface GradeCount {
  readonly grade: number;
  readonly count: number;
}

export interface GradeDistributionBarProps {
  /**
   * Required. Namespaces this chart's SVG element ids. A stack of these - one row per
   * competency - passes the competency id, so no two rows collide.
   */
  readonly id: string;
  readonly counts: readonly GradeCount[];
  readonly tokens: ChartTokens;
  readonly width?: number;
  readonly height?: number;
  readonly label: string;
  /** Draw below-standard mass to the left of a centred zero line. */
  readonly diverging?: boolean;
  /** Grades at or below this are "below standard". From config; never a literal here. */
  readonly belowStandardMax: number;
  /** Render at reduced emphasis - used for the peer bar so the subject reads as primary. */
  readonly secondary?: boolean;
  readonly minN?: number;
  readonly emptyText?: string;
}

export function GradeDistributionBar({
  id,
  counts,
  tokens,
  width = 480,
  height = 34,
  label,
  diverging = false,
  belowStandardMax,
  secondary = false,
  minN,
  emptyText = 'No data',
}: GradeDistributionBarProps) {
  const uid = chartId(id);
  // Only finite numbers are counted. A caller that hands over a row whose count is undefined or
  // NaN gets the empty state, not a bar of NaN-wide rectangles: a chart must never render a
  // number it cannot compute, and an SVG with width="NaN" draws nothing while looking like a bug
  // in the data rather than in the call.
  const total = counts.reduce((a, c) => a + (Number.isFinite(c.count) ? c.count : 0), 0);

  if (!(total > 0)) {
    return (
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label={label}
           style={{ display: 'block', background: tokens.surface.bg }} fontFamily={tokens.fontStack}>
        <rect x={0} y={4} width={width} height={height - 8} fill="none" stroke={tokens.surface.border} />
        <text x={width / 2} y={height / 2} fontSize={11} fill={tokens.surface.inkMuted}
              textAnchor="middle" dominantBaseline="middle">{emptyText}</text>
      </svg>
    );
  }

  // Insufficient is a distinct state from empty: the bar is not drawn, and the
  // sample size is printed rather than a percentage nobody should read.
  if (minN !== undefined && total < minN) {
    return (
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label={`${label}: insufficient`}
           style={{ display: 'block', background: tokens.surface.bg }} fontFamily={tokens.fontStack}>
        <rect x={0} y={4} width={width} height={height - 8} fill="none"
              stroke={tokens.surface.border} strokeDasharray="3 3" />
        <text x={width / 2} y={height / 2} fontSize={11} fill={tokens.surface.inkMuted}
              textAnchor="middle" dominantBaseline="middle">{`insufficient (n=${total})`}</text>
      </svg>
    );
  }

  const sorted = [...counts].filter((c) => Number.isFinite(c.count) && Number.isFinite(c.grade)).sort((a, b) => a.grade - b.grade);
  const belowShare = sorted
    .filter((c) => c.grade <= belowStandardMax)
    .reduce((a, c) => a + c.count, 0) / total;

  // In diverging mode the boundary between below-standard and meets-standard is
  // pinned to the centre, so bars are comparable at a glance across rows.
  const originX = diverging ? width * 0.5 : 0;
  const startX = diverging ? originX - belowShare * width : 0;

  let cursor = startX;
  const segments = sorted.map((c) => {
    const share = c.count / total;
    const w = share * width;
    const seg = { ...c, share, x: cursor, w };
    cursor += w;
    return seg;
  });

  const barTop = 4;
  const barH = height - 8 - (diverging ? 8 : 0);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      role="img"
      aria-labelledby={`${uid}-title`}
      style={{ display: 'block', maxWidth: '100%', background: tokens.surface.bg }}
      fontFamily={tokens.fontStack}
    >
      <title id={`${uid}-title`}>{label}</title>

      {segments.map((s) => {
        const fill = gradeColour(tokens, s.grade);
        const ink = onColour(fill, tokens);
        return (
          <g key={s.grade}>
            <rect
              x={s.x} y={barTop} width={Math.max(s.w, 0)} height={barH}
              fill={fill}
              // The peer bar is quietened by opacity rather than by a different
              // palette, so the two bars stay directly comparable.
              opacity={secondary ? 0.45 : 1}
            />
            {s.w > 26 && (
              <text
                x={s.x + s.w / 2} y={barTop + barH / 2}
                fontSize={9} fill={ink} textAnchor="middle" dominantBaseline="middle"
              >
                {`${s.grade} · ${(s.share * 100).toFixed(0)}%`}
              </text>
            )}
          </g>
        );
      })}

      {diverging && (
        <>
          <line
            x1={originX} x2={originX} y1={0} y2={barTop + barH + 2}
            stroke={tokens.surface.ink} strokeWidth={1}
          />
          <text
            x={originX} y={height - 1}
            fontSize={7} fill={tokens.surface.inkMuted} textAnchor="middle"
          >
            meets standard
          </text>
        </>
      )}
    </svg>
  );
}

export default GradeDistributionBar;
