-- Technical vocabulary for Candidate.searchTsv.
--
-- Postgres's `english` text-search configuration destroys the tokens that
-- matter most in technical recruiting. Measured against this database on
-- 2026-08-11:
--
--     .net        -> 'net'                  (collides with "net profit")
--     c#          -> 'c'
--     c++         -> 'c'                    <- C# and C++ are the SAME token
--     f#          -> 'f'
--     objective-c -> 'objective-c' and 'c'  (pollutes every C# search)
--
-- Real impact on the live library: a `C#` search returned 5,481 rows of which
-- only 3,383 mentioned C# (38% noise); `.NET` returned 3,185 of which 2,687
-- were genuine (16% noise). C++ developers were indistinguishable from C#
-- developers to the index.
--
-- The fix is a sentinel vocabulary, added as EXTRA tsvector components rather
-- than replacing the existing ones. Text containing `c#` still contributes
-- 'c', but now ALSO contributes 'csharpx' — a token no ordinary English text
-- can produce. Queries for C# ask for 'csharpx' and stop matching C++.
-- Nothing that matched before stops matching, so this is purely additive to
-- recall and purely subtractive to noise.
--
-- Only the sentinels are indexed, not a second copy of the profile text, so
-- the index grows by at most six short tokens per row.
--
-- The same six sentinels are produced in TypeScript by
-- src/lib/talent-search/tech-vocab.ts. A unit test asserts the two lists
-- agree; if you add a sentinel, add it in BOTH places or queries will ask for
-- a token the index never emits.
--
-- Verified in Postgres before writing this: all six sentinels survive the
-- english stemmer unchanged, and a `simple`-config vector entry matches an
-- `english`-config to_tsquery for the same sentinel.

-- Extract only the technical sentinels present in a piece of text.
-- IMMUTABLE + PARALLEL SAFE so it can be used in a GENERATED column.
CREATE OR REPLACE FUNCTION recruitme_tech_tokens(t text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT btrim(
    -- ASP.NET is matched first and given its own sentinel; the bare .NET test
    -- below runs against the text with asp.net removed, so "ASP.NET" alone does
    -- not also emit dotnetx, while "ASP.NET on .NET 8" correctly emits both.
    (CASE WHEN lower(t) LIKE '%asp.net%'      THEN 'aspdotnetx '  ELSE '' END) ||
    (CASE WHEN regexp_replace(lower(t), 'asp\.net', ' ', 'g') ~ '(^|[^a-z0-9])\.net'
                                              THEN 'dotnetx '     ELSE '' END) ||
    (CASE WHEN lower(t) LIKE '%c++%'          THEN 'cplusplusx '  ELSE '' END) ||
    (CASE WHEN lower(t) LIKE '%c#%'           THEN 'csharpx '     ELSE '' END) ||
    (CASE WHEN lower(t) LIKE '%f#%'           THEN 'fsharpx '     ELSE '' END) ||
    (CASE WHEN lower(t) LIKE '%objective-c%'  THEN 'objectivecx ' ELSE '' END)
  );
$$;

-- Rebuild the generated column with the two extra sentinel components.
-- A GENERATED column is fully derived, so dropping and re-adding loses nothing;
-- Postgres recomputes every row. DDL is transactional here, so a failure rolls
-- back to the previous working column rather than leaving search broken.
DROP INDEX IF EXISTS "Candidate_searchTsv_gin_idx";
ALTER TABLE "Candidate" DROP COLUMN IF EXISTS "searchTsv";

ALTER TABLE "Candidate" ADD COLUMN "searchTsv" tsvector
GENERATED ALWAYS AS (
  setweight(to_tsvector('english', coalesce("name", '')), 'A') ||
  setweight(to_tsvector('english', coalesce("headline", '') || ' ' || coalesce("archivedJobTitle", '')), 'B') ||
  setweight(to_tsvector('english', coalesce("location", '') || ' ' || coalesce("archivedJobCompany", '')), 'C') ||
  setweight(to_tsvector('english', coalesce("profileText", '')), 'D') ||
  -- Sentinels inherit the weight of the field they came from, so ranking
  -- semantics are unchanged: a headline hit still outranks a body hit.
  setweight(to_tsvector('simple', recruitme_tech_tokens(coalesce("headline", ''))), 'B') ||
  setweight(to_tsvector('simple', recruitme_tech_tokens(coalesce("profileText", ''))), 'D')
) STORED;

CREATE INDEX "Candidate_searchTsv_gin_idx" ON "Candidate" USING gin ("searchTsv");
