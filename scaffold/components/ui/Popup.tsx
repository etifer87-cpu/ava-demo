'use client';

import { useId, useRef, type ReactNode } from 'react';

/**
 * Popup - a native <dialog>, opened by the button it wraps. The second client component in the
 * shell (NavLinks is the first), and a client component for one reason: showModal() is a DOM call.
 *
 * Everything inside it is rendered on the server and passed in as children: the dialog carries no
 * state, fetches nothing, and is fully in the HTML before hydration - which is why the smoke run
 * can see its contents and why it works with JavaScript disabled as a details-like disclosure
 * (the button is a real button; without hydration the content simply is not shown, never a broken
 * screen). Closing is the dialog's own form method="dialog"; Escape works natively.
 */
export interface PopupProps {
  readonly label: ReactNode;
  readonly title: ReactNode;
  readonly children: ReactNode;
  readonly buttonClassName?: string;
  readonly testId?: string;
}

export function Popup({ label, title, children, buttonClassName = 'button button-quiet', testId }: PopupProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  return (
    <>
      <button type="button" className={buttonClassName} onClick={() => ref.current?.showModal()} aria-haspopup="dialog" aria-controls={id}>
        {label}
      </button>
      <dialog ref={ref} id={id} className="popup" data-testid={testId} aria-labelledby={`${id}-title`}>
        <div className="popup-head">
          <h2 id={`${id}-title`} className="card-title" style={{ margin: 0 }}>{title}</h2>
          <span className="spacer" />
          <form method="dialog">
            <button className="button button-quiet" type="submit" aria-label="Close">Close</button>
          </form>
        </div>
        <div className="popup-body">{children}</div>
      </dialog>
    </>
  );
}

export default Popup;
