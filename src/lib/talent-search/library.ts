/**
 * Library search for the multi-source talent search feature.
 *
 * Phase F rewrite — switched from JS-side substring scanning to Postgres
 * full-text search via the generated `searchTsv` tsvector column.
 * Performance at 14k → 100k rows: sub-100ms (GIN-backed). Ranking now
 * uses `ts_rank_cd` (cover-density rewards proximity) blended with the
 * existing `matchScore` so prior AI scoring still shapes the order.
 *
 * Boolean operators supported (`AND` / `OR` / `NOT` / `()` / `"phrase"`)
 * come from src/lib/boolean-query — that's the parser the multi-source
 * route also feeds. The translator from ParsedQuery to a `to_tsquery`
 * string lives in ../boolean-query/emit.
 *
 * Schema: see apply-schema-changes.mjs step 29 — searchTsv is a
 * GENERATED ALWAYS column on Candidate built from name (A), headline (B),
 * location (C), profileText (D) — Postgres maintains it automatically.
 */

import { prisma } from "../db";
import type { ParsedQuery } from "../boolean-query";
import { tsqueryFromParsed } from "../boolean-query/emit";

export interface LibrarySearchOptions {
  parsedQuery: ParsedQuery;
  /** Result of getAccessibleOrgIds(auth). null = owner (no scope filter). */
  accessibleOrgIds: string[] | null;
  /** Plain-text location filter — matches against Candidate.location. */
  location?: string | null;
  /** Hard upper bound. Default 100. */
  limit?: number;
}

export interface LibrarySearchResult {
  id: string;
  name: string;
  headline: string | null;
  location: string | null;
  linkedinUrl: string | null;
  jobAdderUrl: string | null;
  seekUrl: string | null;
  photoFileId: string | null;
  matchScore: number | null;
  source: string;
  profileTextSnippet: string | null;
  candidateIdentityId: string | null;
  createdAt: Date;
  /** Postgres ts_rank_cd output (cover-density rank). 0 when query was
   *  empty — rows then fall back to recency / matchScore order. */
  relevance: number;
}

// Cap the response body — full profileText is large and the client only
// needs a peek for the result card.
const PROFILE_SNIPPET_CHARS = 400;

// Blend weights for the final ORDER BY:
//   final = ts_rank_cd * RANK_WEIGHT + (matchScore/100) * SCORE_WEIGHT
// AI score wins when present (60/40 in its favour) but FTS rank tiebreaks.
const RANK_WEIGHT  = 0.4;
const SCORE_WEIGHT = 0.6;

interface RawRow {
  id: string;
  name: string;
  headline: string | null;
  location: string | null;
  linkedinUrl: string | null;
  jobAdderUrl: string | null;
  seekUrl: string | null;
  photoFileId: string | null;
  matchScore: number | null;
  source: string;
  candidateIdentityId: string | null;
  createdAt: Date;
  profileTextSnippet: string | null;
  relevance: number;
}

/**
 * Run a library search.
 *
 * - With a query: FTS via `searchTsv @@ to_tsquery(...)`, ranked by
 *   `ts_rank_cd` blended with matchScore.
 * - Without a query: recency-ordered Candidate.findMany fallback.
 *
 * Org scoping mirrors the rest of the library: owners (accessibleOrgIds
 * === null) see everything; everyone else is gated to their accessible
 * orgs via the candidate.orgId / candidate.job.orgId OR pair.
 */
export async function searchLibrary(
  opts: LibrarySearchOptions,
): Promise<LibrarySearchResult[]> {
  const { parsedQuery, accessibleOrgIds, location, limit = 100 } = opts;

  // Non-owner with zero accessible orgs short-circuits.
  if (accessibleOrgIds !== null && accessibleOrgIds.length === 0) return [];

  const tsquery = tsqueryFromParsed(parsedQuery);
  const useOrgFilter = accessibleOrgIds !== null;
  const orgIdsParam = accessibleOrgIds ?? [];
  const trimmedLocation = location?.trim() || null;

  // ── Empty-query path: recency-ordered library glance ─────────────────
  if (!tsquery) {
    const rows = await prisma.$queryRaw<RawRow[]>`
      SELECT
        c."id", c."name", c."headline", c."location",
        c."linkedinUrl", c."jobAdderUrl", c."seekUrl", c."photoFileId",
        c."matchScore", c."source", c."candidateIdentityId", c."createdAt",
        LEFT(c."profileText", ${PROFILE_SNIPPET_CHARS}::int) AS "profileTextSnippet",
        0::real AS "relevance"
      FROM "Candidate" c
      LEFT JOIN "Job" j ON j.id = c."jobId"
      WHERE (
          ${!useOrgFilter}::boolean
          OR j."orgId" = ANY(${orgIdsParam}::text[])
          OR (c."jobId" IS NULL AND c."orgId" = ANY(${orgIdsParam}::text[]))
        )
        AND (c."jobId" IS NOT NULL OR c."orgId" IS NOT NULL)
        AND (
          ${trimmedLocation === null}::boolean
          OR c."location" ILIKE '%' || ${trimmedLocation ?? ''} || '%'
        )
      ORDER BY c."createdAt" DESC
      LIMIT ${limit}
    `;
    return rows.map(addSnippetSuffix);
  }

  // ── FTS path: searchTsv @@ to_tsquery, ranked by ts_rank_cd + matchScore ──
  // ts_rank_cd's default weights {0.1, 0.2, 0.4, 1.0} apply to the
  // tsvector's D/C/B/A weights respectively — i.e. A (name) is the most
  // valuable hit, D (profileText) is the least. That matches recruiter
  // intuition. Pass them explicitly so the math is auditable here rather
  // than living as a Postgres default that could shift.
  const rows = await prisma.$queryRaw<RawRow[]>`
    SELECT
      c."id", c."name", c."headline", c."location",
      c."linkedinUrl", c."jobAdderUrl", c."seekUrl", c."photoFileId",
      c."matchScore", c."source", c."candidateIdentityId", c."createdAt",
      LEFT(c."profileText", ${PROFILE_SNIPPET_CHARS}::int) AS "profileTextSnippet",
      ts_rank_cd(ARRAY[0.1, 0.2, 0.4, 1.0]::real[], c."searchTsv", q) AS "relevance"
    FROM "Candidate" c
    LEFT JOIN "Job" j ON j.id = c."jobId",
         to_tsquery('english', ${tsquery}) q
    WHERE c."searchTsv" @@ q
      AND (
        ${!useOrgFilter}::boolean
        OR j."orgId" = ANY(${orgIdsParam}::text[])
        OR (c."jobId" IS NULL AND c."orgId" = ANY(${orgIdsParam}::text[]))
      )
      AND (c."jobId" IS NOT NULL OR c."orgId" IS NOT NULL)
      AND (
        ${trimmedLocation === null}::boolean
        OR c."location" ILIKE '%' || ${trimmedLocation ?? ''} || '%'
      )
    ORDER BY (
      ts_rank_cd(ARRAY[0.1, 0.2, 0.4, 1.0]::real[], c."searchTsv", q) * ${RANK_WEIGHT}::real
      + (COALESCE(c."matchScore", 50)::real / 100) * ${SCORE_WEIGHT}::real
    ) DESC,
    c."createdAt" DESC
    LIMIT ${limit}
  `;

  return rows.map(addSnippetSuffix);
}

// Postgres LEFT returns the full prefix; add an ellipsis if it was cut.
// We don't have profileText length here, so the heuristic is "if the
// snippet hit the max it was probably truncated". Cheap and good enough.
function addSnippetSuffix(r: RawRow): LibrarySearchResult {
  const snippet = r.profileTextSnippet ?? null;
  return {
    ...r,
    profileTextSnippet:
      snippet && snippet.length === PROFILE_SNIPPET_CHARS ? snippet + "…" : snippet,
  };
}
