import { Fragment } from 'react';
import { requireSession } from '@/lib/session';
import { resolveAccess, requireCapability } from '@/lib/access';
import { query } from '@/lib/db';
import { programVocab } from '@/lib/program';
import { loadProgramScreen } from '@/lib/program/screens';
import { subjectProjection } from '@/lib/program/projection';
import { brand, signatureStatements } from '@/lib/config';
import Breadcrumbs from '@/components/ui/Breadcrumbs';
import Chip from '@/components/ui/Chip';
import BuilderTabs from '@/components/program/BuilderTabs';
import ReviewSignature from '@/components/program/ReviewSignature';

/**
 * /templates/[id]/review - how the final record will look, and how it is signed.
 *
 * The SUBJECT projection: exercise names, the failures the trainee was assessed on, the
 * competencies and their grades, the outcome, both signatures - and nothing from set-up,
 * conduct, instructor notes or timers. The same projection renders the PDF, so this page is the
 * report. In preview the runtime fields are placeholders and the signatures are inert; the
 * statements come from policy.yaml, with the licence-check line added for that kind.
 * Gate: training.templates.view.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function ReviewPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession();
  const access = await resolveAccess(session);
  requireCapability(access, 'training.templates.view');
  const { id } = await params;
  const sp = await searchParams;
  const { template, program, versionQuery } = await loadProgramScreen(id, typeof sp.version === 'string' ? sp.version : undefined);
  const vocab = programVocab();
  const b = brand();
  const report = program ? subjectProjection(program.tree) : null;
  const statements = signatureStatements(template.template_kind);
  const competencyNames = new Map((await query<{ code: string; name: string }>(`SELECT c.code, c.name FROM competencies c JOIN competency_frameworks f ON f.id = c.framework_id WHERE f.is_active`)).map((c) => [c.code, c.name]));
  const gradedRows = report ? report.sections.flatMap((s) => s.rows).filter((r) => r.grading.task_outcome_mode !== 'none' || r.grading.competency_grade_mode !== 'none') : [];

  return (
    <div className="stack builder-page" data-testid="review-view">
      <Breadcrumbs items={[{ label: 'Overview', href: '/' }, { label: 'Programs', href: '/templates' }, { label: template.name, href: `/templates/${template.id}${versionQuery}` }, { label: 'Review' }]} />
      <div className="row" style={{ alignItems: 'baseline' }}>
        <h1 style={{ margin: 0 }}>{template.name}</h1>
        <span className="xs muted">the record, as it will be signed</span>
        <span className="spacer" />
        <BuilderTabs templateId={template.id} active="review" versionQuery={versionQuery} />
      </div>
      {template.hide_record_from_subject ? <div className="notice"><p style={{ margin: 0 }}><strong>Internal record.</strong> Not visible to the trainee: signed by the assessor only, never shown in the trainee&apos;s history.</p></div> : null}
      <p className="small muted" style={{ margin: 0 }}>What both parties see and sign. Set-up, conduct and instructor notes are not on it, by design; the PDF is this page.</p>

      {!report ? <div className="notice"><p style={{ margin: 0 }}>No version to show.</p></div> : (
        <article className="report" data-testid="report">
          <header className="report-head">
            <div className="row" style={{ alignItems: 'baseline' }}>
              <div className="report-brand">{b.product.short_name}</div>
              <span className="spacer" />
              <span className="xs muted">record <span className="mono">— · preview</span></span>
            </div>
            <h2 style={{ margin: 'var(--space-2) 0 0' }}>{template.name}</h2>
            <div className="xs muted mono">{template.code} · v{program?.version.version} · {template.kind_label}{template.asset_class ? ` · ${template.asset_class}` : ''}</div>
            <dl className="report-meta">
              <div><dt>Date</dt><dd className="muted">—</dd></div>
              <div><dt>Location</dt><dd className="muted">—</dd></div>
              <div><dt>Device</dt><dd className="muted">—</dd></div>
              <div><dt>Trainee</dt><dd className="muted">—</dd></div>
              <div><dt>Position</dt><dd className="muted">—</dd></div>
              <div><dt>Instructor</dt><dd className="muted">{session.fullName ?? session.username}</dd></div>
            </dl>
          </header>

          <table className="data report-table">
            <thead><tr><th scope="col">Exercise</th><th scope="col">Assessed on</th><th scope="col">Competency</th><th scope="col" className="num">Grade</th><th scope="col">Observable behaviours</th></tr></thead>
            <tbody>
              {report.sections.map((s) => (
                <SectionRows key={s.key} section={s} phaseLabel={s.phase ? vocab.phases.get(s.phase) ?? s.phase : null} competencyNames={competencyNames} />
              ))}
              {report.sections.every((s) => s.rows.length === 0) ? <tr><td colSpan={5} className="muted small">No exercises yet.</td></tr> : null}
            </tbody>
          </table>

          <section className="report-comment">
            <div className="xs muted" style={{ letterSpacing: '0.04em' }}>INSTRUCTOR COMMENT</div>
            <p className="small muted" style={{ margin: '4px 0 0' }}>— written at the end of the session —</p>
          </section>

          <section className="report-outcome">
            <div className="row" style={{ alignItems: 'baseline' }}>
              <span className="xs muted" style={{ letterSpacing: '0.04em' }}>OUTCOME</span>
              <span className="outcome-value muted">—</span>
              <span className="spacer" />
              <span className="xs muted">{gradedRows.length} graded exercise{gradedRows.length === 1 ? '' : 's'}{report.sections.some((s) => s.trainingOnly) ? ' · training-only sections do not count' : ''}</span>
            </div>
            <label className="check" style={{ marginTop: 'var(--space-2)' }}><input type="checkbox" disabled /><span className="small">Additional training recommended</span></label>
          </section>

          <ReviewSignature preview assessorStatement={statements.assessor} subjectStatement={statements.subject} subjectExtra={statements.subjectExtra} objection={statements.objection} assessorLabel={session.fullName ?? session.username} subjectLabel="Trainee" />

          <footer className="xs muted mono" style={{ marginTop: 'var(--space-3)' }}>Content hash — · both signatures attest to this content. Any later change voids them.</footer>
        </article>
      )}
    </div>
  );
}

function SectionRows({ section, phaseLabel, competencyNames }: { section: ReturnType<typeof subjectProjection>['sections'][number]; phaseLabel: string | null; competencyNames: Map<string, string> }) {
  return (
    <>
      <tr className="report-section"><th scope="rowgroup" colSpan={5}>{section.title}{phaseLabel ? <span className="xs muted"> · {phaseLabel}</span> : null}{section.trainingOnly ? <span className="xs muted"> · training only, not graded</span> : null}</th></tr>
      {section.rows.map((r) => {
        const graded = r.grading.task_outcome_mode !== 'none' || r.grading.competency_grade_mode !== 'none';
        const comps = r.grading.competency_grade_mode !== 'none' ? r.competencies : [];
        const first = comps[0];
        return (
          <Fragment key={r.key}>
            <tr>
              <td rowSpan={Math.max(1, comps.length)}>
                <div>{r.title}</div>
                {r.aims ? <div className="xs muted">{r.aims}</div> : null}
                {r.gradingCriteria ? <div className="xs muted">Criteria: {r.gradingCriteria}</div> : null}
              </td>
              <td rowSpan={Math.max(1, comps.length)} className="small">{r.failures.length ? r.failures.map((f, i) => <div key={i}>{f}</div>) : <span className="muted">—</span>}</td>
              {comps.length ? (
                <>
                  <td className="mono" title={competencyNames.get(first ?? '') ?? undefined}>{first}</td>
                  <td className="num muted">—</td>
                  <td className="xs muted">at standard</td>
                </>
              ) : (
                <>
                  <td className="muted">{r.grading.task_outcome_mode === 'pass_fail' ? 'Pass / fail' : r.grading.task_outcome_mode === 'scale_1_5' ? 'Result 1-5' : '—'}</td>
                  <td className="num muted">{graded ? '—' : ''}</td>
                  <td className="xs muted">{graded ? '' : r.trainingOnly ? 'training phase, no grade' : 'not graded'}</td>
                </>
              )}
            </tr>
            {comps.slice(1).map((c) => (
              <tr key={`${r.key}-${c}`}><td className="mono" title={competencyNames.get(c) ?? undefined}>{c}</td><td className="num muted">—</td><td className="xs muted">at standard</td></tr>
            ))}
          </Fragment>
        );
      })}
    </>
  );
}
