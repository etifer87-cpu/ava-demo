/**
 * population.mjs - the synthetic roster.
 *
 * NO REAL PERSON EVER ENTERS THIS KIT. Names are combined from two invented lists, ids carry a
 * DEMO- prefix, and there is no licence number, no date of birth, no contact detail and no
 * employment fact anywhere. If a value here starts to look like it came from a roster, it is a
 * defect, not a nice touch.
 *
 * The population is not decorative. Each subject and each assessor carries a PROFILE whose only
 * purpose is to drive one or more bands of scaffold/config/analytics.yaml into existence. A band
 * that no profile produces has never been seen to work, and the coverage assertion in
 * coverage.mjs fails the run rather than letting it pass quietly.
 */

/* ------------------------------------------------------------------------- *
 * Subject profiles. `mean` and `sd` shape the grade draw; `forced` injects an
 * exact grade at an exact position, counted from the END of the subject's
 * session list, because the bands that matter most are recency-weighted.
 * ------------------------------------------------------------------------- */
export const SUBJECT_PROFILES = [
  { key: 'no_records', min: 2, sessions: 0, mean: 0, sd: 0,
    exercises: ['concern = NULL (no observations, rendered "no data", never "Low")'] },
  { key: 'insufficient', min: 2, sessions: 1, mean: 3.6, sd: 0.5, maxCompetencies: 2,
    exercises: ['screening_index INSUFFICIENT (< min_valid_grades)', 'trend omitted (< trend.min_points)'] },
  { key: 'critical_unrecovered', min: 2, mean: 3.4, sd: 0.6, forced: [{ fromEnd: 0, grade: '1' }],
    exercises: ['screening_index RED (unrecovered critical grade)', 'concern high', 'flagged_record via grade_1_at_least'] },
  { key: 'critical_recovered', min: 2, mean: 3.7, sd: 0.5,
    forced: [{ fromEnd: 3, grade: '1' }, { fromEnd: 2, grade: '3' }, { fromEnd: 1, grade: '4' }, { fromEnd: 0, grade: '3' }],
    exercises: ['critical flag CLEARED by clean_run_n consecutive events at clean_run_min_grade'] },
  { key: 'critical_broken_run', min: 1, mean: 3.6, sd: 0.5,
    forced: [{ fromEnd: 4, grade: '1' }, { fromEnd: 3, grade: '3' }, { fromEnd: 2, grade: '2' }, { fromEnd: 1, grade: '3' }, { fromEnd: 0, grade: '3' }],
    exercises: ['clean run BROKEN by a grade 2 and restarted at zero: still RED'] },
  { key: 'amber', min: 3, mean: 2.9, sd: 0.5,
    exercises: ['screening_index AMBER (score below bands.amber_below)', 'concern medium'] },
  { key: 'above', min: 3, mean: 4.4, sd: 0.4,
    exercises: ['screening_index ABOVE (score above bands.above_over)'] },
  { key: 'standard', min: 4, mean: 3.8, sd: 0.5,
    exercises: ['screening_index STANDARD'] },
  { key: 'improving', min: 2, mean: 3.3, sd: 0.5, trendPerYear: 0.7,
    exercises: ['trend RISING beyond trend.flat_band'] },
  { key: 'declining', min: 2, mean: 4.2, sd: 0.5, trendPerYear: -0.8,
    exercises: ['trend FALLING beyond trend.flat_band', 'early_warning consecutive_below_run'] },
  { key: 'flat', min: 2, mean: 3.8, sd: 0.25, trendPerYear: 0,
    exercises: ['trend FLAT (|delta| within trend.flat_band)'] },
  { key: 'flagged_records', min: 2, mean: 3.5, sd: 0.5, twosPerRecord: 3,
    exercises: ['flagged_record via grade_2_at_least'] },
  { key: 'repeat_prone', min: 3, mean: 3.1, sd: 0.6, repeatShare: 0.6, alwaysRepeat: true,
    exercises: ['element_grades.attempt > 1 on a realistic minority', 'below-standard count that only appears when attempts are expanded'] },
  { key: 'import_only', min: 3, mean: 3.7, sd: 0.6, source: 'import',
    exercises: ['records.source = import: the second home a read surface must not forget'] },
  { key: 'inactive', min: 3, mean: 3.6, sd: 0.6, isActive: false, historyOnly: true,
    exercises: ['a former subject whose history stays readable', 'assessor status dormant/former inputs'] },
  { key: 'clean_light', min: 2, sessions: 3, mean: 4.4, sd: 0.2,
    exercises: ['concern low: observations exist, no critical grade, fewer than the medium trigger'] },
  { key: 'typical', min: 0, mean: 3.8, sd: 0.6, exercises: ['the bulk of the population'] },
];

/* ------------------------------------------------------------------------- *
 * Assessor traits. Every one of these exists to make an assessor-fairness band
 * occur. `bias` is added to the subject's underlying grade before rounding.
 * ------------------------------------------------------------------------- */
export const ASSESSOR_TRAITS = [
  { key: 'calibrated', bias: 0.0, sd: 0.6, volume: 1.4,
    exercises: ['standardisation index GREEN', 'expected-grade fallback level 1 (same subjects, other assessors)'] },
  { key: 'lenient_outlier', bias: 1.25, sd: 0.6, volume: 1.2,
    exercises: ['adjusted leniency delta beyond adjusted_delta.outlier_abs, positive'] },
  { key: 'severe_outlier', bias: -1.1, sd: 0.6, volume: 1.2,
    exercises: ['adjusted leniency delta beyond adjusted_delta.outlier_abs, negative', 'standardisation index RED'] },
  { key: 'provisional', bias: 0.4, sd: 0.55, volume: 0.12,
    exercises: ['below adjusted_delta.min_records_banded: provisional, never banded, never flagged'] },
  { key: 'narrow_spread', bias: 0.35, sd: 0.15, volume: 1.0, fixedGrade: '4', fixedGradeDeviation: 0.05,
    exercises: ['spread below spread.sigma_min: an assessor who awards one grade to everything'] },
  { key: 'wide_spread', bias: 0.0, sd: 1.15, volume: 1.0,
    exercises: ['spread above spread.sigma_floor'] },
  { key: 'halo', bias: 0.2, sd: 0.6, volume: 1.0, halo: true,
    exercises: ['habits.halo above scale_full', 'standardisation index cap halo_ineligible'] },
  { key: 'drifting', bias: 0.0, sd: 0.6, volume: 1.1, driftPerYear: 0.55,
    exercises: ['habits.drift above scale_full'] },
  { key: 'not_observed_heavy', bias: 0.0, sd: 0.6, volume: 1.0, notObservedShare: 0.4,
    exercises: ['habits.not_observed excess over expected, and the NR/NO non-scoring codes'] },
  { key: 'unjustified_low', bias: -0.3, sd: 0.7, volume: 1.0, shortRemarks: true,
    exercises: ['justification: a grade at or below grade_max with a remark under min_words'] },
  { key: 'template_reuse', bias: 0.1, sd: 0.55, volume: 1.0, reuseRemark: true,
    exercises: ['habits.template_reuse: near-identical remark text across records'] },
  { key: 'no_signature_capture', bias: 0.0, sd: 0.6, volume: 0.9, captureSignature: false,
    exercises: ['habits.signature_lag emitted null with "not captured", never zero'] },
  { key: 'dormant', bias: 0.1, sd: 0.6, volume: 0.5, dormant: true,
    exercises: ['assessor status dormant (no grading within status.dormant_after_days)'] },
  { key: 'unregistered', bias: -0.1, sd: 0.6, volume: 0.8, hasUser: false, instructorRole: null,
    exercises: ['a grader with no login and no formal instructor role: included, never filtered out'] },
];

const pad = (n, width) => String(n).padStart(width, '0');

/** Deterministic, obviously invented, and unique. */
function makeName(rng, policy, index) {
  const given = policy.synthetic.given_names;
  const family = policy.synthetic.family_names;
  const g = given[index % given.length];
  const f = family[Math.floor(index / given.length) % family.length];
  const suffix = index >= given.length * family.length ? ` ${rng.int(2, 9)}` : '';
  return `${g} ${f}${suffix}`;
}

/** Expands the minimum counts of each profile up to `count`, filling the rest with `typical`. */
function assignProfiles(profiles, count, rng) {
  const out = [];
  for (const profile of profiles) {
    for (let i = 0; i < profile.min; i += 1) out.push(profile);
  }
  if (out.length > count) {
    throw new Error(
      `--subjects ${count} is too small: the required profiles need at least ${out.length} subjects. ` +
        'Every profile exists to make a band occur, so the generator refuses to drop one rather ' +
        'than producing a population that silently cannot exercise the metric.',
    );
  }
  const filler = profiles.find((p) => p.key === 'typical');
  while (out.length < count) out.push(filler);
  return rng.shuffle(out);
}

export function buildPopulation({ policy, rng, subjectCount }) {
  const syn = policy.synthetic;
  const orgUnits = syn.org_units.map((u, i) => ({ ...u, position: i }));
  const assetClasses = syn.asset_classes.map((a, i) => ({ ...a, position: i }));
  const baseUnits = orgUnits.filter((u) => u.kind === 'base');
  const flyingClasses = assetClasses.filter((a) => a.category === 'aircraft');

  const profiles = assignProfiles(SUBJECT_PROFILES, subjectCount, rng.fork('profiles'));
  const nameRng = rng.fork('names');
  const rosterRng = rng.fork('roster');

  let serial = 1;
  const subjects = profiles.map((profile, i) => ({
    kind: 'subject',
    external_id: `${syn.person_id_prefix}${pad(serial++, 4)}`,
    full_name: makeName(nameRng, policy, i),
    position: rosterRng.pick(policy.positions),
    org_code: rosterRng.pick(baseUnits).code,
    // Deliberately UNEVEN. The third flying class carries a handful of subjects so that a cohort
    // comparison has a side below comparison.min_n_per_side and reports "insufficient", which is a
    // different statement from "not significant" and needs a population to be said about.
    asset_code: i < 3 ? flyingClasses[2].code : flyingClasses[i % 2].code,
    instructor_role: null,
    is_active: profile.isActive !== false,
    seniority_years: rosterRng.pick(syn.roster.seniority_years),
    watch_list: false,
    concern_override: null,
    profile,
  }));

  // watch_list and concern_override are roster attributes, not derived values. They are set on a
  // handful of subjects so the surfaces that read them are exercised; concern_override outranks
  // both the derived value and any model-produced one.
  for (const s of rosterRng.sample(subjects.filter((x) => x.profile.sessions !== 0), syn.roster.watch_list_count)) {
    s.watch_list = true;
  }
  for (const s of rosterRng.sample(subjects.filter((x) => x.watch_list), syn.roster.concern_override_count)) {
    s.concern_override = 'high';
  }

  const traits = ASSESSOR_TRAITS.slice(0, syn.roster.assessor_count);
  while (traits.length < syn.roster.assessor_count) {
    traits.push({ ...ASSESSOR_TRAITS[0], key: `calibrated_${traits.length}` });
  }
  const assessors = traits.map((trait, i) => ({
    kind: 'assessor',
    external_id: `${syn.person_id_prefix}${pad(serial++, 4)}`,
    full_name: makeName(nameRng, policy, subjects.length + i),
    position: 'position_a',
    org_code: rosterRng.pick(baseUnits).code,
    asset_code: rosterRng.pick(flyingClasses).code,
    instructor_role: trait.instructorRole === null
      ? null
      : rosterRng.pick(policy.instructor_roles),
    is_active: true,
    seniority_years: rosterRng.pick([7, 12]),
    watch_list: false,
    concern_override: null,
    trait,
  }));

  return { orgUnits, assetClasses, subjects, assessors, people: [...subjects, ...assessors] };
}

/* ------------------------------------------------------------------------- *
 * Writing
 * ------------------------------------------------------------------------- */

export async function writePopulation(client, population, { policy, asOf }) {
  const orgIdByCode = new Map();
  for (const unit of population.orgUnits) {
    const parentId = unit.parent ? orgIdByCode.get(unit.parent) ?? null : null;
    const { rows } = await client.query(
      `INSERT INTO org_units (code, name, kind, parent_id, position)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (code) WHERE deleted_at IS NULL
         DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind
       RETURNING id`,
      [unit.code, unit.name, unit.kind, parentId, unit.position],
    );
    orgIdByCode.set(unit.code, rows[0].id);
  }

  const assetIdByCode = new Map();
  for (const asset of population.assetClasses) {
    const { rows } = await client.query(
      `INSERT INTO asset_classes (code, name, category, org_unit_id, position)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (code) WHERE deleted_at IS NULL
         DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category
       RETURNING id`,
      [asset.code, asset.name, asset.category, orgIdByCode.get('OPS') ?? null, asset.position],
    );
    assetIdByCode.set(asset.code, rows[0].id);
  }

  for (const person of population.people) {
    const joinedOn = new Date(asOf.getTime());
    joinedOn.setUTCFullYear(joinedOn.getUTCFullYear() - person.seniority_years);
    const { rows } = await client.query(
      `INSERT INTO people (external_id, full_name, position, org_unit_id, asset_class_id,
                           instructor_role, is_active, joined_on, watch_list, concern_override)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (external_id) WHERE deleted_at IS NULL
         DO UPDATE SET full_name = EXCLUDED.full_name
       RETURNING id`,
      [
        person.external_id, person.full_name, person.position,
        orgIdByCode.get(person.org_code), assetIdByCode.get(person.asset_code),
        person.instructor_role, person.is_active, joinedOn.toISOString().slice(0, 10),
        person.watch_list, person.concern_override,
      ],
    );
    person.id = rows[0].id;
  }

  // Logins. The hash is a single '!' - a string no hashing scheme can ever produce and therefore
  // one no password can ever match. It is a placeholder, not a credential, and no secret of any
  // kind belongs in a seed.
  const NEVER_MATCHES = '!';
  const users = [];
  const grant = async (userId, roleCode) => {
    await client.query(
      `INSERT INTO user_roles (user_id, role_code) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [userId, roleCode],
    );
  };
  const makeUser = async (person, username, active = true) => {
    const { rows } = await client.query(
      `INSERT INTO users (person_id, username, password_hash, must_change_password, is_active)
       VALUES ($1,$2,$3,true,$4)
       ON CONFLICT (username) WHERE deleted_at IS NULL DO UPDATE SET is_active = EXCLUDED.is_active
       RETURNING id`,
      [person?.id ?? null, username, NEVER_MATCHES, active],
    );
    users.push({ id: rows[0].id, username });
    return rows[0].id;
  };

  const assessorRoles = policy.assessor_role_codes;
  let roleIndex = 0;
  for (const assessor of population.assessors) {
    if (assessor.trait.hasUser === false) continue;   // grades without a login, deliberately
    const active = assessor.trait.key !== 'dormant';
    const userId = await makeUser(assessor, `demo.${assessor.external_id.toLowerCase()}`, active);
    assessor.user_id = userId;
    await grant(userId, assessorRoles[roleIndex % assessorRoles.length]);
    roleIndex += 1;
  }

  // A small management and records role mix, so every module's role appears in a fresh install.
  const staffRoles = ['platform_admin', 'training_manager', 'assessment_manager', 'records_officer',
                      'qms_admin', 'compliance_verifier', 'planner'];
  const staffUsers = [];
  for (const role of staffRoles) {
    const userId = await makeUser(null, `demo.${role}`);
    await grant(userId, role);
    staffUsers.push({ role, userId });
  }
  for (const subject of population.subjects.slice(0, 5)) {
    const userId = await makeUser(subject, `demo.${subject.external_id.toLowerCase()}`);
    await grant(userId, 'trainee');
  }

  return { orgIdByCode, assetIdByCode, users, staffUsers };
}
