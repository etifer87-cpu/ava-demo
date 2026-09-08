/**
 * TrendSparkline.tsx - docs/07_VISUALISATION.md §5.2 chart 4, §5.11 chart 54.
 *
 * The small-multiple engine. One component renders the on-screen grid and the
 * grid inside the PDF, at different sizes, from the same geometry.
 *
 * Nulls are SKIPPED, never zero-filled, and the line breaks across them: a
 * missing grade plotted at the axis draws a failure that never happened.
 *
 * NO HOOKS. The SVG element ids come from the required `id` prop through
 * chartId(), not from React's id hook, so this is a genuine server component and
 * its markup is byte-identical on the server, in the browser and in the PDF.
 */

import type { ChartTokens } from './chart-tokens';
import { chartId, gradeColour, PAD, xAt, yAt } from './chart-tokens';

export interface SparklinePoint {
  readonly on: string;              // ISO date; used for the end labels only
  readonly value: number | null;
}

export interface TrendSparklineProps {
  /**
   * Required. Namespaces this chart's SVG element ids. In a small-multiple grid - one
   * sparkline per competency - the competency id is the value to pass.
   */
  readonly id: string;
  readonly points: readonly SparklinePoint[];
  readonly tokens: ChartTokens;
  /** The series colour - normally the competency's own colour. */
  readonly colour: string;
  readonly min?: number;
  readonly max?: number;
  readonly width?: number;
  readonly height?: number;
  readonly label: string;
  readonly emptyText?: string;
  /** Printed beside the chart. A direction with no measurement behind it is an assertion. */
  readonly annotation?: string | null;
}

export function TrendSparkline({
  id,
  points,
  tokens,
  colour,
  min = 1,
  max = 5,
  width = 200,
  height = 80,
  label,
  emptyText = 'No data',
  annotation = null,
}: TrendSparklineProps) {
  const uid = chartId(id);
  const n = points.length;
  const valid = points
    .map((p, i) => ({ i, v: p.value }))
    .filter((p): p is { i: number; v: number } => p.v !== null);

  const px = (i: number) => xAt(i, n, width);
  const py = (v: number) => yAt(v, min, max, height);

  const gridValues = Array.from({ length: max - min + 1 }, (_, k) => min + k);

  // Contiguous runs only: the path breaks wherever a value is missing.
  const runs: { i: number; v: number }[][] = [];
  let current: { i: number; v: number }[] = [];
  for (let i = 0; i < n; i += 1) {
    const v = points[i].value;
    if (v === null) {
      if (current.length) runs.push(current);
      current = [];
    } else {
      current.push({ i, v });
    }
  }
  if (current.length) runs.push(current);

  const linePath = (run: { i: number; v: number }[]) =>
    run.map((p, k) => `${k === 0 ? 'M' : 'L'}${px(p.i).toFixed(2)} ${py(p.v).toFixed(2)}`).join(' ');

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

      {gridValues.map((g) => (
        <g key={g}>
          <line
            x1={PAD.left} x2={width - PAD.right}
            y1={py(g)} y2={py(g)}
            stroke={tokens.surface.grid} strokeWidth={0.8}
          />
          <text
            x={PAD.left - 4} y={py(g)}
            fontSize={6} fill={tokens.surface.inkMuted}
            textAnchor="end" dominantBaseline="middle"
          >
            {g}
          </text>
        </g>
      ))}

      {valid.length === 0 && (
        <text
          x={width / 2} y={height / 2}
          fontSize={9} fill={tokens.surface.inkMuted} textAnchor="middle"
        >
          {emptyText}
        </text>
      )}

      {runs.map((run, k) =>
        run.length >= 2 ? (
          <g key={`run-${k}`}>
            <path
              d={`${linePath(run)} L${px(run[run.length - 1].i).toFixed(2)} ${py(min).toFixed(2)} L${px(run[0].i).toFixed(2)} ${py(min).toFixed(2)} Z`}
              fill={colour}
              opacity={0.07}
              stroke="none"
            />
            <path
              d={linePath(run)}
              fill="none"
              stroke={colour}
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </g>
        ) : null,
      )}

      {valid.map((p) => (
        <circle
          key={p.i}
          cx={px(p.i)} cy={py(p.v)} r={2.5}
          // Dot fill is the GRADE colour, not the series colour: the mark carries
          // the value's band while the line carries the competency's identity.
          fill={gradeColour(tokens, Math.round(p.v))}
          stroke={tokens.surface.halo}
          strokeWidth={1}
        />
      ))}

      {/* Only the first and last category labels, so a compact card stays legible. */}
      {n > 0 && valid.length > 0 && (
        <>
          <text
            x={PAD.left} y={height - 4}
            fontSize={6} fill={tokens.surface.inkMuted} textAnchor="start"
          >
            {points[0].on.slice(0, 7)}
          </text>
          <text
            x={width - PAD.right} y={height - 4}
            fontSize={6} fill={tokens.surface.inkMuted} textAnchor="end"
          >
            {points[n - 1].on.slice(0, 7)}
          </text>
        </>
      )}

      {annotation && (
        <text
          x={width - PAD.right} y={PAD.top + 6}
          fontSize={6.5} fill={tokens.surface.ink} textAnchor="end"
        >
          {annotation}
        </text>
      )}
    </svg>
  );
}

export default TrendSparkline;
