/**
 * TwoLineTrend.tsx - a pilot's monthly mean against their peer group's, on one axis.
 *
 * ONE AXIS, ALWAYS. Both series are competency grades on the same 1-5 scale, so they share a scale
 * and the comparison is honest. A second y-axis would let the two lines be scaled until they told
 * whatever story was wanted.
 *
 * A MONTH WITH NO TRAINING IS A GAP, NOT A ZERO - and the line still crosses it, DASHED. A pilot
 * trains three or four times a year, so a subject line drawn only where there is data is a handful
 * of unconnected dots that nobody can read a direction from. Connecting them solid would be the
 * opposite lie: it claims a value for every month in between. So the line joins the points and says
 * which parts are measured - SOLID between consecutive months, DASHED where it spans months with no
 * training. Dropping to zero would invent a grade nobody awarded and is never an option.
 *
 * IT SPANS THE WHOLE AXIS. Before the first grade and after the last, the line is CARRIED FLAT at
 * that value, dashed like any other unmeasured stretch. A senior pilot who trains twice a year had
 * a line occupying a third of the chart while the fleet's ran edge to edge, and two series on one
 * axis that cover different spans are read as one being shorter rather than one being sparser.
 * Carrying it flat states the only thing that is actually known outside the measured range - that
 * the last grade is still the last grade - and the dash says it was not measured. The end caps are
 * drawn WITHOUT markers, so nobody mistakes the chart edge for a session.
 *
 * No hooks, ids from the `id` prop, colours resolved - server, browser and PDF render the same bytes.
 */

import type { ChartTokens } from './chart-tokens';
import { chartType } from './chart-tokens';


export interface TwoLinePoint {
  readonly on: string;
  readonly subject: number | null;
  readonly subjectN: number;
  readonly peer: number | null;
}

export function TwoLineTrend({
  id, points, tokens, min, max, peerLabel, label, colour,
  pxPerUnit = 2.05,
  width = 560, height = 170, emptyText = 'Not enough history to draw a trend.',
}: {
  readonly id: string;
  readonly points: readonly TwoLinePoint[];
  readonly tokens: ChartTokens;
  /**
   * Rendered pixels per viewBox unit, for the type scale. Defaults to the measured inline
   * ratio; an enlarged copy in a dialog has a different one and must pass it. See
   * CHART_TYPE_PX.
   */
  readonly pxPerUnit?: number;
  readonly min: number;
  readonly max: number;
  readonly peerLabel: string;
  readonly label: string;
  readonly colour?: string;
  readonly width?: number;
  readonly height?: number;
  readonly emptyText?: string;
}) {
  const L = 26; const R = 8; const T = 20; const B = 26;
  // Measured 2026-09-21: 560 units render in 1150px, a ratio of 2.05, so this chart's text
  // was coming out at 20.5px - the LARGEST in the product - from the same '9.5' literal that
  // gave PeerCompare 9.3px. This brings it down to the shared scale. See CHART_TYPE_PX.
  const FS = chartType(pxPerUnit);
  const subjectColour = colour ?? tokens.series.primary;

  if (points.length < 2) {
    return (
      <svg viewBox={`0 0 ${width} 44`} width="100%" role="img" aria-label={label}
           style={{ display: 'block', background: tokens.surface.bg }} fontFamily={tokens.fontStack}>
        <rect x={0} y={4} width={width} height={36} fill="none" stroke={tokens.surface.border} />
        <text x={width / 2} y={22} fontSize={FS.label} fill={tokens.surface.inkMuted}
              textAnchor="middle" dominantBaseline="middle">{emptyText}</text>
      </svg>
    );
  }

  const x = (i: number) => L + (i / (points.length - 1)) * (width - L - R);
  const y = (v: number) => T + (1 - (v - min) / (max - min)) * (height - T - B);

  /* Runs of consecutive non-null points, for the PEER line - a fleet trains every month, so its
     series is continuous and a break in it is real. A run of one renders as a dot rather than as
     nothing. The subject line is drawn from `segments` below instead, because it must show which
     stretches are measured. */
  const runs = (pick: (p: TwoLinePoint) => number | null) => {
    const out: { i: number; v: number }[][] = [];
    let cur: { i: number; v: number }[] = [];
    points.forEach((p, i) => {
      const v = pick(p);
      if (v === null) { if (cur.length) out.push(cur); cur = []; } else cur.push({ i, v });
    });
    if (cur.length) out.push(cur);
    return out;
  };
  const path = (run: { i: number; v: number }[]) =>
    run.map((pt, k) => `${k === 0 ? 'M' : 'L'} ${x(pt.i).toFixed(1)} ${y(pt.v).toFixed(1)}`).join(' ');

  /* Every measured point in order, and whether each segment bridges a gap. A segment from index 3 to
     index 4 is one month and is measured; 3 to 9 spans five months nobody flew. */
  const measured = points.map((p, i) => ({ i, v: p.subject })).filter((p): p is { i: number; v: number } => p.v !== null);
  const segments = measured.slice(1).map((pt, k) => ({
    from: measured[k]!, to: pt, bridged: pt.i - measured[k]!.i > 1,
  }));
  /* The carried ends. Only drawn where there is actually axis left to cover, so a pilot who trained
     in the first and last month of the window gets no stub. */
  const firstM = measured[0] ?? null;
  const lastM = measured[measured.length - 1] ?? null;
  const leadIn = firstM && firstM.i > 0 ? { from: { i: 0, v: firstM.v }, to: firstM } : null;
  const leadOut = lastM && lastM.i < points.length - 1
    ? { from: lastM, to: { i: points.length - 1, v: lastM.v } } : null;

  const ticks: number[] = [];
  for (let t = Math.ceil(min); t <= max; t += 1) ticks.push(t);
  const first = points[0]!.on.slice(0, 7);
  const last = points[points.length - 1]!.on.slice(0, 7);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label={label}
         style={{ display: 'block', background: tokens.surface.bg }} fontFamily={tokens.fontStack}>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={L} x2={width - R} y1={y(t)} y2={y(t)} stroke={tokens.surface.grid} />
          <text x={L - 5} y={y(t)} fontSize={FS.axis} fill={tokens.surface.inkMuted}
                textAnchor="end" dominantBaseline="middle">{t}</text>
        </g>
      ))}

      {runs((p) => p.peer).map((run, k) => (
        run.length === 1
          ? <circle key={`p${k}`} cx={x(run[0]!.i)} cy={y(run[0]!.v)} r={2.5} fill={tokens.series.secondary} />
          : <path key={`p${k}`} d={path(run)} fill="none" stroke={tokens.series.secondary}
                  strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      ))}
      {[leadIn, leadOut].map((sg, k) => (sg === null ? null : (
        <line
          key={`cap${k}`}
          x1={x(sg.from.i)} y1={y(sg.from.v)} x2={x(sg.to.i)} y2={y(sg.to.v)}
          stroke={subjectColour} strokeWidth={2} strokeLinecap="round"
          strokeDasharray="4 4" opacity={0.75}
        />
      )))}
      {segments.map((sg) => (
        <line
          key={`${sg.from.i}-${sg.to.i}`}
          x1={x(sg.from.i)} y1={y(sg.from.v)} x2={x(sg.to.i)} y2={y(sg.to.v)}
          stroke={subjectColour} strokeWidth={2} strokeLinecap="round"
          strokeDasharray={sg.bridged ? '4 4' : undefined}
          opacity={sg.bridged ? 0.75 : 1}
        />
      ))}
      {measured.length === 1 ? (
        <circle cx={x(measured[0]!.i)} cy={y(measured[0]!.v)} r={3.5} fill={subjectColour} />
      ) : null}
      {points.map((p, i) => (p.subject === null ? null : (
        <circle key={p.on} cx={x(i)} cy={y(p.subject)} r={3} fill={subjectColour}
                stroke={tokens.surface.halo} strokeWidth={1.5}>
          <title>{`${p.on.slice(0, 7)}: ${p.subject.toFixed(2)} over ${p.subjectN} grades · ${peerLabel} ${p.peer === null ? 'no grades' : p.peer.toFixed(2)}`}</title>
        </circle>
      )))}

      <text x={L} y={height - 8} fontSize={FS.axis} fill={tokens.surface.inkMuted}>{first}</text>
      <text x={width - R} y={height - 8} fontSize={FS.axis} fill={tokens.surface.inkMuted} textAnchor="end">{last}</text>

      <g>
        <line x1={L} x2={L + 16} y1={8} y2={8} stroke={subjectColour} strokeWidth={2} strokeLinecap="round" />
        <text x={L + 22} y={8} fontSize={FS.value} fill={tokens.surface.ink} dominantBaseline="middle">this pilot</text>
        <line x1={L + 108} x2={L + 124} y1={8} y2={8} stroke={tokens.series.secondary} strokeWidth={2} strokeLinecap="round" />
        <text x={L + 130} y={8} fontSize={FS.value} fill={tokens.surface.inkMuted} dominantBaseline="middle">{peerLabel}</text>
        {segments.some((sg) => sg.bridged) || leadIn || leadOut ? (
          <>
            <line x1={width - 150} x2={width - 134} y1={8} y2={8} stroke={subjectColour}
                  strokeWidth={2} strokeLinecap="round" strokeDasharray="4 4" opacity={0.75} />
            <text x={width - 128} y={8} fontSize={FS.value} fill={tokens.surface.inkMuted}
                  dominantBaseline="middle">no training</text>
          </>
        ) : null}
      </g>
      <desc>
        {points.filter((p) => p.subject !== null).map((p) => `${p.on.slice(0, 7)}: ${p.subject!.toFixed(2)}`).join('. ')}
      </desc>
    </svg>
  );
}

export default TwoLineTrend;
