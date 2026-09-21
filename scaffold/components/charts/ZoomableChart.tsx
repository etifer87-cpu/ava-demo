'use client';

import { useCallback, useRef, useState, type ReactNode } from 'react';

/**
 * ZoomableChart - click a chart to open it large, Escape or the backdrop to close.
 *
 * WHY A <dialog> AND NOT A CSS OVERLAY. A native dialog takes focus, traps it, closes on Escape and
 * is announced as a dialog, all without a line of code. The same markup on a div would need every
 * one of those written by hand and would get one of them wrong.
 *
 * THE CHART IS RENDERED TWICE - inline and inside the dialog - because the charts are server
 * components and there is nothing to move: React renders the same tree in both places.
 *
 * MOST CHARTS NAMESPACE THEIR ELEMENT IDS (see `chartId`), and two copies of the same tree would
 * put the same id in the document twice: the `aria-labelledby` on the second copy resolves to the
 * first copy's <title>, and any `url(#...)` reference picks the wrong target. So a chart with an
 * `id` prop is passed TWICE, by the caller, with two different ids - `dialogChildren` is the
 * enlarged copy. That is also where it gets a bigger `width`, since enlarging is the point.
 *
 * It cannot be a render prop: these callers are server components and a function does not cross
 * the boundary. Two elements do.
 *
 * `TrendCard` has done this by hand since before this component existed (`spark-X` and
 * `spark-big-X`); this is the same idea with the dialog plumbing shared.
 *
 * Client component, deliberately the ONLY one in this panel: the figures, the arithmetic and the
 * SVG all stay on the server. This holds one boolean.
 */
export function ZoomableChart({
  title, children, dialogChildren, hint = 'Click to enlarge',
}: {
  readonly title: string;
  /** The inline copy. */
  readonly children: ReactNode;
  /**
   * The enlarged copy. Omit ONLY for a chart with no element ids of its own; anything built with
   * `chartId` must pass this with a different `id`, or the two copies collide in the document.
   */
  readonly dialogChildren?: ReactNode;
  readonly hint?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);

  const show = useCallback(() => { setOpen(true); ref.current?.showModal(); }, []);
  const hide = useCallback(() => { setOpen(false); ref.current?.close(); }, []);

  return (
    <>
      <button
        type="button"
        className="chart-zoom"
        onClick={show}
        title={hint}
        aria-label={`${title} — ${hint.toLowerCase()}`}
      >
        {children}
        <span className="chart-zoom-hint xs muted" aria-hidden="true">{hint}</span>
      </button>

      <dialog
        ref={ref}
        className="modal modal-chart"
        aria-label={title}
        onClose={() => setOpen(false)}
        /* Clicking the backdrop closes it. The dialog element itself is the event target only when
           the click lands outside its content box, which is exactly the backdrop. */
        onClick={(e) => { if (e.target === ref.current) hide(); }}
      >
        <div className="stack">
          <div className="row" style={{ alignItems: 'baseline' }}>
            <strong>{title}</strong>
            <span className="spacer" />
            <button type="button" className="button button-quiet xs" onClick={hide}>Close</button>
          </div>
          {open ? (dialogChildren ?? children) : null}
        </div>
      </dialog>
    </>
  );
}

export default ZoomableChart;
