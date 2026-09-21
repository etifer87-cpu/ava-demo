/**
 * PeerCompare.tsx - one competency per row, this pilot's mean against the peer group's.
 *
 * A DUMB-BELL, not two bars. The question is "how far apart are they", and a paired bar chart makes
 * the reader compute a difference from two lengths measured off a shared baseline, which is the
 * thing eyes are worst at. A line between two dots puts the difference on screen as the gap itself,
 * and the dot that sits further right is the higher mean whichever way round they fall.
 *
 * The axis starts at the scale minimum and not at the lowest value present: a truncated axis makes
 * 3.41 against 3.46 look like a chasm, and on a 1-5 competency scale that is the difference between
 * a finding and a rounding error.
 *
 * No hooks, ids from the `id` prop, every colour resolved - renders identically server, browser and PDF.
 */

import type { ChartTokens } from './chart-tokens';
import { chartType } from './chart-tokens';

export interface PeerCompareRow {
  readonly code: string;
  readonly name: string;
  readonly colour: string;
  readonly subjectMean: number | null;
  readonly subjectN: number;
  readonly peerMean: number | null;
  readonly peerN: number;
}

const ROW = 26;
const W = 560;
const X_CODE = 0;
const X_PLOT = 150;
const PLOT_W = 300;
const X_VAL = 500;
const X_DELTA = 558;

export function PeerCompare({
  id, rows, tokens, min, max, peerLabel, label,
}: {
  readonly id: string;
  readonly rows: readonly PeerCompareRow[];
  readonly tokens: ChartTokens;
  readonly min: number;
  readonly max: number;
  readonly peerLabel: string;
  readonly label: string;
}) {
  const x = (v: number) => X_PLOT + ((v - min) / (max - min)) * PLOT_W;
  const height = rows.length * ROW + 46;
  // Measured 2026-09-21: 560 units render in 550px, so units are pixels here and the text was
  // 9.3px. Same viewBox width as TwoLineTrend, half the apparent size. See CHART_TYPE_PX.
  const FS = chartType(0.98);
  const ticks: number[] = [];
  for (let t = min; t <= max; t += 1) ticks.push(t);

  return (
    <svg viewBox={`0 0 ${W} ${height}`} width="100%" role="img" aria-label={label}
         style={{ display: 'block', background: tokens.surface.bg }} fontFamily={tokens.fontStack}>
      <g>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={16} y2={rows.length * ROW + 18} stroke={tokens.surface.grid} />
            <text x={x(t)} y={rows.length * ROW + 30} fontSize={FS.axis} fill={tokens.surface.inkMuted}
                  textAnchor="middle">{t}</text>
          </g>
        ))}
      </g>

      {rows.map((r, i) => {
        const y = 18 + i * ROW + ROW / 2;
        const a = r.subjectMean; const b = r.peerMean;
        const delta = a !== null && b !== null ? a - b : null;
        return (
          <g key={r.code}>
            <title>
              {`${r.code} ${r.name}: this pilot ${a === null ? 'no grades' : a.toFixed(2)} over ${r.subjectN}` +
               `, ${peerLabel} ${b === null ? 'no grades' : b.toFixed(2)} over ${r.peerN}`}
            </title>
            <rect x={X_CODE} y={y - 7} width={16} height={14} rx={3} fill={r.colour} />
            <text x={X_CODE + 22} y={y} fontSize={FS.label} fill={tokens.surface.ink} dominantBaseline="middle">{r.code}</text>
            <text x={X_CODE + 52} y={y} fontSize={FS.label} fill={tokens.surface.inkMuted} dominantBaseline="middle">
              {r.name.length > 30 ? `${r.name.slice(0, 29)}…` : r.name}
            </text>

            {a !== null && b !== null ? (
              <line x1={x(Math.min(a, b))} x2={x(Math.max(a, b))} y1={y} y2={y}
                    stroke={tokens.surface.inkMuted} strokeWidth={2} strokeLinecap="round" />
            ) : null}
            {b !== null ? (
              <circle cx={x(b)} cy={y} r={4.5} fill={tokens.surface.bg}
                      stroke={tokens.series.secondary} strokeWidth={2} />
            ) : null}
            {a !== null ? (
              <circle cx={x(a)} cy={y} r={5} fill={r.colour} stroke={tokens.surface.halo} strokeWidth={1.5} />
            ) : null}

            <text x={X_VAL} y={y} fontSize={FS.label} fill={tokens.surface.ink} textAnchor="end" dominantBaseline="middle">
              {a === null ? '—' : a.toFixed(2)}
            </text>
            <text x={X_DELTA} y={y} fontSize={FS.value} textAnchor="end" dominantBaseline="middle"
                  fill={delta === null ? tokens.surface.inkMuted : tokens.surface.ink}>
              {delta === null ? '' : `${delta >= 0 ? '+' : '−'}${Math.abs(delta).toFixed(2)}`}
            </text>
          </g>
        );
      })}

      {/* Two series, so a legend is not optional. */}
      <g>
        <circle cx={X_PLOT + 4} cy={8} r={5} fill={tokens.surface.ink} stroke={tokens.surface.halo} strokeWidth={1.5} />
        <text x={X_PLOT + 14} y={8} fontSize={FS.value} fill={tokens.surface.ink} dominantBaseline="middle">this pilot</text>
        <circle cx={X_PLOT + 92} cy={8} r={4.5} fill={tokens.surface.bg} stroke={tokens.series.secondary} strokeWidth={2} />
        <text x={X_PLOT + 102} y={8} fontSize={FS.value} fill={tokens.surface.inkMuted} dominantBaseline="middle">{peerLabel}</text>
      </g>
      <desc>
        {rows.map((r) => `${r.code}: ${r.subjectMean?.toFixed(2) ?? 'none'} against ${r.peerMean?.toFixed(2) ?? 'none'}`).join('. ')}
      </desc>
    </svg>
  );
}

export default PeerCompare;
