import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { query } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { resolveAccess, requireCapability } from '@/lib/access';
import { analyticsConfig } from '@/lib/config';
import type { AnalyticsConfig } from '@/lib/analytics/types';
import Breadcrumbs from '@/components/ui/Breadcrumbs';
import Card from '@/components/ui/Card';
import Chip from '@/components/ui/Chip';
import DataTable, { type Column } from '@/components/ui/DataTable';
import FilterBar from '@/components/ui/FilterBar';
import LiveSearch from '@/components/ui/LiveSearch';
import Pager, { pageParams } from '@/components/ui/Pager';
import { foldedLikeAny } from '@/lib/search';

/**
 * /admin/config - what configuration this instance is running, and whether it matches the files.
 *
 * READ-ONLY, AND THAT IS NOT AN OVERSIGHT. Migration 0100 says of analytics_config, in as many
 * words, that it is "never edited by hand and never written by the application": every threshold,
 * band boundary and weight arrives from scaffold/config/*.yaml through
 * scripts/load-analytics-config.mjs, which checksums the file and records the version every figure
 * was computed under. A screen that wrote a threshold straight into the table would break that
 * chain - an analysis would name a config version whose contents no longer matched its checksum,
 * and the question "what was this number computed under?" would stop having an answer. Editing
 * belongs in a narrow, audited overrides table read on top of the file, not here. Until that
 * exists, this screen's job is to make the current state legible and to make DRIFT visible.
 *
 * DRIFT is the point of the checksum column (migration 0012 says so): the file in the image is
 * re-hashed on every render with the same algorithm the loader uses - sha256, first 32 hex
 * characters - and compared with the row. They disagree when someone has changed a YAML file and
 * not run `npm run config:load`, which is the failure this screen exists to catch, because
 * everything keeps working and every figure is quietly computed under the old numbers.
 *
 * Gate: platform.config.manage.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Configuration' };

const CONFIG_DIR = path.resolve(process.cwd(), 'config');

/** The loader's algorithm, in scripts/lib/kit-seed.mjs `checksumOf`. Kept identical on purpose. */
function fileChecksum(file: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path.join(CONFIG_DIR, file), 'utf8'), 'utf8').digest('hex').slice(0, 32);
  } catch {
    return null;
  }
}

function one(v: string | string[] | undefined): string { return typeof v === 'string' ? v.trim() : ''; }

interface VersionRow {
  id: string; name: string; version: string; checksum: string;
  loaded_at: string; is_active: boolean; notes: string | null; loaded_by_name: string | null;
}
interface KeyRow { key: string; value: string; config_version: string; loaded_at: string; total: string }

/** The file each config_versions row is loaded from, so its checksum can be re-computed here. */
const SOURCE_FILE: Record<string, string> = { analytics: 'analytics.yaml', policy: 'policy.yaml' };

export default async function ConfigPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession();
  const access = await resolveAccess(session);
  requireCapability(access, 'platform.config.manage');

  const sp = await searchParams;
  const q = one(sp.q);
  const { page, size } = pageParams(sp);

  const cfg = analyticsConfig<AnalyticsConfig>();
  const scale = cfg.grade_scale;
  const std = scale.outcome_standard;

  const params: unknown[] = [];
  let where = '';
  // Config keys are ASCII by construction, so folding is a no-op here. Swept anyway: one ILIKE left
  // in the codebase is the one the next search box gets copied from.
  if (q) { params.push(`%${q}%`); where = `WHERE ${foldedLikeAny(['key'], '$1')}`; }

  const [versions, keys, keyCount] = await Promise.all([
    query<VersionRow>(`
      SELECT c.id, c.name, c.version, c.checksum, c.loaded_at::text AS loaded_at, c.is_active, c.notes,
             COALESCE(p.full_name, u.username) AS loaded_by_name
        FROM config_versions c
        LEFT JOIN users u ON u.id = c.loaded_by
        LEFT JOIN people p ON p.id = u.person_id
       ORDER BY c.name, c.is_active DESC, c.loaded_at DESC`),
    query<KeyRow>(`
      SELECT key,
             COALESCE(value_text, value_num::text, value_json::text) AS value,
             config_version, loaded_at::text AS loaded_at,
             count(*) OVER ()::text AS total
        FROM analytics_config ${where}
       ORDER BY key
       LIMIT ${size} OFFSET ${(page - 1) * size}`, params),
    query<{ n: string }>(`SELECT count(*)::text AS n FROM analytics_config`),
  ]);

  const total = Number(keys[0]?.total ?? 0);
  const active = versions.filter((v) => v.is_active);
  const drifted = active.filter((v) => {
    const file = SOURCE_FILE[v.name];
    if (!file) return false;
    const sum = fileChecksum(file);
    return sum !== null && sum !== v.checksum;
  });

  const settings: { label: string; value: string; key: string; what: string }[] = [
    { label: 'Below standard', value: `${scale.min} to ${scale.below_standard_max}`,
      key: 'grade_scale.below_standard_max',
      what: 'The one definition. Every view, route, report and narrative reads a grade as below standard from this number and nowhere else.' },
    { label: 'Meets standard', value: `${scale.meets_standard_min} and above`, key: 'grade_scale.meets_standard_min',
      what: 'The other side of the same line.' },
    { label: 'Critical grade', value: String(scale.critical_grade), key: 'grade_scale.critical_grade',
      what: 'Non-compensatory: one of these is a failure on its own, whatever else the record carries. It is removed from the screening index arithmetic and handled as a flag.' },
    { label: 'Warn at', value: std ? `${std.warn_at} below-standard grades` : 'not set',
      key: 'grade_scale.outcome_standard.warn_at',
      what: 'Advisory. This many grades at or below the line, with a passing outcome and no additional training recommended, warns the instructor at Review and raises the outcome-mismatch alert on the assessor page. It refuses nothing.' },
    { label: 'Refuse a pass at', value: std ? `${std.refuse_pass_at} grades of ${std.refuse_pass_grade}` : 'not set',
      key: 'grade_scale.outcome_standard.refuse_pass_at',
      what: 'Binding, and the only rule in the platform that overrules an instructor. The grades themselves are never touched: the instructor decides what each competency earned, and this decides what that adds up to.' },
  ];

  const versionColumns: Column<VersionRow>[] = [
    { key: 'name', head: 'Configuration', cell: (r) => <span className="mono">{r.name}</span> },
    { key: 'version', head: 'Version', cell: (r) => <span className="mono">{r.version}</span> },
    { key: 'state', head: 'State', cell: (r) => r.is_active ? <Chip tone="good">active</Chip> : <Chip tone="neutral">superseded</Chip> },
    {
      key: 'checksum', head: 'Checksum', cell: (r) => {
        const file = SOURCE_FILE[r.name];
        const sum = file ? fileChecksum(file) : null;
        const known = r.is_active && sum !== null;
        return (
          <span className="stack" style={{ display: 'block' }}>
            <span className="mono xs" style={{ display: 'block' }}>{r.checksum}</span>
            {known ? (sum === r.checksum
              ? <span className="xs muted" style={{ display: 'block' }}>matches config/{file}</span>
              : <span className="xs" style={{ display: 'block' }}><Chip tone="bad">drift</Chip> config/{file} now hashes {sum}</span>) : null}
          </span>
        );
      },
    },
    { key: 'loaded', head: 'Loaded', numeric: true, cell: (r) => <span className="mono xs">{r.loaded_at.slice(0, 19).replace('T', ' ')}<span className="muted"> · {r.loaded_by_name ?? 'a script'}</span></span> },
  ];

  const keyColumns: Column<KeyRow>[] = [
    { key: 'k', head: 'Key', cell: (r) => <span className="mono xs">{r.key}</span> },
    { key: 'v', head: 'Value', cell: (r) => <span className="mono xs">{r.value === null ? '—' : r.value.length > 120 ? `${r.value.slice(0, 120)}…` : r.value}</span> },
    { key: 'ver', head: 'Version', numeric: true, cell: (r) => <span className="mono xs">{r.config_version}</span> },
  ];

  return (
    <div className="stack" data-testid="config-admin">
      <Breadcrumbs items={[{ label: 'Overview', href: '/' }, { label: 'Admin', href: '/admin' }, { label: 'Configuration' }]} />
      <div className="row" style={{ alignItems: 'baseline' }}>
        <h1 style={{ margin: 0 }}>Configuration</h1>
        <span className="xs muted">what this instance is running, and whether it matches the files</span>
      </div>

      <div className="grid grid-kpi">
        {active.map((v) => (
          <div key={v.id} className="stat">
            <div className="xs muted" style={{ letterSpacing: '0.04em' }}>{v.name.toUpperCase()}</div>
            <div className="stat-value mono">{v.version}</div>
            <div className="stat-label muted">active since {v.loaded_at.slice(0, 10)}</div>
          </div>
        ))}
        <div className="stat">
          <div className="xs muted" style={{ letterSpacing: '0.04em' }}>ANALYTICS KEYS</div>
          <div className="stat-value">{Number(keyCount[0]?.n ?? 0)}</div>
          <div className="stat-label muted">leaves and containers in analytics_config</div>
        </div>
        <div className="stat">
          <div className="xs muted" style={{ letterSpacing: '0.04em' }}>FILE DRIFT</div>
          <div className="stat-value">{drifted.length}</div>
          <div className="stat-label muted">{drifted.length === 0 ? 'every active version matches its file' : 'a YAML file changed without a config:load'}</div>
        </div>
      </div>

      {drifted.length > 0 ? (
        <Card title="A configuration file has changed and has not been loaded" testId="config-drift">
          <p className="small">
            {drifted.map((v) => `config/${SOURCE_FILE[v.name]}`).join(', ')} no longer hashes to the checksum recorded
            against the active version. Everything keeps working, and every figure is being computed under the OLD
            numbers - which is exactly why this is on the screen rather than in a log. Run <span className="mono">npm run config:load</span> against
            this instance to load the file and activate a new version.
          </p>
        </Card>
      ) : null}

      <Card
        title="The standard a record is held to"
        note="Read from config/analytics.yaml. Changing one of these changes what every screen in the platform calls below standard, so they live in one file with one definition each."
        testId="config-standard"
      >
        <table className="data">
          <thead><tr><th scope="col">Setting</th><th scope="col">Value</th><th scope="col">What it does</th><th scope="col">Key</th></tr></thead>
          <tbody>
            {settings.map((s) => (
              <tr key={s.key}>
                <td><strong>{s.label}</strong></td>
                <td className="mono">{s.value}</td>
                <td className="small">{s.what}</td>
                <td className="mono xs muted">{s.key}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="xs muted" style={{ marginTop: 'var(--space-3)' }}>
          These are not editable here yet. analytics_config is loaded from the file and checksummed so that every
          stored figure can name the configuration it was computed under; writing a threshold straight into the table
          would leave an analysis naming a version whose contents no longer matched. Editing arrives as an audited
          override read on top of the file, which keeps that chain intact.
        </p>
      </Card>

      <Card title="Configuration versions" note="One active version per configuration. The checksum is of the source file, so drift between the file and the row is visible." testId="config-versions">
        <DataTable
          testId="config-version-list"
          caption="Versions"
          columns={versionColumns}
          rows={versions}
          rowKey={(r) => r.id}
          emptyTitle="No configuration loaded"
          emptyReason="Nothing has been loaded into config_versions on this instance."
        />
      </Card>

      <Card title="Every analytics key" note="One row per leaf and per container of analytics.yaml, as the SQL views read them.">
        <FilterBar action="/admin/config" resetHref="/admin/config">
          <LiveSearch name="q" label="Key" value={q} placeholder="grade_scale, leniency, index…" />
        </FilterBar>
        <DataTable
          testId="config-key-list"
          caption="analytics_config"
          columns={keyColumns}
          rows={keys}
          rowKey={(r) => r.key}
          emptyTitle="No key matched"
          emptyReason="No analytics_config key matched that search."
          countSuffix={total > keys.length ? `of ${total}` : undefined}
        />
        <Pager path="/admin/config" params={q ? { q } : {}} page={page} size={size} total={total} noun="keys" />
      </Card>
    </div>
  );
}
