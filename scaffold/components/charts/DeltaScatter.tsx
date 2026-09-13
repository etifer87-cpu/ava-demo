import type { LeniencyZone } from '@/lib/config';
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
 * delta rests on. Reading the vertical axis matters: a point far from zero but low on the axis rests
 * on little evidence, which is what the shrinkage inside the delta already accounts for and what the
 * hollow mark repeats.
 *
 * The plot is banded outward from zero by brand.yaml `leniency_zones`, whose boundaries are multiples
 * of the review threshold in analytics.yaml - so the bands cannot drift away from the threshold they
 * illustrate. A dot takes the colour of the band it lands in, which means distance from zero is
 * carried three times over: horizontal position, band, and dot colour. Colour is never the only
 * channel - every dot names its own figure on hover and the outliers are listed in full beneath the
 * chart.
 *
 * Server component, no hooks: `id` is a required prop (see chartId).
 */
export function DeltaScatter({
  id, points, outlierAbs, peerMedian, zones, tokens, width = 900, height = 300,
}: {
  readonly id: string;
  readonly points: readonly DeltaPoint[];
  readonly outlierAbs: number;
  readonly peerMedian: number | null;
  readonly zones: readonly LeniencyZone[];
  readonly tokens: ChartTokens;
  readonly width?: number;
  readonly height?: number;
}) {
  const cid = chartId(id);
  const legendH = zones.length ? 14 : 0;
  const innerW = width - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom - legendH;
  const top = PAD.top;
  const bottom = top + innerH;

  // The axis must reach the end of the last bounded zone, so every band is visible even when no
  // instructor sits that far out.
  const lastBounded = zones.filter((z) => z.to !== null).at(-1)?.to ?? 1;
  const span = Math.max(outlierAbs * lastBounded * 1.15, ...points.map((p) => Math.abs(p.x) * 1.08), 0.3);
  const maxY = Math.max(10, ...points.map((p) => p.y));
  const X = (v: number) => PAD.left + ((v + span) / (2 * span)) * innerW;
  const Y = (v: number) => top + innerH - (v / maxY) * innerH;

  // Each zone is a ring: the band between the previous boundary and its own, on both sides of zero.
  const rings = zones.map((z, i) => {
    const lo = i === 0 ? 0 : (zones[i - 1]!.to as number) * outlierAbs;
    const hi = z.to === null ? span : Math.min(z.to * outlierAbs, span);
    return { ...z, lo, hi };
  }).filter((r) => r.hi > r.lo);
  const zoneOf = (d: number): { colour: string; label: string } => {
    const a = Math.abs(d);
    for (const z of zones) if (z.to === null || a < z.to * outlierAbs) return { colour: z.colour, label: z.label };
    return { colour: tokens.series.primary, label: '' };
  };

  return (
    <figure style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-labelledby={`${cid}-t`} style={{ fontFamily: tokens.fontStack }}>
        <title id={`${cid}-t`}>{`Adjusted leniency against the grades behind it, ${points.length} instructors`}</title>

        {rings.map((r) => (
          <g key={r.label}>
            {r.lo === 0 ? (
              <rect x={X(-r.hi)} y={top} width={X(r.hi) - X(-r.hi)} height={innerH} fill={r.colour} fillOpacity="0.20" />
            ) : (
              <>
                <rect x={X(-r.hi)} y={top} width={X(-r.lo) - X(-r.hi)} height={innerH} fill={r.colour} fillOpacity="0.20" />
                <rect x={X(r.lo)} y={top} width={X(r.hi) - X(r.lo)} height={innerH} fill={r.colour} fillOpacity="0.20" />
              </>
            )}
            {r.hi < span ? (
              <>
                <line x1={X(-r.hi)} x2={X(-r.hi)} y1={top} y2={bottom} stroke={r.colour} strokeWidth="1" />
                <line x1={X(r.hi)} x2={X(r.hi)} y1={top} y2={bottom} stroke={r.colour} strokeWidth="1" />
              </>
            ) : null}
          </g>
        ))}

        <line x1={PAD.left} x2={width - PAD.right} y1={bottom} y2={bottom} stroke={tokens.surface.border} />
        <text x={PAD.left - 4} y={top + 8} textAnchor="end" fontSize="9" fill={tokens.surface.inkMuted}>{maxY}</text>
        <text x={PAD.left - 4} y={bottom} textAnchor="end" fontSize="9" fill={tokens.surface.inkMuted}>0</text>
        <text x={9} y={top + innerH / 2} fontSize="9" fill={tokens.surface.inkMuted} textAnchor="middle" transform={`rotate(-90 9 ${top + innerH / 2})`}>grades</text>

        {[-outlierAbs, outlierAbs].map((v) => (
          <g key={v}>
            <line x1={X(v)} x2={X(v)} y1={top} y2={bottom} stroke={tokens.bands.red} strokeWidth="1" strokeDasharray="3 3" />
            <text x={X(v)} y={top + 8} textAnchor="middle" fontSize="9" fontWeight="600" fill={tokens.bands.red}>{v > 0 ? `+${v}` : v}</text>
          </g>
        ))}
        {peerMedian !== null ? (
          <g>
            <line x1={X(peerMedian)} x2={X(peerMedian)} y1={top} y2={bottom} stroke={tokens.series.secondary} strokeWidth="1" />
            <text x={X(peerMedian)} y={bottom - 3} textAnchor="middle" fontSize="9" fill={tokens.surface.inkMuted}>median {peerMedian > 0 ? '+' : ''}{peerMedian.toFixed(2)}</text>
          </g>
        ) : null}
        <line x1={X(0)} x2={X(0)} y1={top} y2={bottom} stroke={tokens.surface.ink} strokeWidth="1" />
        <text x={X(0)} y={bottom + 11} textAnchor="middle" fontSize="9" fontWeight="600" fill={tokens.surface.ink}>0</text>
        <text x={PAD.left} y={bottom + 11} textAnchor="start" fontSize="9" fill={tokens.surface.inkMuted}>stricter than the bench</text>
        <text x={width - PAD.right} y={bottom + 11} textAnchor="end" fontSize="9" fill={tokens.surface.inkMuted}>more lenient than the bench</text>

        {points.map((p) => {
          const z = zoneOf(p.x);
          return (
            <circle
              key={p.id} cx={X(Math.max(-span, Math.min(span, p.x)))} cy={Y(Math.min(maxY, p.y))} r={p.outlier ? 4.5 : 3.5}
              fill={p.provisional ? tokens.surface.bg : z.colour}
              stroke={p.provisional ? tokens.surface.inkMuted : tokens.surface.ink} strokeWidth="0.7"
            >
              <title>{`${p.label}: ${p.x > 0 ? '+' : ''}${p.x.toFixed(2)} over ${p.y} grades - ${z.label}${p.provisional ? ' (provisional, not banded)' : ''}`}</title>
            </circle>
          );
        })}

        {rings.map((r, i) => (
          <g key={`k-${r.label}`}>
            <rect x={PAD.left + i * 150} y={height - 10} width="9" height="9" fill={r.colour} fillOpacity="0.85" stroke={tokens.surface.ink} strokeWidth="0.5" />
            <text x={PAD.left + i * 150 + 13} y={height - 2} fontSize="9" fill={tokens.surface.ink}>
              {r.label} {r.hi >= span ? `beyond ±${r.lo.toFixed(2)}` : `±${r.lo.toFixed(2)}-${r.hi.toFixed(2)}`}
            </text>
          </g>
        ))}
      </svg>
      <figcaption className="xs muted">
        Hollow marks are provisional: too few records to band, so never flagged. The dashed rules are ±{outlierAbs} grade points, the threshold at which an instructor is listed for a standardisation conversation.
      </figcaption>
    </figure>
  );
}

export default DeltaScatter;
