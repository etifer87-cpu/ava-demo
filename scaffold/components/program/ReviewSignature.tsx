'use client';

import { useRef, useState } from 'react';

/**
 * ReviewSignature - the two signature blocks at the foot of the record, and the objection.
 *
 * Client component because the objection is a modal that must not close on a stray click. In
 * PREVIEW (no session) the buttons open the same screens the instructor and the trainee will see,
 * and the final Sign is inert with a line saying what it will do; in delivery the same component
 * posts the signature. The wording comes from policy.yaml, never from here.
 */
export interface ReviewSignatureProps {
  readonly preview: boolean;
  readonly assessorStatement: string;
  readonly subjectStatement: string;
  readonly subjectExtra: string | null;
  readonly objection: { readonly allowed: boolean; readonly label: string; readonly prompt: string; readonly marksRecord: string; readonly notifiesRole: string };
  readonly assessorLabel: string;
  readonly subjectLabel: string;
}

export function ReviewSignature({ preview, assessorStatement, subjectStatement, subjectExtra, objection, assessorLabel, subjectLabel }: ReviewSignatureProps) {
  const dialog = useRef<HTMLDialogElement | null>(null);
  const [reason, setReason] = useState('');
  const [signedBy, setSignedBy] = useState('');
  const open = () => { const d = dialog.current; if (d && !d.open) d.showModal(); };
  const close = () => { dialog.current?.close(); };
  const previewNote = preview ? 'Preview: nothing is recorded. In a live session this signs the record.' : null;

  return (
    <div className="signatures" data-testid="review-signatures">
      <div className="sig-block">
        <div className="xs muted" style={{ letterSpacing: '0.04em' }}>INSTRUCTOR</div>
        <div className="small"><strong>{assessorLabel}</strong></div>
        <p className="sig-statement">{assessorStatement}</p>
        <div className="row">
          <button type="button" className="button" disabled={preview} title={previewNote ?? undefined}>Sign</button>
          {preview ? <span className="xs muted">Awaiting signature</span> : null}
        </div>
      </div>

      <div className="sig-block">
        <div className="xs muted" style={{ letterSpacing: '0.04em' }}>TRAINEE</div>
        <div className="small"><strong>{subjectLabel}</strong></div>
        <p className="sig-statement">{subjectStatement}{subjectExtra ? <><br /><strong>{subjectExtra}</strong></> : null}</p>
        <div className="row">
          <button type="button" className="button" disabled={preview} title={previewNote ?? undefined}>Sign</button>
          {objection.allowed ? <button type="button" className="button button-quiet" onClick={open}>{objection.label}</button> : null}
          {preview ? <span className="xs muted">Awaiting signature</span> : null}
        </div>
      </div>

      <dialog ref={dialog} className="modal" aria-labelledby="obj-title" onCancel={(e) => e.preventDefault()}>
        <div className="stack" data-testid="objection-dialog">
          <h2 id="obj-title" className="card-title" style={{ margin: 0 }}>{objection.label}</h2>
          <p className="small muted" style={{ margin: 0 }}>{objection.prompt}</p>
          <div className="field"><label htmlFor="obj-reason">Reasons *</label><textarea id="obj-reason" rows={5} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={4000} /></div>
          <div className="field"><label htmlFor="obj-sign">Your name, to sign the objection *</label><input id="obj-sign" value={signedBy} onChange={(e) => setSignedBy(e.target.value)} autoComplete="off" /></div>
          <p className="xs muted" style={{ margin: 0 }}>Signing the objection marks the record <strong>{objection.marksRecord}</strong> and sends it to the {objection.notifiesRole.replace(/_/g, ' ')} for review.{preview ? ' In this preview nothing is recorded.' : ''}</p>
          <div className="row">
            <button type="button" className="button" disabled={preview || reason.trim().length < 3 || signedBy.trim().length < 2} onClick={close}>Sign the objection</button>
            <button type="button" className="button button-quiet" onClick={() => { setReason(''); setSignedBy(''); close(); }}>Cancel</button>
          </div>
        </div>
      </dialog>
    </div>
  );
}

export default ReviewSignature;
