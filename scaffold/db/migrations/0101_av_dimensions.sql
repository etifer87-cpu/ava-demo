-- 0101_av_dimensions.sql
-- Analytics layer, part 2 of 20. docs/06_ANALYTICS.md §2.7.
-- Framework, grade-scale and roster dimensions. Everything downstream joins on ids.

CREATE OR REPLACE VIEW av_framework AS
SELECT f.id            AS framework_id,
       f.code,
       f.name,
       f.edition,
       f.effective_from,
       f.is_active,
       (SELECT count(*) FROM competencies c
         WHERE c.framework_id = f.id AND c.is_active) AS competency_count
FROM competency_frameworks f;

COMMENT ON VIEW av_framework IS
  'One row per competency framework, carrying its active competency count. That count is the divisor '
  'for the Bonferroni correction (comparison.multiple_comparison.divisor = competency_count) and the '
  'spoke count for every radar: adding a competency must change both automatically, with no literal '
  'anywhere to update.';

-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW av_competency_dim AS
SELECT c.id            AS competency_id,
       c.framework_id,
       c.code,
       c."index"       AS competency_index,
       c.name,
       c.colour,
       c.position
FROM competencies c
WHERE c.is_active;

COMMENT ON VIEW av_competency_dim IS
  'One row per active competency of one framework. The only place a competency name or colour enters '
  'the analytics layer, and it enters as a display attribute resolved late. No downstream view, join '
  'or group-by keys on name or code: they key on competency_id.';

-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW av_grade_scale AS
SELECT g.grade,
       g.grade <= analytics_int('grade_scale.below_standard_max')  AS is_below_standard,
       g.grade >= analytics_int('grade_scale.meets_standard_min')  AS is_meets_standard,
       g.grade  = analytics_int('grade_scale.critical_grade')      AS is_critical
FROM generate_series(
       analytics_int('grade_scale.min'),
       analytics_int('grade_scale.max')
     ) AS g(grade);

COMMENT ON VIEW av_grade_scale IS
  'One row per point of the ordinal grade scale, with the band predicates resolved from '
  'analytics_config. Distribution views join it so a grade band with zero occurrences still produces '
  'a row: a missing band renders as a gap, and a gap reads as "fine".';

-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW av_subject_dim AS
SELECT p.id             AS subject_id,
       p.external_id,
       p.full_name,
       p.position,
       p.org_unit_id,
       p.asset_class_id,
       p.instructor_role,
       p.joined_on,
       p.is_active,
       p.watch_list,
       p.concern_override
FROM people p
WHERE p.deleted_at IS NULL;

COMMENT ON VIEW av_subject_dim IS
  'One row per person on the roster. Used as a FALLBACK dimension source only. Bucketing a grade by '
  'the person''s CURRENT org unit or asset class rewrites history when someone is reassigned, so '
  'av_record_dim resolves the record''s own dimensions first, the template''s second, and these last.';

-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW av_person_status AS
SELECT p.id                          AS person_id,
       p.is_active                   AS on_roster,
       COALESCE(u.is_active, false)  AS has_login,
       (u.id IS NULL)                AS unregistered,
       (p.instructor_role IS NULL)   AS role_missing
FROM people p
LEFT JOIN users u ON u.person_id = p.id AND u.deleted_at IS NULL
WHERE p.deleted_at IS NULL;

COMMENT ON VIEW av_person_status IS
  'One row per person carrying the two independent activity facts and the two data-hygiene tags. '
  'people.is_active and users.is_active are deliberately separate - leaving the organisation and '
  'losing a login are different events. unregistered and role_missing are TAGS, never exclusions: a '
  'roster filtered by instructor role silently deletes the substantial share of graders who hold no '
  'formal role, and with them their share of the corpus.';
