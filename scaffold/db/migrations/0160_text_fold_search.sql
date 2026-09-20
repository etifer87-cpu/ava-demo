-- 0160_text_fold_search.sql
-- Search must not care about accents. On a Colombian roster it decides whether a pilot is found.
--
-- THE DEFECT, found walking the demo script on 2026-09-20: `/sessions?q=Marin Morales` returned
-- ZERO sessions while `/sessions?q=Marín Morales` returned 21. Every search box in the product
-- compared with ILIKE against the stored name, so a chief pilot who types a name without the accent
-- concludes the pilot is not in the system. Marín, Vélez, Bermúdez, Peña, Jiménez, Rodríguez,
-- Álvarez, Cañón - it is most of the roster, not an edge case.
--
-- unaccent() is STABLE, not IMMUTABLE, because a dictionary can be redefined. text_fold() wraps it
-- IMMUTABLE, which is the documented pattern for making the expression indexable. The lie is
-- bounded and deliberate: nobody redefines the unaccent dictionary on this instance, and if anyone
-- ever does, the fix is to reindex, not to have shipped a search that cannot find Peña.
--
-- PARALLEL SAFE and IMMUTABLE so it can be hoisted and indexed rather than evaluated per row - the
-- same property migrations 0155 and 0158 were about.

CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE OR REPLACE FUNCTION text_fold(p_text TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT lower(public.unaccent('public.unaccent', p_text)) $$;

COMMENT ON FUNCTION text_fold(TEXT) IS
  'Lower-cased and accent-stripped, for search comparison only. Never for storage or display: the '
  'name on a training record is spelled the way the pilot spells it. Added 0160 because search was '
  'accent-sensitive and "Marin" found nothing while "Marín" found 21 sessions.';

-- Indexes on the folded name, so the sweep does not turn every search into a sequential scan with a
-- function call per row. pg_trgm powers the leading-wildcard LIKE these searches use.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS people_full_name_fold_trgm
  ON people USING gin (text_fold(full_name) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS people_external_id_fold_trgm
  ON people USING gin (text_fold(external_id) gin_trgm_ops);
