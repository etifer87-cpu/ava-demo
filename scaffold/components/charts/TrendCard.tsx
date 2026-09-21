'use client';

import { useRef } from 'react';
import type { ChartTokens } from './chart-tokens';
import { TrendSparkline, type SparklinePoint } from './TrendSparkline';

/**
 * TrendCard - one competency's trend: the compact chart on the page, and on click the same data
 * enlarged in a pop-up, with the event behind every point on hover. Client component only for
 * the dialog; the chart itself is the server-safe TrendSparkline in both sizes.
 */
export function TrendCard({ code, name, colour, points, tokens, min, max }: { readonly code: string; readonly name: string; readonly colour: string; readonly points: readonly SparklinePoint[]; readonly tokens: ChartTokens; readonly min: number; readonly max: number }) {
  const dialog = useRef<HTMLDialogElement | null>(null);
  const scored = points.filter((p) => p.value !== null);
  const mean = scored.length ? (scored.reduce((s, p) => s + (p.value ?? 0), 0) / scored.length).toFixed(2) : '-';
  return (
    <>
      <button type="button" className="trend-card" onClick={() => dialog.current?.showModal()} title="Enlarge" data-testid={`trend-${code}`}>
        <div className="trend-title"><span className="mono trend-code" style={{ color: colour }}>{code}</span> {name}</div>
        <TrendSparkline id={`spark-${code}`} label={`${code} trend`} points={points} tokens={tokens} colour={colour} min={min} max={max} fontScale={1} dotRadius={2.1} />
      </button>
      <dialog ref={dialog} className="modal modal-wide" aria-labelledby={`trend-${code}-title`} onCancel={(e) => e.preventDefault()}>
        <div className="stack">
          <div className="row" style={{ alignItems: 'baseline' }}>
            <h2 id={`trend-${code}-title`} className="card-title" style={{ margin: 0 }}><span className="mono" style={{ color: colour }}>{code}</span> {name}</h2>
            <span className="small muted">{scored.length} grades · mean {mean}</span>
            <span className="spacer" />
            <button type="button" className="button button-quiet xs" onClick={() => dialog.current?.close()} aria-label="Close">✕ Close</button>
          </div>
          <TrendSparkline id={`spark-big-${code}`} label={`${code} trend, enlarged`} points={points} tokens={tokens} colour={colour} min={min} max={max} width={720} height={260} fontScale={1.4} dotRadius={5} />
          <p className="xs muted" style={{ margin: 0 }}>Hover a point for the session behind it. Gaps are breaks in the line, never zeros.</p>
        </div>
      </dialog>
    </>
  );
}

export default TrendCard;
