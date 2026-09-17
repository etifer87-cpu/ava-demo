import 'server-only';
import { brand } from '@/lib/config';

/**
 * lib/program/record-html.ts - the record as a printed page.
 *
 * ONE SOURCE, TWO MEDIA. This does not re-derive anything: it renders `records.snapshot`, the same
 * frozen object components/program/RecordDialog.tsx renders on screen. The two cannot disagree about
 * a grade, a behaviour or a signature, because neither of them computes one - the freeze did that
 * once (lib/program/freeze.ts). What differs is the medium, and that is the whole reason this exists
 * rather than a print stylesheet over the screen: a page has a fixed width, repeating table headers,
 * no hover, no dialogue, and a footer that has to carry the hash on every sheet.
 *
 * SELF-CONTAINED, ALWAYS. The renderer is another container and can fetch nothing from the app: no
 * stylesheet, no font file, no logo URL. So the CSS is inlined here, the type stack is the generic
 * one (the operator's licensed display face is not embedded - a missing font renders as a silent
 * substitution, which is worse on paper than an honest system face), and the only colours used come
 * from brand.yaml through `brand()`.
 *
 * Everything written here is ESCAPED. A remark is free text an instructor typed; it reaches the page
 * as text and never as markup.
 */

export interface RecordForPrint {
  readonly id: string;
  readonly training_date: string;
  readonly title: string;
  readonly outcome: string | null;
  readonly outcome_override: string | null;
  readonly is_hidden_from_subject: boolean;
  readonly content_hash: string | null;
  readonly snapshot: Record<string, unknown>;
}

const esc = (v: unknown): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const when = (iso: unknown): string => {
  const s = String(iso ?? '');
  return s ? `${s.slice(0, 16).replace('T', ' ')} UTC` : '—';
};

interface Task { element_key?: string; task_name?: string; attempt?: number; grade?: string | null; remark?: string | null; role?: string | null }
interface Scored { code?: string; name?: string; score?: number }
interface Result { code?: string; name?: string; result?: string }
interface Remark { code?: string; remark?: string }
interface Ob { competency?: string; code?: string; text?: string }
interface Proposed { code?: string; proposed?: string; agreed?: boolean }

/** The record, as one self-contained HTML document ready for the renderer. */
export function recordHtml(rec: RecordForPrint): string {
  const s = rec.snapshot as {
    template?: { code?: string; name?: string; kind_label?: string; version?: number };
    subject?: { external_id?: string; full_name?: string; position?: string | null; seat?: string };
    assessor?: { external_id?: string; full_name?: string; roles?: string[] };
    session?: { date?: string; facility?: string; check?: string; aircraft_type?: string; departure?: string; arrival?: string; sector_number?: number };
    tasks?: Task[];
    competency_scores?: Scored[];
    competency_results?: Result[];
    competency_remarks?: Remark[];
    competency_proposed?: Proposed[];
    observable_behaviours?: Ob[];
    signatures?: { assessor_at?: string | null; subject_at?: string | null };
    objection?: { reason?: string; by?: string; at?: string };
    outcome?: string | null;
    outcome_assessed?: string | null;
    remarks?: string;
  };

  const b = brand();
  const c = b.colour.light;
  const grades = b.grade_palette ?? {};
  const outcome = rec.outcome_override ?? rec.outcome ?? s.outcome ?? null;
  const remarkOf = new Map((s.competency_remarks ?? []).map((r) => [r.code, r.remark]));
  const proposedOf = new Map((s.competency_proposed ?? []).map((r) => [r.code, r]));
  const obsOf = new Map<string, string[]>();
  for (const ob of s.observable_behaviours ?? []) {
    const list = obsOf.get(String(ob.competency)) ?? [];
    list.push(`${ob.code ?? ''} ${ob.text ?? ''}`.trim());
    obsOf.set(String(ob.competency), list);
  }

  const gradeCell = (value: string | number | null | undefined): string => {
    if (value === null || value === undefined || value === '') return '<span class="muted">—</span>';
    const key = String(value);
    const colour = grades[key]?.colour;
    return colour
      ? `<span class="g" style="background:${esc(colour)}">${esc(key)}</span>`
      : `<span class="g g-code">${esc(key)}</span>`;
  };

  const meta = [
    ['Date', esc(s.session?.date ?? rec.training_date)],
    ['Program', `${esc(s.template?.name ?? rec.title)}${s.template?.version ? ` <span class="muted">v${esc(s.template.version)}</span>` : ''}`],
    ['Code', `<span class="mono">${esc(s.template?.code ?? '')}</span>`],
    [s.session?.check ? 'Check' : 'Fleet', esc(s.session?.check ?? s.session?.aircraft_type ?? '—')],
    ['Facility', esc(s.session?.facility ?? '—')],
    [s.session?.sector_number ? 'Sector' : 'Route',
      s.session?.sector_number
        ? esc(String(s.session.sector_number))
        : s.session?.departure || s.session?.arrival ? `${esc(s.session?.departure ?? '')} → ${esc(s.session?.arrival ?? '')}` : '—'],
    ['Pilot', `${esc(s.subject?.full_name ?? '')} <span class="muted mono">${esc(s.subject?.external_id ?? '')}</span>${s.subject?.position ? ` · ${esc(s.subject.position)}` : ''}${s.subject?.seat ? ` · ${esc(s.subject.seat)}` : ''}`],
    ['Instructor', `${esc(s.assessor?.full_name ?? '—')} <span class="muted mono">${esc(s.assessor?.external_id ?? '')}</span>${(s.assessor?.roles ?? []).length ? ` · ${esc((s.assessor?.roles ?? []).join(' '))}` : ''}`],
  ];

  const taskRows = (s.tasks ?? []).map((t) => `
    <tr>
      <td>${esc(t.task_name ?? t.element_key ?? '')}${(t.attempt ?? 1) > 1 ? ` <span class="att">attempt ${esc(t.attempt)}</span>` : ''}${t.role ? ` <span class="muted">as ${esc(t.role)}</span>` : ''}</td>
      <td class="num">${gradeCell(t.grade)}</td>
      <td>${t.remark ? esc(t.remark) : '<span class="muted">—</span>'}</td>
    </tr>`).join('');

  const compRow = (code: string, name: string, cell: string): string => {
    const p = proposedOf.get(code);
    const obs = obsOf.get(code) ?? [];
    return `
    <tr>
      <td class="mono">${esc(code)}</td>
      <td>${esc(name)}</td>
      <td class="num">${cell}</td>
      <td>
        ${obs.length ? `<ul class="obs">${obs.map((o) => `<li>${esc(o)}</li>`).join('')}</ul>` : '<span class="muted">no behaviours recorded</span>'}
        ${remarkOf.get(code) ? `<div class="rm">${esc(remarkOf.get(code))}</div>` : ''}
        ${p && p.agreed === false ? `<div class="muted">the task evidence proposed ${esc(p.proposed)}</div>` : ''}
      </td>
    </tr>`;
  };

  const compRows = [
    ...(s.competency_scores ?? []).map((x) => compRow(String(x.code), String(x.name ?? ''), gradeCell(x.score))),
    ...(s.competency_results ?? []).map((x) => compRow(String(x.code), String(x.name ?? ''), gradeCell(x.result))),
  ].join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(s.template?.name ?? rec.title)} — ${esc(s.subject?.full_name ?? '')}</title>
<style>
  @page { size: A4; margin: 14mm 12mm 16mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 10pt/1.45 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: ${c.ink}; }
  .mono { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; }
  .muted { color: ${c.ink_muted}; }
  header { border-bottom: 2px solid ${c.primary}; padding-bottom: 6mm; margin-bottom: 6mm; }
  .brandbar { display: flex; align-items: baseline; gap: 4mm; }
  .brandbar .op { font-weight: 800; font-size: 13pt; letter-spacing: .02em; color: ${c.primary}; }
  .brandbar .kind { font-size: 9pt; text-transform: uppercase; letter-spacing: .08em; color: ${c.ink_muted}; }
  .brandbar .rule { flex: 1 1 auto; height: 3px; background: ${c.accent}; }
  h1 { font-size: 15pt; margin: 4mm 0 0; }
  .internal { margin-top: 3mm; padding: 2mm 3mm; border-left: 3px solid ${c.accent}; background: ${c.surface_sunken}; font-size: 9pt; }
  dl.meta { display: grid; grid-template-columns: 26mm 1fr 26mm 1fr; gap: 1mm 3mm; margin: 5mm 0 0; font-size: 9.5pt; }
  dl.meta dt { color: ${c.ink_muted}; }
  dl.meta dd { margin: 0; }
  h2 { font-size: 11pt; margin: 7mm 0 2mm; padding-bottom: 1mm; border-bottom: 1px solid ${c.border}; }
  table { width: 100%; border-collapse: collapse; font-size: 9.5pt; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  th { text-align: left; font-size: 8.5pt; text-transform: uppercase; letter-spacing: .06em; color: ${c.ink_muted}; border-bottom: 1px solid ${c.border}; padding: 1.5mm 2mm; }
  td { border-bottom: 1px solid ${c.border}; padding: 1.5mm 2mm; vertical-align: top; }
  td.num, th.num { text-align: center; width: 16mm; }
  .g { display: inline-block; min-width: 6mm; padding: .4mm 1.6mm; border-radius: 2px; color: ${c.primary_ink}; font-weight: 700; text-align: center; }
  .g-code { background: ${c.ink}; }
  .att { font-size: 8pt; font-weight: 700; color: ${c.accent}; }
  ul.obs { margin: 0; padding-left: 4mm; }
  ul.obs li { margin: 0; }
  .rm { margin-top: 1mm; }
  .objection { margin: 5mm 0 0; padding: 3mm; border: 1px solid ${c.accent}; }
  .objection .t { font-weight: 700; color: ${c.accent}; }
  .outcome { margin: 6mm 0 0; padding: 3mm; background: ${c.surface_sunken}; display: flex; align-items: baseline; gap: 4mm; }
  .outcome .v { font-size: 14pt; font-weight: 800; letter-spacing: .04em; }
  .sigs { display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; margin-top: 7mm; page-break-inside: avoid; }
  .sig { border-top: 1px solid ${c.border_strong}; padding-top: 2mm; font-size: 9pt; }
  .sig .who { font-weight: 700; }
  .sig .st { color: ${c.ink_muted}; margin: 1mm 0; }
  footer { margin-top: 8mm; padding-top: 2mm; border-top: 1px solid ${c.border}; font-size: 7.5pt; color: ${c.ink_muted}; word-break: break-all; }
</style></head>
<body>
  <header>
    <div class="brandbar">
      <span class="op">${esc(b.product?.short_name ?? '')}</span>
      <span class="kind">${esc(s.template?.kind_label ?? '')}</span>
      <span class="rule"></span>
      <span class="mono muted">${esc(rec.id.slice(0, 8))}</span>
    </div>
    <h1>${esc(s.template?.name ?? rec.title)}</h1>
    ${rec.is_hidden_from_subject ? `<div class="internal"><strong>Internal record.</strong> Not released to the pilot; signed by the assessor only.</div>` : ''}
    <dl class="meta">${meta.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>
  </header>

  ${s.objection ? `<div class="objection"><div class="t">Objection recorded ${esc(when(s.objection.at))}</div>
    <div>${esc(s.objection.by ?? '')}: “${esc(s.objection.reason ?? '')}”</div>
    <div class="muted">The assessment below is unchanged. This record is marked ${esc(outcome)} pending review.</div></div>` : ''}

  <h2>Exercises</h2>
  <table><thead><tr><th>Exercise</th><th class="num">Grade</th><th>Remark</th></tr></thead>
    <tbody>${taskRows || `<tr><td colspan="3" class="muted">No graded exercise on this record.</td></tr>`}</tbody></table>

  <h2>Competencies</h2>
  <table><thead><tr><th style="width:16mm">Code</th><th>Competency</th><th class="num">Grade</th><th>Observable behaviours and remarks</th></tr></thead>
    <tbody>${compRows || `<tr><td colspan="4" class="muted">No competency graded on this record.</td></tr>`}</tbody></table>

  ${s.remarks ? `<h2>Instructor remarks</h2><p>${esc(s.remarks)}</p>` : ''}

  <div class="outcome">
    <span class="muted">OUTCOME</span>
    <span class="v">${esc(outcome ?? '—')}</span>
    ${s.outcome_assessed && s.outcome_assessed !== outcome ? `<span class="muted">the instructor found ${esc(s.outcome_assessed)}; the objection marked this record ${esc(outcome)}</span>` : ''}
    ${rec.outcome_override ? `<span class="muted">amended; originally ${esc(rec.outcome)}</span>` : ''}
  </div>

  <div class="sigs">
    <div class="sig">
      <div class="who">${esc(s.assessor?.full_name ?? 'Instructor')}</div>
      <div class="st">Instructor${s.signatures?.assessor_at ? ` · signed ${esc(when(s.signatures.assessor_at))}` : ' · not signed'}</div>
    </div>
    <div class="sig">
      <div class="who">${esc(s.subject?.full_name ?? 'Pilot')}</div>
      <div class="st">${rec.is_hidden_from_subject ? 'Internal record · no pilot signature'
        : s.objection ? `Objected · ${esc(when(s.objection.at))}`
        : s.signatures?.subject_at ? `Pilot · signed ${esc(when(s.signatures.subject_at))}` : 'Pilot · not signed'}</div>
    </div>
  </div>

  <footer>
    record ${esc(rec.id)}${rec.content_hash ? ` · content ${esc(rec.content_hash)}` : ''}<br>
    Both signatures attest to this content. Any later change voids them.
  </footer>
</body></html>`;
}
