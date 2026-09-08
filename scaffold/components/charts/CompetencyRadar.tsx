/**
 * CompetencyRadar.tsx - docs/07_VISUALISATION.md §5.1 chart 1, §5.4 chart 11.
 *
 * Hand-written SVG. No charting library, no canvas, no client-only API, so the
 * identical component renders in the browser and inside the PDF renderer.
 *
 * SPOKE COUNT COMES FROM THE DATA. Nothing here assumes nine competencies:
 * adding a tenth to the framework adds a tenth spoke with no code change.
 *
 * NO HOOKS. The SVG element ids come from the required `id` prop through
 * chartId(), not from React's id hook, so this is a genuine server component and
 * its markup is byte-identical on the server, in the browser and in the PDF.
 */

import type { ChartTokens } from './chart-tokens';
import { chartId, competencyColour, gradeColour, PAD } from './chart-tokens';

export interface RadarSeries {
  readonly key: string;
  readonly label: string;
  /** Value per competency, in the same order as `competencies`. null = no data. */
  readonly values: readonly (number | null)[];
  readonly emphasis: 'primary' | 'secondary';
}

export interface CompetencyRadarProps {
  /**
   * Required. Namespaces this chart's SVG element ids. Two radars on one page need two
   * different values; a page rendering one radar per subject uses the subject id.
   */
  readonly id: string;
  readonly competencies: readonly { competencyId: string; code: string; name: string }[];
  readonly series: readonly RadarSeries[];
  readonly tokens: ChartTokens;
  readonly min?: number;
  readonly max?: number;
  readonly size?: number;
  /** Required: becomes the accessible name. */
  readonly label: string;
  readonly emptyText?: string;
  /** Colour the vertices by grade band. The numeral is printed regardless. */
  readonly colourVerticesByGrade?: boolean;
}

export function CompetencyRadar({
  id,
  competencies,
  series,
  tokens,
  min = 1,
  max = 5,
  size = 320,
  label,
  emptyText = 'No data',
  colourVerticesByGrade = true,
}: CompetencyRadarProps) {
  const uid = chartId(id);
  const n = competencies.length;
  const cx = size / 2;
  const cy = size / 2;
  const radius = size / 2 - Math.max(PAD.left, PAD.bottom) - 14;

  const hasAny = series.some((s) => s.values.some((v) => v !== null));

  // Angles derive from n, so the shape is correct for any framework size.
  const angle = (i: number) => (Math.PI * 2 * i) / n - Math.PI / 2;
  const point = (i: number, value: number) => {
    const r = ((value - min) / (max - min || 1)) * radius;
    return { x: cx + r * Math.cos(angle(i)), y: cy + r * Math.sin(angle(i)) };
  };

  const rings = Array.from({ length: max - min + 1 }, (_, k) => min + k);

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      width="100%"
      role="img"
      aria-labelledby={`${uid}-title`}
      style={{ maxWidth: '100%', display: 'block', background: tokens.surface.bg }}
      fontFamily={tokens.fontStack}
    >
      <title id={`${uid}-title`}>{label}</title>

      {rings.map((ringValue) => (
        <polygon
          key={ringValue}
          points={competencies
            .map((_, i) => {
              const p = point(i, ringValue);
              return `${p.x.toFixed(2)},${p.y.toFixed(2)}`;
            })
            .join(' ')}
          fill="none"
          stroke={tokens.surface.grid}
          strokeWidth={0.8}
        />
      ))}

      {competencies.map((c, i) => {
        const outer = point(i, max);
        const labelPos = {
          x: cx + (radius + 12) * Math.cos(angle(i)),
          y: cy + (radius + 12) * Math.sin(angle(i)),
        };
        return (
          <g key={c.competencyId}>
            <line
              x1={cx} y1={cy} x2={outer.x} y2={outer.y}
              stroke={tokens.surface.grid} strokeWidth={0.8}
            />
            {/* The competency CODE labels the spoke: colour never carries the identity alone. */}
            <text
              x={labelPos.x}
              y={labelPos.y}
              fontSize={9}
              fill={competencyColour(tokens, c.competencyId)}
              textAnchor={labelPos.x > cx + 2 ? 'start' : labelPos.x < cx - 2 ? 'end' : 'middle'}
              dominantBaseline="middle"
            >
              {c.code}
            </text>
          </g>
        );
      })}

      {!hasAny && (
        <text x={cx} y={cy} fontSize={11} fill={tokens.surface.inkMuted} textAnchor="middle">
          {emptyText}
        </text>
      )}

      {hasAny &&
        series.map((s) => {
          const pts = competencies.map((_, i) => ({ i, v: s.values[i] }));
          // Nulls are skipped, never zero-filled: a missing grade drawn at the
          // axis reads as the worst possible outcome.
          const drawable = pts.filter((p) => p.v !== null);
          if (drawable.length < 3) return null;
          const isPrimary = s.emphasis === 'primary';
          const stroke = isPrimary ? tokens.series.primary : tokens.series.secondary;
          return (
            <g key={s.key}>
              <polygon
                points={drawable
                  .map((p) => {
                    const q = point(p.i, p.v as number);
                    return `${q.x.toFixed(2)},${q.y.toFixed(2)}`;
                  })
                  .join(' ')}
                fill={isPrimary ? 'rgba(15,23,42,0.10)' : tokens.series.secondaryFill}
                stroke={stroke}
                strokeWidth={isPrimary ? 1.6 : 1.2}
                strokeLinejoin="round"
              />
              {isPrimary &&
                drawable.map((p) => {
                  const q = point(p.i, p.v as number);
                  const fill = colourVerticesByGrade
                    ? gradeColour(tokens, Math.round(p.v as number))
                    : stroke;
                  return (
                    <g key={p.i}>
                      <circle
                        cx={q.x} cy={q.y} r={3.2}
                        fill={fill} stroke={tokens.surface.halo} strokeWidth={1}
                      />
                      {/* The value is printed, so the band colour is redundant. */}
                      <text
                        x={q.x} y={q.y - 6}
                        fontSize={8} fill={tokens.surface.ink} textAnchor="middle"
                      >
                        {(p.v as number).toFixed(1)}
                      </text>
                    </g>
                  );
                })}
            </g>
          );
        })}
    </svg>
  );
}

export default CompetencyRadar;
