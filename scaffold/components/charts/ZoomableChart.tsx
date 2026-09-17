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
 * components and there is nothing to move: React renders the same tree in both places. That is only
 * safe because the charts on this page carry no element ids; a chart that namespaces gradient or
 * clip-path ids would collide with its own copy and render blank in one of them. If a chart with
 * ids is ever wrapped here, give the dialog copy its own `id` prop.
 *
 * Client component, deliberately the ONLY one in this panel: the figures, the arithmetic and the
 * SVG all stay on the server. This holds one boolean.
 */
export function ZoomableChart({
  title, children, hint = 'Click to enlarge',
}: {
  readonly title: string;
  readonly children: ReactNode;
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
        className="modal modal-wide"
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
          {open ? children : null}
        </div>
      </dialog>
    </>
  );
}

export default ZoomableChart;
