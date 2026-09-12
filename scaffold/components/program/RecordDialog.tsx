'use client';

import { useRef, useState } from 'react';

/**
 * RecordsTable - the pilot's records, one row per record, click to open the record in a pop-up.
 *
 * The pop-up renders the record's own SNAPSHOT (records.snapshot): the frozen copy written at
 * signature, which carries the template name, the exercises with grades and remarks, the
 * competencies with grades and the observable behaviours selected, the outcome, both signatures
 * and any objection. No template lookup, so a record renders the same after its program is
 * retired. Rows come from the server already paged; nothing is fetched from the client.
 */

export interface RecordSnapshot {
  kind?: string;
  tasks?: { element_key: string; task_name: string; attempt: number; grade: string | null; remark: string | null; pf_pm?: string | null; role?: string | null }[];
  competency_scores?: { code: string; name: string; score: number }[];
  competency_results?: { code: string; name: string; result: string }[];
  competency_remarks?: { code: string; remark: string }[];
  observable_behaviours?: { competency: string; code: string; text: string }[];
  template?: { code: string; name: string; kind?: string; kind_label?: string; version?: number };
  subject?: { external_id: string; full_name: string; position: string | null; seat?: string };
  assessor?: { external_id: string; full_name: string; roles?: string[] };
  session?: { date?: string; facility?: string; check?: string; departure?: string; arrival?: string; aircraft_type?: string; sector_number?: number };
  signatures?: { assessor_at: string | null; subject_at: string | null };
  objection?: { reason: string; by: string; at: string };
  outcome?: string | null;
  additional_training?: boolean;
}

export interface RecordListRow {
  id: string;
  training_date: string;
  title: string;
  record_kind: string | null;
  asset_class: string | null;
  outcome: string | null;
  outcome_override: string | null;
  assessor_name: string | null;
  competency_count: string;
  is_hidden_from_subject: boolean;
  snapshot: RecordSnapshot;
}

const fmt = (iso: string | null | undefined) => (iso ? iso.slice(0, 16).replace('T', ' ') + (iso.length > 16 ? ' UTC' : '') : '—');

export function RecordsTable({ rows, subjectLabel, showSubject = false }: { readonly rows: readonly RecordListRow[]; readonly subjectLabel: string; readonly showSubject?: boolean }) {
  const dialog = useRef<HTMLDialogElement | null>(null);
  const [open, setOpen] = useState<RecordListRow | null>(null);
  const show = (r: RecordListRow) => { setOpen(r); dialog.current?.showModal(); };
  const close = () => { dialog.current?.close(); setOpen(null); };

  return (
    <>
      <table className="data" data-testid="subject-record-list">
        <caption>Records, most recent first <span className="muted">- click a row to open the record</span></caption>
        <thead><tr><th scope="col" className="num">Date</th><th scope="col">Record</th><th scope="col">Kind</th><th scope="col">Fleet</th><th scope="col">{showSubject ? 'Trainee' : 'Instructor'}</th><th scope="col">Outcome</th><th scope="col" className="num">Competencies</th></tr></thead>
        <tbody>
          {rows.length === 0 ? <tr><td colSpan={7} className="muted small">No records yet for this {subjectLabel.toLowerCase()}.</td></tr> : rows.map((r) => (
            <tr key={r.id} className="row-click" onClick={() => show(r)} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show(r); } }} role="button" aria-label={`Open record ${r.title}`}>
              <td className="num mono">{r.training_date}</td>
              <td>{r.snapshot.template?.name ?? r.title}{r.snapshot.session?.check ? <span className="xs muted"> · {r.snapshot.session.check}</span> : null}{r.snapshot.session?.sector_number ? <span className="xs muted"> · sector {r.snapshot.session.sector_number}</span> : null}{r.is_hidden_from_subject ? <span className="xs muted"> · internal</span> : null}</td>
              <td>{r.record_kind ?? <span className="muted">-</span>}</td>
              <td>{r.asset_class ?? <span className="muted">-</span>}</td>
              <td>{showSubject ? (r.snapshot.subject?.full_name ?? <span className="muted">-</span>) : (r.assessor_name ?? <span className="muted">-</span>)}</td>
              <td>{r.outcome_override ? <span className="chip chip-info"><span className="chip-dot" aria-hidden="true" />{r.outcome_override} (amended)</span> : r.outcome ? <span className={outcomeTone(r.outcome)}><span className="chip-dot" aria-hidden="true" />{r.outcome}</span> : <span className="muted">-</span>}</td>
              <td className="num">{r.competency_count}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <dialog ref={dialog} className="modal modal-wide" aria-labelledby="rec-title" onCancel={(e) => e.preventDefault()}>
        {open ? <RecordArticle record={open} onClose={close} /> : null}
      </dialog>
    </>
  );
}

export const outcomeTone = (o: string | null | undefined) => !o ? 'chip' : /FAIL|NOT|INCOMPLETE/.test(o) ? 'chip chip-bad' : /PARTIAL|PENDING/.test(o) ? 'chip chip-warn' : 'chip chip-good';

/** The record itself, rendered from its snapshot. Used inside the records pop-up here and inside the initial-training board's sector pop-up. */
export function RecordArticle({ record: open, onClose: close }: { readonly record: RecordListRow; readonly onClose: () => void }) {
  const s = open.snapshot ?? {};
  const scores = new Map((s.competency_scores ?? []).map((c) => [c.code, c]));
  const results = new Map((s.competency_results ?? []).map((c) => [c.code, c]));
  const remarks = new Map((s.competency_remarks ?? []).map((c) => [c.code, c.remark]));
  const obs = new Map<string, { code: string; text: string }[]>();
  for (const ob of s.observable_behaviours ?? []) { if (!obs.has(ob.competency)) obs.set(ob.competency, []); obs.get(ob.competency)!.push(ob); }
  const compCodes = [...new Set([...scores.keys(), ...results.keys()])];
  const repeated = (s.tasks ?? []).some((t) => t.attempt > 1); // the Attempt column only when an exercise was flown twice

  return (
    <article className="report" data-testid="record-dialog">
      <header className="report-head">
        <div className="row" style={{ alignItems: 'baseline' }}>
          <div className="report-brand">{s.template?.kind_label ?? open.record_kind ?? 'Record'}</div>
          <span className="spacer" />
          <span className={outcomeTone(open.outcome)}><span className="chip-dot" aria-hidden="true" />{open.outcome ?? 'no outcome'}</span>
          <button type="button" className="button button-quiet xs" onClick={close} aria-label="Close">✕ Close</button>
        </div>
        <h2 id="rec-title" style={{ margin: 'var(--space-2) 0 0' }}>{s.template?.name ?? open.title}</h2>
        <dl className="report-meta">
          <div><dt>Date</dt><dd>{open.training_date}</dd></div>
          <div><dt>{s.session?.departure ? 'Route' : 'Facility'}</dt><dd>{s.session?.departure ? `${s.session.departure} – ${s.session.arrival}${s.session.sector_number ? ` · sector ${s.session.sector_number}` : ''}` : s.session?.facility ?? '—'}</dd></div>
          <div><dt>{s.session?.check ? 'Check' : 'Fleet'}</dt><dd>{s.session?.check ?? s.session?.aircraft_type ?? open.asset_class ?? '—'}</dd></div>
          <div><dt>{open.is_hidden_from_subject ? 'Candidate' : 'Trainee'}</dt><dd>{s.subject?.full_name ?? '—'}{s.subject?.seat ? <span className="xs muted"> · {s.subject.seat}</span> : null}</dd></div>
          <div><dt>Position</dt><dd>{s.subject?.position ?? '—'}</dd></div>
          <div><dt>Instructor</dt><dd>{s.assessor?.full_name ?? open.assessor_name ?? '—'}{s.assessor?.roles?.length ? <span className="xs muted"> · {s.assessor.roles.join(' ')}</span> : null}</dd></div>
        </dl>
      </header>

      {s.objection ? <div className="notice notice-bad"><p style={{ margin: 0 }}><strong>Objection by the trainee.</strong> {s.objection.by}, {fmt(s.objection.at)}: “{s.objection.reason}”</p></div> : null}

      {(s.tasks ?? []).length ? (
        <table className="data report-table">
          <thead><tr><th scope="col">Exercise</th>{repeated ? <th scope="col" className="num">Attempt</th> : null}<th scope="col" className="num">Grade</th><th scope="col">Remark</th></tr></thead>
          <tbody>{(s.tasks ?? []).map((t, i) => (
            <tr key={`${t.element_key}-${t.attempt}-${i}`}>
              <td>{t.task_name}{t.pf_pm && t.role ? <span className="xs" style={{ marginLeft: 'var(--space-2)', fontWeight: 600 }}>as {t.role}</span> : null}</td>
              {repeated ? <td className="num">{t.attempt}</td> : null}
              <td className="num"><strong>{t.grade ?? '—'}</strong></td>
              <td className="small">{t.remark ?? <span className="muted">—</span>}</td>
            </tr>
          ))}</tbody>
        </table>
      ) : null}

      {compCodes.length ? (
        <table className="data report-table" style={{ marginTop: 'var(--space-3)' }}>
          <thead><tr><th scope="col">Competency</th><th scope="col" className="num">Grade</th><th scope="col">Observable behaviours</th><th scope="col">Remark</th></tr></thead>
          <tbody>{compCodes.map((code) => {
            const sc = scores.get(code); const rs = results.get(code);
            return (
              <tr key={code}>
                <td><span className="mono">{code}</span> <span className="small muted">{sc?.name ?? rs?.name ?? ''}</span></td>
                <td className="num"><strong>{sc ? sc.score : rs?.result === 'C' ? 'Competent' : rs?.result === 'NC' ? 'Not competent' : rs?.result ?? '—'}</strong></td>
                <td className="xs">{(obs.get(code) ?? []).length ? (obs.get(code) ?? []).map((ob) => <div key={ob.code}><span className="mono">{ob.code}</span> {ob.text}</div>) : <span className="muted">—</span>}</td>
                <td className="small">{remarks.get(code) ?? <span className="muted">—</span>}</td>
              </tr>
            );
          })}</tbody>
        </table>
      ) : null}

      <section className="report-outcome" style={{ marginTop: 'var(--space-3)' }}>
        <div className="row" style={{ alignItems: 'center' }}>
          <span className="xs muted" style={{ letterSpacing: '0.04em' }}>OUTCOME</span>
          <span className="outcome-value">{open.outcome ?? '—'}</span>
          {s.additional_training ? <span className="chip chip-warn"><span className="chip-dot" aria-hidden="true" />Additional training recommended</span> : null}
        </div>
      </section>

      <div className="signatures">
        <div className="sig-block">
          <div className="xs muted" style={{ letterSpacing: '0.04em' }}>INSTRUCTOR</div>
          <div className="small"><strong>{s.assessor?.full_name ?? open.assessor_name ?? '—'}</strong></div>
          {s.signatures?.assessor_at ? <span className="chip chip-good"><span className="chip-dot" aria-hidden="true" />Signed · {fmt(s.signatures.assessor_at)}</span> : <span className="chip chip-warn"><span className="chip-dot" aria-hidden="true" />Not signed</span>}
        </div>
        <div className="sig-block">
          <div className="xs muted" style={{ letterSpacing: '0.04em' }}>{open.is_hidden_from_subject ? 'INTERNAL RECORD' : 'TRAINEE'}</div>
          {open.is_hidden_from_subject ? <p className="small" style={{ margin: 0 }}>Not visible to the candidate; assessor signature only.</p> : (
            <>
              <div className="small"><strong>{s.subject?.full_name ?? '—'}</strong></div>
              {s.objection ? <span className="chip chip-bad"><span className="chip-dot" aria-hidden="true" />Objected · {fmt(s.objection.at)}</span> : s.signatures?.subject_at ? <span className="chip chip-good"><span className="chip-dot" aria-hidden="true" />Signed · {fmt(s.signatures.subject_at)}</span> : <span className="chip chip-warn"><span className="chip-dot" aria-hidden="true" />Not signed</span>}
            </>
          )}
        </div>
      </div>
      <footer className="xs muted mono" style={{ marginTop: 'var(--space-3)' }}>record {open.id.slice(0, 8)} · {s.template?.code ?? ''} · both signatures attest to this content.</footer>
    </article>
  );
}

export default RecordsTable;
