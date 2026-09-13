import type { ChartTokens } from './chart-tokens';
import { chartId, PAD } from './chart-tokens';

export interface DeltaPoint {
  readonly id: string;
  readonly label: string;
  /** Adjusted leniency delta, in grade points. */
  readonly x: number;
  /** Grade events the delta rests on. */
  readonly y: number;
  readonly provisional: boolean;
  readonly outlier: boolean;
}

/**
 * DeltaScatter - docs/07_VISUALISATION.md §5.8 chart 33.
 *
 * x = the adjusted leniency delta with zero centred and labelled, y = the number of grade events the
 * delta rests on; the outlier threshold is drawn as two rules, the peer median as a third, and an
 * instructor with too few records to band is drawn HOLLOW rather than omitted or filled. Reading the
 * vertical axis matters: a point far from zero but low on the axis is a small sample, which is
 * exactly what the shrinkage in the delta already accounts for and what the hollow mark repeats.
 *
 * Server component, no hooks: `id` is a required prop (see chartId).
 */
export function DeltaScatter({
  id, points, outlierAbs, peerMedian, tokens, width = 460, height = 210,
}: {
  readonly id: string;
  readonly points: readonly DeltaPoint[];
  readonly outlierAbs: number;
  readonly peerMedian: number | null;
  readonly tokens: ChartTokens;
  readonly width?: number;
  readonly height?: number;
}) {
  const cid = chartId(id);
  const span = Math.max(outlierAbs * 1.4, ...points.map((p) => Math.abs(p.x) * 1.1), 0.3);
  const maxY = Math.max(10, ...points.map((p) => p.y));
  const innerW = width - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const X = (v: number) => PAD.left + ((v + span) / (2 * span)) * innerW;
  const Y = (v: number) => PAD.top + innerH - (v / maxY) * innerH;

  return (
    <figure style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-labelledby={`${cid}-t`} style={{ fontFamily: tokens.fontStack }}>
        <title id={`${cid}-t`}>Adjusted leniency against grade events, {points.length} instructors</title>
        <line x1={PAD.left} x2={width - PAD.right} y1={PAD.top + innerH} y2={PAD.top + innerH} stroke={tokens.surface.border} />
        <text x={PAD.left - 4} y={PAD.top + 8} textAnchor="end" fontSize="8" fill={tokens.surface.inkMuted}>{maxY}</text>
        <text x={PAD.left - 4} y={PAD.top + innerH} textAnchor="end" fontSize="8" fill={tokens.surface.inkMuted}>0</text>
        <text x={2} y={PAD.top + innerH / 2} fontSize="8" fill={tokens.surface.inkMuted} transform={`rotate(-90 10 ${PAD.top + innerH / 2})`}>grades</text>

        {[-outlierAbs, outlierAbs].map((v) => (
          <g key={v}>
            <line x1={X(v)} x2={X(v)} y1={PAD.top} y2={PAD.top + innerH} stroke={tokens.bands.red} strokeWidth="1" strokeDasharray="3 3" />
            <text x={X(v)} y={PAD.top + 7} textAnchor="middle" fontSize="8" fill={tokens.bands.red}>{v > 0 ? `+${v}` : v}</text>
          </g>
        ))}
        {peerMedian !== null ? (
          <g>
            <line x1={X(peerMedian)} x2={X(peerMedian)} y1={PAD.top} y2={PAD.top + innerH} stroke={tokens.series.secondary} strokeWidth="1" />
            <text x={X(peerMedian)} y={height - 11} textAnchor="middle" fontSize="8" fill={tokens.surface.inkMuted}>median</text>
          </g>
        ) : null}
        <line x1={X(0)} x2={X(0)} y1={PAD.top} y2={PAD.top + innerH} stroke={tokens.surface.ink} strokeWidth="1" />
        <text x={X(0)} y={PAD.top + innerH + 10} textAnchor="middle" fontSize="8" fontWeight="600" fill={tokens.surface.ink}>0</text>
        <text x={PAD.left} y={PAD.top + innerH + 10} textAnchor="start" fontSize="8" fill={tokens.surface.inkMuted}>stricter</text>
        <text x={width - PAD.right} y={PAD.top + innerH + 10} textAnchor="end" fontSize="8" fill={tokens.surface.inkMuted}>more lenient</text>

        {points.map((p) => (
          <circle
            key={p.id} cx={X(Math.max(-span, Math.min(span, p.x)))} cy={Y(Math.min(maxY, p.y))} r={p.outlier ? 4 : 3}
            fill={p.provisional ? tokens.surface.bg : p.outlier ? tokens.bands.red : tokens.series.primary}
            stroke={p.provisional ? tokens.surface.inkMuted : tokens.surface.halo} strokeWidth="1"
          >
            <title>{`${p.label}: ${p.x > 0 ? '+' : ''}${p.x.toFixed(2)} over ${p.y} grades${p.provisional ? ' (provisional, not banded)' : ''}${p.outlier ? ' - outside the band' : ''}`}</title>
          </circle>
        ))}
      </svg>
      <figcaption className="xs muted">
        Hollow marks are provisional: too few records to band. Dashed rules are ±{outlierAbs} grade points, the threshold for review.
      </figcaption>
    </figure>
  );
}

export default DeltaScatter;
