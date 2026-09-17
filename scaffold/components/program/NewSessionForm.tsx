'use client';

import { useMemo, useState } from 'react';

/**
 * NewSessionForm - the create-session form, whose fields depend on the program chosen.
 *
 * Client only because the field set changes with the program: a simulator session asks for a device,
 * a line session for a route and a registration, a check for which check it is, and asking for all
 * of them at once would produce a form where most fields are wrong for most programs. The rules
 * behind those fields live in policy.yaml and are re-checked server-side; nothing here decides
 * anything, it only stops asking for what cannot apply.
 *
 * A plain POST form, so the session is created by a request the server owns and the back button does
 * what a back button should.
 */

export interface ProgramOption {
  template_id: string; version_id: string; code: string; name: string; template_kind: string; kind_label: string;
  fleet: string | null; version_no: number; facility_kind: string | null;
  allowed_assessor_roles: string[]; hide_record_from_subject: boolean; check_options: string[] | null;
}
export interface SubjectOption { id: string; full_name: string; position: string | null; external_id: string; seniority_number: number | null; fleet: string | null; base: string | null }

export function NewSessionForm({
  programs, devices, subjects, seatRoles, defaultSeatRole, today, subjectLabel,
}: {
  readonly programs: readonly ProgramOption[];
  readonly devices: readonly { code: string; name: string; category: string }[];
  readonly subjects: readonly SubjectOption[];
  readonly seatRoles: readonly string[];
  readonly defaultSeatRole: string;
  readonly today: string;
  readonly subjectLabel: string;
}) {
  const [versionId, setVersionId] = useState(programs[0]?.version_id ?? '');
  const [subjectQ, setSubjectQ] = useState('');
  const program = useMemo(() => programs.find((p) => p.version_id === versionId) ?? null, [programs, versionId]);

  // The crew. A second pilot is OPTIONAL and the default is one, because most sessions are one:
  // a line check, a ground school, a screening. But a simulator detail is normally flown by two,
  // and until this existed the only crewed sessions in the system were the ones the seeder wrote
  // directly into the database - an instructor could grade a crew but could not open one.
  const [subject1, setSubject1] = useState('');
  const [subject2, setSubject2] = useState('');
  const [seat1, setSeat1] = useState(defaultSeatRole);
  // Two pilots in one seat is not a thing, so choosing a seat for one chooses it for the other.
  // The server refuses the pair anyway; this is so nobody has to be told.
  const otherSeat = useMemo(
    () => seatRoles.find((r) => r !== seat1) ?? seat1,
    [seatRoles, seat1],
  );

  const kindFacility = program?.facility_kind ?? null;
  const needsDevice = kindFacility === 'ffs' || kindFacility === 'ftd';
  const isLine = kindFacility === 'line' || kindFacility === 'aircraft';
  const isClassroom = kindFacility === 'classroom';
  const fleetDevices = program?.fleet ? devices.filter((d) => d.code.includes(program.fleet as string)) : devices;

  // The pilot list narrows to the program's fleet, then to what has been typed. A program with no
  // fleet of its own (the LFUS sector, the line check) takes its fleet from the pilot, so no filter.
  const shown = useMemo(() => {
    const q = subjectQ.trim().toLowerCase();
    return subjects
      .filter((s) => (program?.fleet ? s.fleet === program.fleet : true))
      .filter((s) => !q || s.full_name.toLowerCase().includes(q) || s.external_id.toLowerCase().includes(q) || String(s.seniority_number ?? '').includes(q))
      .slice(0, 60);
  }, [subjects, program, subjectQ]);

  return (
    <form method="post" action="/api/sessions" className="stack" data-testid="session-new-form">
      <div className="filters" style={{ alignItems: 'flex-start' }}>
        <div className="field" style={{ minWidth: '22rem' }}>
          <label htmlFor="version_id">Program</label>
          <select id="version_id" name="version_id" value={versionId} onChange={(e) => setVersionId(e.target.value)} required>
            {programs.map((p) => (
              <option key={p.version_id} value={p.version_id}>
                {p.name} · v{p.version_no}{p.fleet ? ` · ${p.fleet}` : ''}
              </option>
            ))}
          </select>
          {program ? (
            <span className="xs muted">
              {program.kind_label} · <span className="mono">{program.code}</span>
              {program.allowed_assessor_roles.length ? <> · conducted by <span className="mono">{program.allowed_assessor_roles.join(' ')}</span></> : ' · any instructor qualification'}
            </span>
          ) : null}
        </div>

        <div className="field">
          <label htmlFor="session_date">Date</label>
          <input id="session_date" name="session_date" type="date" defaultValue={today} required />
          <span className="xs muted">Ahead of today opens a planned session.</span>
        </div>

        {program?.check_options?.length ? (
          <div className="field">
            <label htmlFor="check">Which check</label>
            <select id="check" name="check" required defaultValue="">
              <option value="" disabled>Choose…</option>
              {program.check_options.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <span className="xs muted">One program, two checks. It is recorded on the record.</span>
          </div>
        ) : null}

        {needsDevice ? (
          <div className="field">
            <label htmlFor="device">Device</label>
            <select id="device" name="device" required defaultValue={fleetDevices[0]?.code ?? ''}>
              {fleetDevices.map((d) => <option key={d.code} value={d.code}>{d.code} — {d.name}</option>)}
            </select>
            <span className="xs muted">Chosen per session, not per program.</span>
          </div>
        ) : null}

        {isClassroom ? (
          <div className="field">
            <label htmlFor="facility">Facility</label>
            <input id="facility" name="facility" type="text" defaultValue="Training centre, Bogotá" maxLength={120} />
          </div>
        ) : null}

        {isLine ? (
          <>
            <div className="field" style={{ maxWidth: '7rem' }}>
              <label htmlFor="departure">From</label>
              <input id="departure" name="departure" type="text" required maxLength={4} placeholder="BOG" style={{ textTransform: 'uppercase' }} />
            </div>
            <div className="field" style={{ maxWidth: '7rem' }}>
              <label htmlFor="arrival">To</label>
              <input id="arrival" name="arrival" type="text" required maxLength={4} placeholder="MDE" style={{ textTransform: 'uppercase' }} />
            </div>
            <div className="field" style={{ maxWidth: '9rem' }}>
              <label htmlFor="registration">Registration</label>
              <input id="registration" name="registration" type="text" maxLength={12} placeholder="N320AV" />
            </div>
            <div className="field" style={{ maxWidth: '8rem' }}>
              <label htmlFor="sector_number">Sector</label>
              <input id="sector_number" name="sector_number" type="number" min={1} max={200} placeholder="13" />
              <span className="xs muted">Line training only.</span>
            </div>
          </>
        ) : null}
      </div>

      <div className="filters" style={{ alignItems: 'flex-start' }}>
        <div className="field" style={{ minWidth: '16rem' }}>
          <label htmlFor="subject_q">Find the {subjectLabel.toLowerCase()}</label>
          <input id="subject_q" type="search" value={subjectQ} onChange={(e) => setSubjectQ(e.target.value)} placeholder="Name or seniority" />
          <span className="xs muted">{program?.fleet ? `${program.fleet} pilots only` : 'every fleet in your scope'}</span>
        </div>
        <div className="field" style={{ minWidth: '22rem' }}>
          <label htmlFor="subject_id">{subjectLabel}</label>
          <select id="subject_id" name="subject_id" required size={Math.min(8, Math.max(3, shown.length))}
            value={subject1} onChange={(e) => setSubject1(e.target.value)}>
            {shown.length === 0 ? <option value="" disabled>Nobody matched</option> : shown.map((s) => (
              <option key={s.id} value={s.id}>
                {s.seniority_number ?? s.external_id} · {s.full_name} · {s.position ?? '—'}{s.base ? ` · ${s.base}` : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="seat_role">Seat</label>
          <select id="seat_role" name="seat_role" value={seat1} onChange={(e) => setSeat1(e.target.value)}>
            {seatRoles.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <span className="xs muted">PF counts a take-off and a landing.</span>
        </div>
      </div>

      <div className="filters" style={{ alignItems: 'flex-start' }}>
        <div className="field" style={{ minWidth: '22rem' }}>
          <label htmlFor="subject_id_2">Second {subjectLabel.toLowerCase()}</label>
          <select id="subject_id_2" name="subject_id_2" size={Math.min(8, Math.max(3, shown.length))}
            value={subject2} onChange={(e) => setSubject2(e.target.value)}>
            <option value="">— nobody: one pilot in this session —</option>
            {shown.filter((s) => s.id !== subject1).map((s) => (
              <option key={s.id} value={s.id}>
                {s.seniority_number ?? s.external_id} · {s.full_name} · {s.position ?? '—'}{s.base ? ` · ${s.base}` : ''}
              </option>
            ))}
          </select>
          <span className="xs muted">
            {subject2
              ? 'One session, two records: every element is graded per pilot.'
              : 'Leave this empty unless the session is flown as a crew.'}
          </span>
        </div>
        {subject2 ? (
          <div className="field">
            <label htmlFor="seat_role_2">Seat</label>
            <select id="seat_role_2" name="seat_role_2" value={otherSeat} disabled>
              <option value={otherSeat}>{otherSeat}</option>
            </select>
            {/* The name is submitted from the hidden input: a DISABLED select is not posted at all,
                and the server would then see a crew with no second seat and refuse the session. */}
            <input type="hidden" name="seat_role_2" value={otherSeat} />
            <span className="xs muted">The other seat, by definition.</span>
          </div>
        ) : null}
      </div>

      {program?.hide_record_from_subject ? (
        <p className="small" style={{ margin: 0 }}>
          <strong>This program&apos;s record is not visible to the pilot.</strong> Only the instructor signs it,
          and it never appears on their own record list.
        </p>
      ) : null}

      <div className="row">
        <button type="submit" className="button">Open the session</button>
        <span className="xs muted">Nothing is graded yet; this only opens it.</span>
      </div>
    </form>
  );
}

export default NewSessionForm;
