import { requireSession } from '@/lib/session';
import { resolveAccess, requireCapability } from '@/lib/access';
import { kindOptions, fleetOptions } from '@/lib/templates';
import { readFlash } from '@/lib/admin';
import Breadcrumbs from '@/components/ui/Breadcrumbs';
import Card from '@/components/ui/Card';

/**
 * /templates/new - create a program. docs/06_PROGRAM_BUILDER.md section 4 step 1.
 *
 * Asks only for what freezes at creation - name, code, kind, fleet - plus the version-level
 * set-up that the builder's rules read from the first minute: the declared period and the program
 * grouping (code, module, phase, day, year). The device is not asked: it is chosen when a session
 * (an ETR) is created. Everything else is authored in the builder. The template
 * and its version 1 draft are created together; a template with no version is a row nothing can
 * open. Gate: training.templates.configure.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'New program' };

export default async function NewProgramPage() {
  const session = await requireSession();
  const access = await resolveAccess(session);
  requireCapability(access, 'training.templates.configure');

  const [kinds, fleets, flash] = await Promise.all([kindOptions(), fleetOptions(), readFlash()]);
  const thisYear = new Date().getFullYear();

  return (
    <div className="stack" data-testid="template-new" style={{ maxWidth: '52rem' }}>
      <Breadcrumbs items={[{ label: 'Overview', href: '/' }, { label: 'Programs', href: '/templates' }, { label: 'New program' }]} />
      <h1>New program</h1>

      {flash && flash.kind === 'bad' ? <div className="notice notice-bad" role="alert"><p style={{ margin: 0 }}>{flash.message}</p></div> : null}

      <form method="post" action="/api/templates" className="stack" data-testid="template-new-form">
        <input type="hidden" name="_action" value="create" />
        <Card title="Identity" note="Name and code identify the program; kind and fleet decide what the builder offers. Kind and fleet cannot be changed afterwards - a different kind is a different program.">
          <div className="form-grid">
            <div className="field"><label htmlFor="name">Name *</label><input id="name" name="name" required minLength={3} maxLength={120} placeholder="e.g. EBT Module 1" /></div>
            <div className="field"><label htmlFor="code">Code</label><input id="code" name="code" maxLength={63} pattern="[a-z0-9][a-z0-9_.-]{0,62}" className="mono" placeholder="left empty: made from the name" /></div>
            <div className="field">
              <label htmlFor="kind">Kind *</label>
              <select id="kind" name="kind" required defaultValue="">
                <option value="" disabled>Choose</option>
                {kinds.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="fleet">Fleet</label>
              <select id="fleet" name="fleet" defaultValue="">
                <option value="">Every fleet</option>
                {fleets.map((f) => <option key={f.id} value={f.id} title={f.label}>{f.value}</option>)}
              </select>
            </div>
          </div>
        </Card>

        <Card title="Set-up" note="The declared period is what the time budget is measured against. The program grouping ties the days of one module together on the list; leave it empty for a standalone program.">
          <div className="form-grid">
            <div className="field"><label htmlFor="period">Period (H:MM)</label><input id="period" name="period" defaultValue="4:00" pattern="\d{1,2}:[0-5]\d" className="mono" /></div>
            <div className="field"><label htmlFor="program_code">Program</label><input id="program_code" name="program_code" maxLength={40} className="mono" placeholder="e.g. EBT-REC" /></div>
            <div className="field"><label htmlFor="program_module">Module</label><input id="program_module" name="program_module" maxLength={40} placeholder="e.g. Module 1" /></div>
            <div className="field"><label htmlFor="program_phase">Phase</label><input id="program_phase" name="program_phase" maxLength={40} placeholder="e.g. II" /></div>
            <div className="field"><label htmlFor="program_year">Year</label><input id="program_year" name="program_year" type="number" min={2000} max={2100} defaultValue={thisYear} className="mono" /></div>
            <div className="field"><label htmlFor="program_day">Day</label><input id="program_day" name="program_day" type="number" min={1} max={30} /></div>
            <div className="field"><label htmlFor="cycle_months">Cycle (months)</label><input id="cycle_months" name="cycle_months" type="number" min={1} max={60} /></div>
          </div>
          <div className="field" style={{ marginTop: 'var(--space-3)' }}><label htmlFor="notes">Description</label><input id="notes" name="notes" maxLength={300} /></div>
        </Card>

        <div className="row">
          <button className="button" type="submit">Create program</button>
          <a className="button button-quiet" href="/templates" style={{ textDecoration: 'none' }}>Cancel</a>
          <span className="small muted">Opens in the builder as version 1, draft.</span>
        </div>
      </form>
    </div>
  );
}
