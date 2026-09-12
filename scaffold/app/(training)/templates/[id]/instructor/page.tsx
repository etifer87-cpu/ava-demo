import Link from 'next/link';
import { requireSession } from '@/lib/session';
import { resolveAccess, requireCapability } from '@/lib/access';
import { programVocab, ruleRegistry } from '@/lib/program';
import { budgetFor } from '@/lib/program/rules';
import { loadProgramScreen } from '@/lib/program/screens';
import { instructorProjection, type InstructorStep } from '@/lib/program/projection';
import { formatMinutes } from '@/lib/program/shape';
import { phaseColour } from '@/lib/config';
import Breadcrumbs from '@/components/ui/Breadcrumbs';
import Chip from '@/components/ui/Chip';
import BuilderTabs from '@/components/program/BuilderTabs';

/**
 * /templates/[id]/instructor - the program as the instructor will see it at the device.
 *
 * The INSTRUCTOR projection of the real content, with runtime values as placeholders: no pilot,
 * no grades, clocks at zero. A rail on the left lists the sections and every step inside them;
 * the main pane shows one step - `?at=<key>` - with Previous / Next. Read-only: there is no write
 * path on this screen at all. It renders through the same projection the delivery screen will
 * call, so what the manager previews is what the instructor gets. Gate: training.templates.view.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const AUTO: Record<string, string> = { required_on: 'REQUIRED ON', required_off: 'REQUIRED OFF', crew_discretion: 'CREW DISCRETION', not_applicable: 'N/A' };

export default async function InstructorViewPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession();
  const access = await resolveAccess(session);
  requireCapability(access, 'training.templates.view');
  const { id } = await params;
  const sp = await searchParams;
  const { template, program, versionQuery, wantedVersion } = await loadProgramScreen(id, typeof sp.version === 'string' ? sp.version : undefined);
  const vocab = programVocab();
  const view = program ? instructorProjection(program.tree, { runtime: null }) : null;
  const bud = program ? budgetFor(program.tree, ruleRegistry()) : { inside: null, outside: null, excludedPhases: [] as readonly string[] };
  const at = typeof sp.at === 'string' ? sp.at : '';
  const idx = view ? Math.max(0, view.order.findIndex((o) => o.key === at)) : 0;
  const current = view?.order[idx] ?? null;
  const step = current ? view!.sections.flatMap((s) => s.steps).find((s) => s.key === current.key) ?? null : null;
  const section = current ? view!.sections.find((s) => s.key === current.sectionKey) ?? null : null;
  const href = (key: string) => `/templates/${template.id}/instructor?${new URLSearchParams({ ...(wantedVersion ? { version: wantedVersion } : {}), at: key }).toString()}`;
  const prev = view && idx > 0 ? view.order[idx - 1] : null;
  const next = view && idx < view.order.length - 1 ? view.order[idx + 1] : null;

  return (
    <div className="stack builder-page" data-testid="instructor-view">
      <Breadcrumbs items={[{ label: 'Overview', href: '/' }, { label: 'Programs', href: '/templates' }, { label: template.name, href: `/templates/${template.id}${versionQuery}` }, { label: 'As instructor' }]} />
      <div className="row" style={{ alignItems: 'baseline' }}>
        <h1 style={{ margin: 0 }}>{template.name}</h1>
        <span className="xs muted">as the instructor sees it</span>
        <span className="spacer" />
        <BuilderTabs templateId={template.id} active="instructor" versionQuery={versionQuery} />
      </div>
      <p className="small muted" style={{ margin: 0 }}>Everything on this screen is instructor-only. None of it reaches the signed record. Clocks at zero, no pilot, no grades: a preview of the delivery screen.</p>

      {!view || view.order.length === 0 ? (
        <div className="notice"><p style={{ margin: 0 }}>Nothing to show yet: the program has no exercises. Add sections and exercises in the builder.</p></div>
      ) : (
        <div className="instructor-layout">
          <aside className="rail" aria-label="Navigate the session" data-testid="instructor-rail">
            <div className="row" style={{ alignItems: 'baseline' }}><h2 className="card-title" style={{ margin: 0 }}>Session</h2><span className="spacer" /><span className="mono xs" title="Device time; briefing and debriefing are outside it">{bud.inside === null ? '' : formatMinutes(bud.inside)}{bud.outside !== null ? <span className="muted"> + {formatMinutes(bud.outside)}</span> : null}</span></div>
            {view.sections.map((s) => (
              <div key={s.key} className="nav-section" style={phaseColour(s.phase) ? { borderLeftColor: phaseColour(s.phase) ?? undefined } : undefined}>
                <div className="row" style={{ alignItems: 'baseline', gap: 'var(--space-2)' }}>
                  <span className="nav-section-title">{s.title}</span>
                  {s.phase ? <span className="xs muted">{vocab.phases.get(s.phase) ?? s.phase}</span> : null}
                  <span className="spacer" />
                  <span className="mono xs">{s.minutes === null ? '' : formatMinutes(s.minutes)}{s.phase && bud.excludedPhases.includes(s.phase) ? <span className="muted" title="Outside the device period"> ·</span> : null}</span>
                </div>
                <ol className="nav-steps">
                  {s.steps.map((st) => (
                    <li key={st.key}>
                      <Link href={href(st.key)} className={`nav-step${current?.key === st.key ? ' is-current' : ''}`} aria-current={current?.key === st.key ? 'page' : undefined}>
                        <span className={`nav-dot nav-dot-${st.kind}`} aria-hidden="true" />
                        <span className="nav-step-title">{st.title}</span>
                        {st.kind === 'exercise' && (st.grading.task_outcome_mode !== 'none' || st.grading.competency_grade_mode !== 'none') ? <span className="xs muted" title="Carries a grade">●</span> : null}
                      </Link>
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </aside>

          <section className="canvas" aria-label="Current step" data-testid="instructor-step">
            {section && step ? (
              <>
                <div className="row" style={{ alignItems: 'baseline' }}>
                  <span className="xs muted" style={{ letterSpacing: '0.04em' }}>{section.title.toUpperCase()} · STEP {idx + 1} OF {view.order.length}</span>
                  <span className="spacer" />
                  <span className="mono xs muted">task 00:00 · session 0:00</span>
                </div>
                <StepBody step={step} sectionTrainingOnly={section.trainingOnly} />
                <div className="row" style={{ marginTop: 'var(--space-3)' }}>
                  {prev ? <Link href={href(prev.key)} className="button button-quiet" style={{ textDecoration: 'none' }}>Previous</Link> : <span />}
                  <span className="spacer" />
                  {next ? <Link href={href(next.key)} className="button" style={{ textDecoration: 'none' }}>Next step</Link> : <Link href={`/templates/${template.id}/review${versionQuery}`} className="button" style={{ textDecoration: 'none' }}>Review and sign</Link>}
                </div>
              </>
            ) : null}
          </section>
        </div>
      )}
    </div>
  );
}

function StepBody({ step, sectionTrainingOnly }: { step: InstructorStep; sectionTrainingOnly: boolean }) {
  switch (step.kind) {
    case 'exercise': {
      const graded = step.grading.task_outcome_mode !== 'none' || step.grading.competency_grade_mode !== 'none';
      return (
        <div className="stack" style={{ gap: 'var(--space-3)' }}>
          <div className="row" style={{ alignItems: 'baseline' }}>
            <h2 style={{ margin: 0 }}>{step.title}</h2>
            {step.pf ? <Chip tone="info">PF {step.pf}</Chip> : null}
            {step.minutes !== null ? <span className="mono xs muted">planned {formatMinutes(step.minutes)}</span> : null}
            {step.snapshot ? <Chip tone="neutral">{step.snapshot === 'take' ? 'Take snapshot' : 'Recall snapshot'}</Chip> : null}
            {sectionTrainingOnly ? <Chip tone="neutral">Training only</Chip> : null}
          </div>
          <div className="row" style={{ gap: 'var(--space-2)' }}>
            {(['ap', 'athr', 'fd'] as const).map((k) => <span key={k} className={`auto-chip auto-${step.automation[k]}`}>{k === 'ap' ? 'AP' : k === 'athr' ? 'A/THR' : 'FD'} · {AUTO[step.automation[k]] ?? step.automation[k]}</span>)}
          </div>
          {step.aims.map((a, i) => (
            <div key={i} className="aims-block">
              <div className="xs muted" style={{ letterSpacing: '0.04em' }}>AIMS · {a.source.toUpperCase()}</div>
              {a.aims.aims ? <p className="small" style={{ margin: '4px 0 0' }}>{a.aims.aims}</p> : null}
              {a.aims.competency_focus ? <p className="small" style={{ margin: '4px 0 0' }}><span className="muted">Focus:</span> {a.aims.competency_focus}</p> : null}
              {a.aims.grading_criteria ? <p className="small" style={{ margin: '4px 0 0' }}><span className="muted">Criteria:</span> {a.aims.grading_criteria}</p> : null}
            </div>
          ))}
          {step.notes ? <div className="notice"><div className="xs muted" style={{ letterSpacing: '0.04em' }}>INSTRUCTOR NOTES</div><p className="small" style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>{step.notes}</p></div> : null}
          {graded ? (
            <div className="grade-panel" data-testid="grade-panel">
              <div className="xs muted" style={{ letterSpacing: '0.04em' }}>GRADE · THIS EXERCISE</div>
              {step.grading.task_outcome_mode === 'pass_fail' ? <div className="row" style={{ marginTop: 'var(--space-2)' }}><button type="button" className="button button-quiet" disabled>Pass</button><button type="button" className="button button-quiet" disabled>Fail</button></div> : null}
              {step.grading.task_outcome_mode === 'scale_1_5' ? <div className="row" style={{ marginTop: 'var(--space-2)' }}>{[1, 2, 3, 4, 5].map((g) => <button key={g} type="button" className="button button-quiet" disabled>{g}</button>)}</div> : null}
              {step.grading.competency_grade_mode !== 'none' ? step.grading.competencies.map((c) => (
                <div key={c} className="row" style={{ marginTop: 'var(--space-2)', gap: 'var(--space-2)' }}>
                  <span className="mono" style={{ width: '3.5rem' }}>{c}</span>
                  {step.grading.competency_grade_mode === 'scale_1_5'
                    ? [1, 2, 3, 4, 5].map((g) => <button key={g} type="button" className="button button-quiet xs" disabled>{g}</button>)
                    : <><button type="button" className="button button-quiet xs" disabled>Competent</button><button type="button" className="button button-quiet xs" disabled>Not competent</button></>}
                  <button type="button" className="button button-quiet xs" disabled>N/O</button>
                </div>
              )) : null}
              <p className="xs muted" style={{ margin: 'var(--space-2) 0 0' }}>Preview: controls are shown as the instructor will get them and record nothing here.</p>
            </div>
          ) : <p className="xs muted" style={{ margin: 0 }}>Not graded: no grade control is rendered for this exercise.</p>}
        </div>
      );
    }
    case 'setup':
      return (
        <div className="stack" style={{ gap: 'var(--space-3)' }}>
          <h2 style={{ margin: 0 }}>{step.title}</h2>
          <table className="data"><tbody>
            {step.lines.map((l) => <tr key={l.label}><th scope="row" style={{ width: '9rem' }}>{l.label}</th><td>{l.values.map((v, i) => <div key={i} className={l.label === 'Airport' ? 'mono' : ''}>{v}</div>)}</td></tr>)}
            {step.mass.zfw || step.mass.zfwcg || step.mass.fuel ? <tr><th scope="row">Mass & config</th><td className="mono">{[step.mass.zfw && `ZFW ${step.mass.zfw}`, step.mass.zfwcg && `ZFWCG ${step.mass.zfwcg}`, step.mass.fuel && `FUEL ${step.mass.fuel}`].filter(Boolean).join(' · ')}</td></tr> : null}
          </tbody></table>
          {step.snapshot ? <Chip tone="neutral">{step.snapshot === 'take' ? 'Take a snapshot here' : 'Recall the snapshot here'}</Chip> : null}
          {step.notes ? <p className="small" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{step.notes}</p> : null}
        </div>
      );
    case 'malfunction':
    case 'event':
      return (
        <div className="stack" style={{ gap: 'var(--space-3)' }}>
          <div className="row" style={{ alignItems: 'baseline' }}><h2 style={{ margin: 0 }}>{step.title}</h2><Chip tone={step.kind === 'malfunction' ? 'bad' : 'info'}>{step.kind === 'malfunction' ? 'Malfunction' : 'Event'}</Chip></div>
          {step.items.length === 0 ? <p className="muted small" style={{ margin: 0 }}>Nothing set.</p> : step.mode === 'choose_one' && step.items.length > 1 ? (
            <>
              <p className="small" style={{ margin: 0 }}>Choose one. The one chosen is what the record stores.</p>
              <div className="choose-grid">{step.items.map((it, i) => <button key={i} type="button" className="choose-card" disabled><span className="small"><strong>{it.name}</strong>{it.option ? ` · ${it.option}` : ''}</span>{it.trigger ? <span className="xs muted">{it.trigger}</span> : null}</button>)}</div>
            </>
          ) : (
            <ol className="seq-list">{step.items.map((it, i) => <li key={i}><span className="small"><strong>{it.name}</strong>{it.option ? ` · ${it.option}` : ''}{it.category ? <span className="xs muted"> · {it.category}</span> : null}</span>{it.trigger ? <div className="xs muted">{it.trigger}</div> : null}</li>)}</ol>
          )}
        </div>
      );
    case 'note':
      return <div className="stack"><h2 style={{ margin: 0 }}>{step.title}</h2><p className="small" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{step.text}</p></div>;
  }
}
