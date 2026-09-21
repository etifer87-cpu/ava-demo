import type { LeniencyZone } from '@/lib/config';
import type { ChartTokens } from './chart-tokens';
import { chartId, chartType, PAD } from './chart-tokens';

/**
 * LeniencyInterval - docs/07_VISUALISATION.md §5.8 chart 35.
 *
 * One instructor's adjusted leniency as a point with its 95 % interval, on the same banded axis the
 * bench scatter uses, with the peer median drawn as a reference rule and every other instructor's
 * delta drawn as a faint tick so one person's position is read against the actual distribution rather
 * than against an abstract zero.
 *
 * The INTERVAL is the point of the chart. A delta of +0.30 whose interval spans zero is a different
 * statement from a delta of +0.30 that sits clear of it, and a single number cannot tell them apart.
 *
 * An SVG <title> takes ONE string child, never interleaved text and expressions: React separates
 * adjacent text children with comment nodes on the server, the browser's SVG parser drops them, and
 * the mismatch makes React throw the subtree away and re-render it.
 *
 * Server component, no hooks: `id` is a required prop (see chartId).
 */
export function LeniencyInterval({
  id, delta, ciHalfWidth, rawDelta, provisional, outlierAbs, peerMedian, peers, zones, tokens, width = 900, height = 150,
}: {
  readonly id: string;
  readonly delta: number | null;
  readonly ciHalfWidth: number | null;
  readonly rawDelta: number | null;
  readonly provisional: boolean;
  readonly outlierAbs: number;
  readonly peerMedian: number | null;
  readonly peers: readonly number[];
  readonly zones: readonly LeniencyZone[];
  readonly tokens: ChartTokens;
  readonly width?: number;
  readonly height?: number;
}) {
  const cid = chartId(id);
  // Measured 2026-09-21: 900 units render in 1150px. The scale is stated in pixels; see CHART_TYPE_PX.
  const FS = chartType(1.28);
  const innerW = width - PAD.left - PAD.right;
  const top = PAD.top + 6;
  const axisY = top + 46;
  const rugY = axisY + 16;
  const lastBounded = zones.filter((z) => z.to !== null).at(-1)?.to ?? 1;
  const reach = Math.max(Math.abs(delta ?? 0) + (ciHalfWidth ?? 0), ...peers.map(Math.abs), outlierAbs * lastBounded);
  const span = reach * 1.1 || 0.5;
  const X = (v: number) => PAD.left + ((Math.max(-span, Math.min(span, v)) + span) / (2 * span)) * innerW;
  const rings = zones.map((z, i) => {
    const lo = i === 0 ? 0 : (zones[i - 1]!.to as number) * outlierAbs;
    const hi = z.to === null ? span : Math.min(z.to * outlierAbs, span);
    return { ...z, lo, hi };
  }).filter((r) => r.hi > r.lo);
  const zoneOf = (d: number) => {
    const a = Math.abs(d);
    for (const z of zones) if (z.to === null || a < z.to * outlierAbs) return z;
    return null;
  };
  const band = delta === null ? null : zoneOf(delta);

  return (
    <figure style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-labelledby={`${cid}-t`} style={{ fontFamily: tokens.fontStack }}>
        <title id={`${cid}-t`}>
          {delta === null ? 'No adjusted leniency yet' : `Adjusted leniency ${delta > 0 ? '+' : ''}${delta.toFixed(2)}${ciHalfWidth === null ? '' : ` plus or minus ${ciHalfWidth.toFixed(2)}`}`}
        </title>

        {rings.map((r) => (
          <g key={r.label}>
            {r.lo === 0
              ? <rect x={X(-r.hi)} y={top} width={X(r.hi) - X(-r.hi)} height={axisY - top} fill={r.colour} fillOpacity="0.20" />
              : <>
                  <rect x={X(-r.hi)} y={top} width={X(-r.lo) - X(-r.hi)} height={axisY - top} fill={r.colour} fillOpacity="0.20" />
                  <rect x={X(r.lo)} y={top} width={X(r.hi) - X(r.lo)} height={axisY - top} fill={r.colour} fillOpacity="0.20" />
                </>}
          </g>
        ))}

        {[-outlierAbs, outlierAbs].map((v) => (
          <g key={v}>
            <line x1={X(v)} x2={X(v)} y1={top} y2={axisY} stroke={tokens.bands.red} strokeWidth="1" strokeDasharray="3 3" />
            <text x={X(v)} y={top + 8} textAnchor="middle" fontSize={FS.axis} fill={tokens.bands.red}>{v > 0 ? `+${v}` : v}</text>
          </g>
        ))}
        <line x1={X(0)} x2={X(0)} y1={top} y2={axisY} stroke={tokens.surface.ink} strokeWidth="1" />
        {peerMedian !== null ? (
          <>
            <line x1={X(peerMedian)} x2={X(peerMedian)} y1={top} y2={axisY} stroke={tokens.series.secondary} strokeWidth="1.5" />
            <text x={X(peerMedian)} y={axisY - 3} textAnchor="middle" fontSize={FS.axis} fill={tokens.surface.inkMuted}>bench median</text>
          </>
        ) : null}

        {delta !== null ? (
          <g>
            {ciHalfWidth !== null ? (
              <>
                <line x1={X(delta - ciHalfWidth)} x2={X(delta + ciHalfWidth)} y1={top + 24} y2={top + 24} stroke={tokens.surface.ink} strokeWidth="2" />
                {[delta - ciHalfWidth, delta + ciHalfWidth].map((v) => (
                  <line key={v} x1={X(v)} x2={X(v)} y1={top + 18} y2={top + 30} stroke={tokens.surface.ink} strokeWidth="2" />
                ))}
              </>
            ) : null}
            <circle cx={X(delta)} cy={top + 24} r="6" fill={provisional ? tokens.surface.bg : band?.colour ?? tokens.series.primary} stroke={tokens.surface.ink} strokeWidth="1.2" />
            <text x={X(delta)} y={top + 14} textAnchor="middle" fontSize={FS.label} fontWeight="700" fill={tokens.surface.ink}>
              {delta > 0 ? '+' : ''}{delta.toFixed(2)}
            </text>
          </g>
        ) : (
          <text x={width / 2} y={top + 26} textAnchor="middle" fontSize={FS.value} fill={tokens.surface.inkMuted}>no graded record yet</text>
        )}

        <line x1={PAD.left} x2={width - PAD.right} y1={axisY} y2={axisY} stroke={tokens.surface.border} />
        <text x={PAD.left} y={axisY + 11} textAnchor="start" fontSize={FS.axis} fill={tokens.surface.inkMuted}>stricter than the bench</text>
        <text x={X(0)} y={axisY + 11} textAnchor="middle" fontSize={FS.axis} fontWeight="600" fill={tokens.surface.ink}>0</text>
        <text x={width - PAD.right} y={axisY + 11} textAnchor="end" fontSize={FS.axis} fill={tokens.surface.inkMuted}>more lenient</text>

        {peers.map((p, i) => (
          <line key={`${p}-${i}`} x1={X(p)} x2={X(p)} y1={rugY} y2={rugY + 7} stroke={tokens.series.secondary} strokeWidth="1" opacity="0.7" />
        ))}
        <text x={PAD.left} y={height - 2} fontSize={FS.axis} fill={tokens.surface.inkMuted}>
          each tick is one banded instructor ({peers.length})
          {rawDelta !== null ? ` · raw own-mean-minus-bench-mean ${rawDelta > 0 ? '+' : ''}${rawDelta.toFixed(2)}, shown for reference and never used to band` : ''}
        </text>
      </svg>
    </figure>
  );
}

export default LeniencyInterval;
