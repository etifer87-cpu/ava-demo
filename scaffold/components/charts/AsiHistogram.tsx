import type { ChartTokens } from './chart-tokens';
import { chartId, chartType, PAD } from './chart-tokens';

/**
 * AsiHistogram - docs/07_VISUALISATION.md §5.8 chart 32.
 *
 * x = standardisation-index bucket, y = how many instructors sit in it; each bar carries the colour
 * of the band that bucket falls in, and the band names are printed on the axis so the colour is
 * never the only channel. Instructors with too few records to band are counted separately and named
 * beside the chart rather than dropped: a histogram that silently omits them reads as a complete
 * population when it is not.
 *
 * Server component, no hooks: `id` is a required prop (see chartId).
 */
export function AsiHistogram({
  id, scores, notBanded, bands, tokens, width = 460, height = 190, bucket = 10,
  pxPerUnit = 1.28,
}: {
  readonly id: string;
  readonly scores: readonly number[];
  readonly notBanded: number;
  readonly bands: { green_min: number; amber_min: number };
  readonly tokens: ChartTokens;
  /**
   * Rendered pixels per viewBox unit, for the type scale. Defaults to this chart's measured
   * inline ratio; an ENLARGED copy in a dialog has a different one and must pass it, or its
   * labels come out SMALLER than the small copy's. See CHART_TYPE_PX.
   */
  readonly pxPerUnit?: number;
  readonly width?: number;
  readonly height?: number;
  readonly bucket?: number;
}) {
  const cid = chartId(id);
  // Measured 2026-09-21: 460 units render in 590px. The scale is stated in pixels; see CHART_TYPE_PX.
  const FS = chartType(pxPerUnit);
  const n = Math.ceil(100 / bucket);
  const bucketOf = (s: number) => Math.min(n - 1, Math.max(0, Math.floor(s / bucket)));
  const counts = Array.from({ length: n }, (_, i) => scores.filter((s) => bucketOf(s) === i).length);
  const peak = Math.max(1, ...counts);
  const innerW = width - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom - 12;
  const bw = innerW / n;
  const colourAt = (lo: number) => (lo >= bands.green_min ? tokens.bands.green : lo >= bands.amber_min ? tokens.bands.amber : tokens.bands.red);
  const tick = (v: number) => PAD.left + (v / 100) * innerW;

  return (
    <figure style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-labelledby={`${cid}-t`} style={{ fontFamily: tokens.fontStack }}>
        <title id={`${cid}-t`}>{`Standardisation index across ${scores.length} banded instructors`}</title>
        {[0, 0.5, 1].map((f) => (
          <line key={f} x1={PAD.left} x2={width - PAD.right} y1={PAD.top + innerH - f * innerH} y2={PAD.top + innerH - f * innerH} stroke={tokens.surface.grid} strokeWidth="1" />
        ))}
        <text x={PAD.left - 4} y={PAD.top + 8} textAnchor="end" fontSize={FS.axis} fill={tokens.surface.inkMuted}>{peak}</text>
        <text x={PAD.left - 4} y={PAD.top + innerH} textAnchor="end" fontSize={FS.axis} fill={tokens.surface.inkMuted}>0</text>
        {counts.map((c, i) => {
          const lo = i * bucket;
          const h = (c / peak) * innerH;
          return (
            <g key={lo}>
              <rect x={PAD.left + i * bw + 1} y={PAD.top + innerH - h} width={Math.max(1, bw - 2)} height={h} fill={colourAt(lo)} opacity={c ? 0.85 : 0.15}>
                <title>{`${lo} to ${lo + bucket}: ${c} instructor${c === 1 ? '' : 's'}`}</title>
              </rect>
              {c > 0 ? <text x={PAD.left + i * bw + bw / 2} y={PAD.top + innerH - h - 2} textAnchor="middle" fontSize={FS.axis} fontWeight="600" fill={tokens.surface.ink}>{c}</text> : null}
            </g>
          );
        })}
        <line x1={PAD.left} x2={width - PAD.right} y1={PAD.top + innerH} y2={PAD.top + innerH} stroke={tokens.surface.border} strokeWidth="1" />
        {[0, 25, 50, 75, 100].map((v) => (
          <text key={v} x={tick(v)} y={PAD.top + innerH + 10} textAnchor="middle" fontSize={FS.axis} fill={tokens.surface.inkMuted}>{v}</text>
        ))}
        <text x={tick(bands.amber_min / 2)} y={height - 2} textAnchor="middle" fontSize={FS.axis} fill={tokens.bands.red}>red</text>
        <text x={tick((bands.amber_min + bands.green_min) / 2)} y={height - 2} textAnchor="middle" fontSize={FS.axis} fill={tokens.bands.amber}>amber</text>
        <text x={tick((bands.green_min + 100) / 2)} y={height - 2} textAnchor="middle" fontSize={FS.axis} fill={tokens.bands.green}>green</text>
      </svg>
      <figcaption className="xs muted">
        {scores.length} banded instructor{scores.length === 1 ? '' : 's'}; green at {bands.green_min} and above, amber from {bands.amber_min}.
        {notBanded ? ` ${notBanded} not banded (too few records) and not counted here.` : ''}
      </figcaption>
    </figure>
  );
}

export default AsiHistogram;
