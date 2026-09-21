'use client';

import { useMemo, useState } from 'react';
import type { ChartTokens } from './chart-tokens';
import { TwoLineTrend, type TwoLinePoint } from './TwoLineTrend';

/**
 * TrendScrubber - the pilot-against-fleet trend with a window that slides over the whole career.
 *
 * WHY THIS EXISTS. The panel used to return twelve months, and an EBT programme trains twice a
 * year, so the chart was two points six months apart. Two points are a line segment, not a trend.
 * The query now returns the entire career and this holds the window.
 *
 * A FIXED-LENGTH WINDOW THAT SLIDES, not a from/to pair. The horizontal scale then stays constant
 * as you drag, so the steepness of the line means the same thing at every position - with two
 * handles the axis stretches and a flat stretch and a steep one can be the same data.
 *
 * CLIENT ONLY FOR THE HANDLE. TwoLineTrend has no hooks and reads no server API: it is a pure
 * function of its props, so it renders inside this client component exactly as it does on the
 * server, and the PDF path keeps calling it directly. This component holds one number.
 */
export function TrendScrubber({
  points, tokens, min, max, peerLabel, label, colour, windowMonths = 24, pxPerUnit,
}: {
  readonly points: readonly TwoLinePoint[];
  readonly tokens: ChartTokens;
  readonly min: number;
  readonly max: number;
  readonly peerLabel: string;
  readonly label: string;
  readonly colour?: string;
  /** Months visible at once. The whole series is shown when it is shorter than this. */
  readonly windowMonths?: number;
  readonly pxPerUnit?: number;
}) {
  const n = points.length;
  const size = Math.min(windowMonths, n);
  const maxStart = Math.max(0, n - size);
  // Opens on the most recent window: the question a training manager asks first is "where is this
  // pilot NOW", and the history is a drag away.
  const [start, setStart] = useState(maxStart);

  const slice = useMemo(() => points.slice(start, start + size), [points, start, size]);
  const from = slice[0]?.on.slice(0, 7) ?? '';
  const to = slice[slice.length - 1]?.on.slice(0, 7) ?? '';
  const sessions = slice.filter((p) => p.subject !== null).length;

  return (
    <div className="stack" style={{ gap: 'var(--space-2)' }}>
      <TwoLineTrend
        id="subject-trend"
        points={slice}
        tokens={tokens}
        min={min}
        max={max}
        peerLabel={peerLabel}
        label={label}
        colour={colour}
        pxPerUnit={pxPerUnit}
      />

      {maxStart > 0 ? (
        <div className="row" style={{ gap: 'var(--space-3)', alignItems: 'center' }}>
          <label className="xs muted" htmlFor="trend-scrub" style={{ whiteSpace: 'nowrap' }}>
            Window
          </label>
          <input
            id="trend-scrub"
            type="range"
            min={0}
            max={maxStart}
            step={1}
            value={start}
            onChange={(e) => setStart(Number(e.target.value))}
            style={{ flex: 1 }}
            aria-label={`Slide the ${size}-month window across the career. Showing ${from} to ${to}.`}
          />
          <span className="xs mono" style={{ whiteSpace: 'nowrap' }}>{from} — {to}</span>
        </div>
      ) : null}

      <p className="xs muted" style={{ margin: 0 }}>
        The line joins the months this pilot trained — each marked with a point — so it shows the
        direction between sessions, not a grade for every month. {sessions === 0
          ? 'No session in this window.'
          : `${sessions} ${sessions === 1 ? 'session' : 'sessions'} in this window.`}
      </p>
    </div>
  );
}

export default TrendScrubber;
