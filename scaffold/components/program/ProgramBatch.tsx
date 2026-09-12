'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';

/**
 * ProgramBatch - the Archive / Delete buttons for the Programs list. Client component.
 *
 * The row checkboxes belong to the form `batch` through their `form` attribute, so this component
 * owns no selection state of its own: it counts the checked boxes on every change and shows the
 * buttons only while at least one is ticked. Publish and Archive submit at once. Delete opens a modal
 * that asks for a reason and the password; the modal closes only through Cancel or a submit -
 * clicking outside or pressing Escape does nothing, because a half-typed reason lost to a stray
 * click is how deletions get re-attempted without one.
 */
export function ProgramBatch({ status, mode }: { readonly status: string; readonly mode: 'active' | 'archived' }) {
  const [count, setCount] = useState(0);
  const dialog = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const recount = () => setCount(document.querySelectorAll<HTMLInputElement>('input[name="ids"][form="batch"]:checked').length);
    recount();
    document.addEventListener('change', recount);
    return () => document.removeEventListener('change', recount);
  }, []);

  const open = () => { const d = dialog.current; if (d && !d.open) d.showModal(); };
  const close = () => dialog.current?.close();
  const [problem, setProblem] = useState<string | null>(null);
  // Only a Delete submit needs the reason and the password; Archive / Restore submit the same form
  // without them (formNoValidate), so the check is on the submitter, not on the fields.
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    if (submitter?.value !== 'delete') return;
    const f = e.currentTarget;
    const reason = (f.elements.namedItem('reason') as HTMLTextAreaElement | null)?.value.trim() ?? '';
    const password = (f.elements.namedItem('password') as HTMLInputElement | null)?.value ?? '';
    if (reason.length < 3) { e.preventDefault(); setProblem('Give a reason of at least three characters.'); return; }
    if (!password) { e.preventDefault(); setProblem('Your password is required.'); return; }
    setProblem(null);
  };

  return (
    <form id="batch" method="post" action="/api/templates" className="batch-bar" data-testid="program-batch" hidden={count === 0} onSubmit={onSubmit}>
      <input type="hidden" name="status" value={status} />
      <span className="small muted">{count} selected</span>
      <span className="spacer" />
      {mode === 'archived'
        ? <button className="button button-quiet" type="submit" name="_action" value="unarchive" formNoValidate>Restore</button>
        : <><button className="button button-quiet" type="submit" name="_action" value="publish" formNoValidate title="Publish the current draft of each selected program">Publish</button><button className="button button-quiet" type="submit" name="_action" value="archive" formNoValidate>Archive</button></>}
      <button className="button" type="button" onClick={open}>Delete</button>

      <dialog ref={dialog} className="modal" aria-labelledby="del-title" onCancel={(e) => e.preventDefault()}>
        <div className="stack" data-testid="program-delete-form">
          <h2 id="del-title" className="card-title" style={{ margin: 0 }}>Delete {count} program{count === 1 ? '' : 's'}</h2>
          <p className="small muted" style={{ margin: 0 }}>The reason and your name go to the app log with the deletion. A program that sessions have used is not deleted; archive it instead.</p>
          <div className="field"><label htmlFor="del-reason">Reason *</label><textarea id="del-reason" name="reason" rows={3} maxLength={500} /></div>
          <div className="field"><label htmlFor="del-password">Your password *</label><input id="del-password" name="password" type="password" autoComplete="current-password" /></div>
          {problem ? <p className="small" style={{ margin: 0, color: 'var(--state-bad)' }} role="alert">{problem}</p> : null}
          <div className="row">
            <button className="button" type="submit" name="_action" value="delete">Delete</button>
            <button className="button button-quiet" type="button" onClick={close}>Cancel</button>
          </div>
        </div>
      </dialog>
    </form>
  );
}

export default ProgramBatch;
