'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import type { InitialCard, MilestoneSession, StageDef } from '@/lib/training/initial';
import { RecordArticle, outcomeTone, type RecordListRow } from '@/components/program/RecordDialog';

/**
 * InitialKanban - the initial-training board.
 *
 * One column per course stage (from policy.yaml training_status.stages) plus "released"; one
 * swimlane per course. A card sits in the column of the first milestone not yet complete, so a
 * pilot moves the moment a session is signed - nobody drags anything. Card: name · seat/base ·
 * progress bar · stage counter (FFS n/N, sectors n/N with take-offs and landings as PF) · next
 * planned session · RAG dot. Click a card for the pop-up: milestone timeline, every session in
 * the course and the sector-by-sector LFUS table; click a flown session for its record, fetched
 * from /api/records/[id] on demand. Pop-ups close only with the ✕ Close button.
 *
 * Lanes start collapsed; the user opens the course they want. The counters above the board are
 * filters: click "at risk" and only those pilots stay on the board (their lanes open by
 * themselves); click again to clear.
 */

export interface BoardPilot {
  id: string; seniority_number: number | null; external_id: string; full_name: string; position: string | null; fleet: string | null; base: string | null; training_course: string | null;
  card: InitialCard;
}

const stateTone = (s: string) => s === 'done' ? 'chip chip-good' : s === 'current' ? 'chip chip-info' : s === 'planned' ? 'chip chip-warn' : 'chip';
const ragTitle = { good: 'On track', warn: 'Behind schedule - a planned session is past its date', bad: 'At risk - a failed session, an objection or additional training recommended' } as const;

export function InitialKanban({ pilots, stages, releasedLabel, today, finishingDays }: { readonly pilots: readonly BoardPilot[]; readonly stages: readonly StageDef[]; readonly releasedLabel: string; readonly today: string; readonly finishingDays: number }) {
  const dialog = useRef<HTMLDialogElement | null>(null);
  const recDialog = useRef<HTMLDialogElement | null>(null);
  const [open, setOpen] = useState<BoardPilot | null>(null);
  const [record, setRecord] = useState<RecordListRow | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'training' | 'lfus' | 'finishing' | 'behind' | 'risk' | 'released' | null>(null);

  const show = (p: BoardPilot) => { setOpen(p); dialog.current?.showModal(); };
  const close = () => { dialog.current?.close(); setOpen(null); };
  const openRecord = async (s: MilestoneSession) => {
    if (!s.record_id || loading) return;
    setLoading(s.id); setError(null);
    try {
      const res = await fetch(`/api/records/${s.record_id}`, { headers: { accept: 'application/json' } });
      const body = (await res.json()) as { ok: boolean; record?: RecordListRow; error?: string };
      if (!res.ok || !body.record) throw new Error(body.error ?? `HTTP ${res.status}`);
      setRecord(body.record); recDialog.current?.showModal();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load the record'); }
    finally { setLoading(null); }
  };
  const closeRecord = () => { recDialog.current?.close(); setRecord(null); };

  const columns = [...stages.map((s) => ({ key: s.key, label: s.label })), { key: 'released', label: releasedLabel }];
  const courses = [...new Set(pilots.map((p) => p.training_course ?? '—'))].sort();
  const finishBy = new Date(`${today}T00:00:00Z`); finishBy.setUTCDate(finishBy.getUTCDate() + finishingDays);
  const finishIso = finishBy.toISOString().slice(0, 10);
  const lastStage = stages.at(-1)?.key;
  const test = {
    training: (p: BoardPilot) => !p.card.released,
    lfus: (p: BoardPilot) => p.card.stage === 'lfus',
    finishing: (p: BoardPilot) => !p.card.released && !!p.card.next && p.card.next.stage === lastStage && p.card.next.date <= finishIso,
    behind: (p: BoardPilot) => p.card.rag === 'warn',
    risk: (p: BoardPilot) => p.card.rag === 'bad',
    released: (p: BoardPilot) => p.card.released,
  } as const;
  const kpi = Object.fromEntries((Object.keys(test) as (keyof typeof test)[]).map((k) => [k, pilots.filter(test[k]).length])) as Record<keyof typeof test, number>;
  const shown = filter ? pilots.filter(test[filter]) : pilots;
  const toggle = (k: keyof typeof test) => setFilter((f) => (f === k ? null : k));
  const Counter = ({ k, tone, dot, label }: { k: keyof typeof test; tone?: string; dot?: boolean; label: string }) => (
    <button type="button" className={`chip chip-click ${tone ?? ''} ${filter === k ? 'chip-on' : ''}`} onClick={() => toggle(k)} aria-pressed={filter === k} title={filter === k ? 'Show everyone' : `Show only these pilots`}>
      {dot ? <span className="chip-dot" aria-hidden="true" /> : null}<strong>{kpi[k]}</strong>&nbsp;{label}
    </button>
  );
  const counter = (p: BoardPilot) => {
    const c = p.card;
    if (c.stage === 'simulator') return <>FFS <strong>{c.ffs.done}</strong>/{c.ffs.total}</>;
    if (c.stage === 'lfus') return <>Sectors <strong>{c.lfus.flown}</strong>/{c.lfus.total} · PF <strong>{c.lfus.pf}</strong></>;
    if (c.released) return <>Sectors {c.lfus.flown} · PF {c.lfus.pf}</>;
    return null;
  };
  const sess = open?.card.milestones.flatMap((m) => m.sessions) ?? [];
  const lfus = open?.card.milestones.find((m) => m.key === 'lfus')?.sessions ?? [];
  const others = sess.filter((s) => s.stage !== 'lfus');

  return (
    <div className="stack" data-testid="initial-board">
      <div className="row" style={{ gap: 'var(--space-2)' }}>
        <Counter k="training" label="in training" />
        <Counter k="lfus" tone="chip-info" label="in LFUS" />
        <Counter k="finishing" label={`line check within ${finishingDays} days`} />
        <Counter k="behind" tone="chip-warn" dot label="behind schedule" />
        <Counter k="risk" tone="chip-bad" dot label="at risk" />
        <Counter k="released" tone="chip-good" label="released" />
        {filter ? <button type="button" className="button button-quiet xs" onClick={() => setFilter(null)}>Show all {pilots.length}</button> : null}
      </div>

      <div className="kanban-wrap">
        <div className="kanban" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(190px, 1fr))` }}>
          {columns.map((c) => <div key={c.key} className="kanban-head">{c.label} <span className="kanban-count">{shown.filter((p) => p.card.stage === c.key).length}</span></div>)}
          {courses.map((course) => { const lane = shown.filter((p) => (p.training_course ?? '—') === course); return (
            <details key={`${course}-${filter ?? 'all'}`} className="kanban-lane" style={{ gridColumn: `1 / span ${columns.length}` }} open={filter !== null && lane.length > 0}>
              <summary className="kanban-lane-title"><span className="mono">{course}</span> <span className="muted small">· {lane.length} pilot{lane.length === 1 ? '' : 's'}{filter ? ` of ${pilots.filter((p) => (p.training_course ?? '—') === course).length}` : ''}</span></summary>
              <div className="kanban" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(190px, 1fr))` }}>
                {columns.map((c) => (
                  <div key={c.key} className="kanban-col">
                    {lane.filter((p) => p.card.stage === c.key).map((p) => (
                      <button type="button" key={p.id} className="kanban-card" onClick={() => show(p)} data-testid={`board-card-${p.external_id}`}>
                        <div className="row" style={{ gap: 'var(--space-1)', alignItems: 'center', flexWrap: 'nowrap' }}>
                          <span className={`rag rag-${p.card.rag}`} title={ragTitle[p.card.rag]} aria-label={ragTitle[p.card.rag]} />
                          <strong className="kanban-name">{p.full_name}</strong>
                        </div>
                        <div className="xs muted">{p.position ?? '—'} · {p.fleet ?? '—'} · {p.base ?? '—'} · <span className="mono">{p.seniority_number ?? p.external_id}</span></div>
                        <span className="kanban-bar" aria-label={`${p.card.progress}% of the course`}><span style={{ width: `${p.card.progress}%` }} /></span>
                        <div className="xs row" style={{ gap: 'var(--space-2)', justifyContent: 'space-between', flexWrap: 'nowrap' }}>
                          <span>{counter(p)}</span><span className="muted">{p.card.progress}%</span>
                        </div>
                        <div className="xs muted">{p.card.next ? <>next {stages.find((s) => s.key === p.card.next!.stage)?.label ?? p.card.next.stage} · <span className="mono">{p.card.next.date}</span></> : p.card.released ? 'course complete' : 'nothing planned'}</div>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </details>
          ); })}
        </div>
      </div>
      <p className="xs muted" style={{ margin: 0 }}>Cards move on their own: a pilot sits in the first stage with a session still to fly, and moves the moment the last session of a stage is signed. Open a course to see its pilots; click a card for the milestones and every sector flown.</p>

      <dialog ref={dialog} className="modal modal-wide" aria-labelledby="board-title" onCancel={(e) => e.preventDefault()}>
        {open ? (
          <div className="stack">
            <div className="row" style={{ alignItems: 'baseline' }}>
              <h2 id="board-title" className="card-title" style={{ margin: 0 }}><Link href={`/subjects/${open.id}`}>{open.full_name}</Link></h2>
              <span className="small muted">{open.position ?? '—'} · {open.fleet ?? '—'} · {open.base ?? '—'} · seniority <span className="mono">{open.seniority_number ?? open.external_id}</span> · course <span className="mono">{open.training_course}</span></span>
              <span className="spacer" />
              <span className={open.card.released ? 'chip chip-good' : 'chip chip-info'}><span className="chip-dot" aria-hidden="true" />{open.card.stageLabel}</span>
              <button type="button" className="button button-quiet xs" onClick={close} aria-label="Close">✕ Close</button>
            </div>

            <div className="row" style={{ alignItems: 'center' }}>
              <span className={`rag rag-${open.card.rag}`} aria-hidden="true" /><span className="small">{ragTitle[open.card.rag]}</span>
              <span className="spacer" />
              <span className="small"><strong>{open.card.progress}%</strong> of the course</span>
              <span className="kanban-bar" style={{ width: 200 }}><span style={{ width: `${open.card.progress}%` }} /></span>
            </div>

            <ol className="timeline">
              {open.card.milestones.map((m) => (
                <li key={m.key} className={`timeline-item timeline-${m.state}`}>
                  <span className="timeline-dot" aria-hidden="true" />
                  <div className="row" style={{ gap: 'var(--space-2)', alignItems: 'baseline' }}>
                    <strong>{m.label}</strong>
                    <span className={stateTone(m.state)}>{m.state === 'done' ? 'Complete' : m.state === 'current' ? 'In progress' : m.state === 'planned' ? 'Planned' : 'Not scheduled'}</span>
                    {m.outcome ? <span className={outcomeTone(m.outcome)}><span className="chip-dot" aria-hidden="true" />{m.outcome}</span> : null}
                    <span className="xs muted mono">{m.from ? m.from === m.to ? m.from : `${m.from} → ${m.to}` : '—'}</span>
                    {m.total > 1 ? <span className="xs muted">{m.done} of {m.total} sessions{m.key === 'lfus' ? ` · ${open.card.lfus.pf} take-offs and landings as PF` : ''}</span> : null}
                  </div>
                </li>
              ))}
              {open.card.released ? <li className="timeline-item timeline-done"><span className="timeline-dot" aria-hidden="true" /><strong>{releasedLabel}</strong></li> : null}
            </ol>

            {error ? <div className="notice notice-bad"><p style={{ margin: 0 }}>{error}</p></div> : null}

            {others.length ? (
              <table className="data">
                <caption>Ground school, simulator and checks <span className="muted">- click a flown session for its record</span></caption>
                <thead><tr><th scope="col" className="num">Date</th><th scope="col">Stage</th><th scope="col">Session</th><th scope="col">Instructor</th><th scope="col">Status</th></tr></thead>
                <tbody>{others.map((s) => (
                  <tr key={s.id} className={s.record_id ? 'row-click' : undefined} onClick={() => openRecord(s)} tabIndex={s.record_id ? 0 : undefined} onKeyDown={(e) => { if (s.record_id && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); void openRecord(s); } }} role={s.record_id ? 'button' : undefined}>
                    <td className="num mono">{s.session_date}</td>
                    <td>{stages.find((x) => x.key === s.stage)?.label ?? s.stage}</td>
                    <td>{s.template_name ?? '—'}{s.session_number ? <span className="xs muted"> · session {s.session_number}</span> : null}{s.check ? <span className="xs muted"> · {s.check}</span> : null}</td>
                    <td>{s.assessor_name ?? <span className="muted">—</span>}</td>
                    <td>{s.status === 'in_progress' ? <span className={`chip ${s.session_date < today ? 'chip-warn' : ''}`}>{s.session_date < today ? 'Overdue' : 'Planned'}</span> : <span className={outcomeTone(s.outcome)}><span className="chip-dot" aria-hidden="true" />{s.outcome ?? 'flown'}{s.objected ? ' · objected' : ''}{s.additional_training ? ' · additional training' : ''}</span>}{loading === s.id ? <span className="xs muted"> loading…</span> : null}</td>
                  </tr>
                ))}</tbody>
              </table>
            ) : null}

            {lfus.length ? (
              <table className="data" data-testid="board-sectors">
                <caption>Line training sectors <span className="muted">- {open.card.lfus.flown} of {open.card.lfus.total} flown · {open.card.lfus.pf} take-offs and landings as PF · click a sector for its record</span></caption>
                <thead><tr><th scope="col" className="num">Sector</th><th scope="col" className="num">Date</th><th scope="col">Route</th><th scope="col">Seat</th><th scope="col">Aircraft</th><th scope="col">Instructor</th><th scope="col">Outcome</th></tr></thead>
                <tbody>{lfus.map((s) => (
                  <tr key={s.id} className={s.record_id ? 'row-click' : undefined} onClick={() => openRecord(s)} tabIndex={s.record_id ? 0 : undefined} onKeyDown={(e) => { if (s.record_id && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); void openRecord(s); } }} role={s.record_id ? 'button' : undefined}>
                    <td className="num mono">{s.sector_number ?? '—'}</td>
                    <td className="num mono">{s.session_date}</td>
                    <td className="mono">{s.departure && s.arrival ? `${s.departure} – ${s.arrival}` : '—'}</td>
                    <td>{s.seat ? <strong>{s.seat}</strong> : '—'}</td>
                    <td className="mono xs">{s.aircraft_type ?? '—'}{s.registration ? ` · ${s.registration}` : ''}</td>
                    <td>{s.assessor_name ?? <span className="muted">—</span>}</td>
                    <td>{s.status === 'in_progress' ? <span className={`chip ${s.session_date < today ? 'chip-warn' : ''}`}>{s.session_date < today ? 'Overdue' : 'Planned'}</span> : <span className={outcomeTone(s.outcome)}><span className="chip-dot" aria-hidden="true" />{s.outcome ?? 'flown'}{s.objected ? ' · objected' : ''}</span>}{loading === s.id ? <span className="xs muted"> loading…</span> : null}</td>
                  </tr>
                ))}</tbody>
              </table>
            ) : null}
          </div>
        ) : null}
      </dialog>

      <dialog ref={recDialog} className="modal modal-wide" aria-label="Record" onCancel={(e) => e.preventDefault()}>
        {record ? <RecordArticle record={record} onClose={closeRecord} /> : null}
      </dialog>
    </div>
  );
}

export default InitialKanban;
