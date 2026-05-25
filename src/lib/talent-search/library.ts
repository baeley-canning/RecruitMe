/**
 * Library search for the multi-source talent search feature (Phase 2a).
 *
 * Takes a structured ParsedQuery (from parseBooleanQuery) + org scope +
 * optional location filter and returns matching Candidate rows from the
 * cross-org library. Does NOT save anything — the multi-source route
 * returns results to the recruiter for selection; the existing
 * /api/jobs/[id]/library POST handles the import side.
 *
 * Intentionally simpler than the talent-pool route's tuned prefilter
 * logic. Talent-pool optimises for "find me everyone matching this
 * parsedRole's must-haves"; this module optimises for "find me everyone
 * matching this recruiter's exact boolean query." Different use case,
 * different shape. The talent-pool route is unchanged; this is additive.
 *
 * Future work (Phase 2b+):
 * - Pull in talent-pool's pg_trgm GIN-index optimisation if query
 *   volumes blow up the response time
 * - Add insight-aware ranking when ProfileInsight extractor is live
 * - Hook scraper output as another source via the same shape
 */

import { prisma } from "../db";
import type { ParsedQuery } from "../boolean-query";

export interface LibrarySearchOptions {
  parsedQuery: ParsedQuery;
  /** Result of getAccessibleOrgIds(auth). null = owner (no scope filter). */
  accessibleOrgIds: string[] | null;
  /** Plain-text location filter — matches against Candidate.location.
   *  Defaults to no filter. */
  location?: string | null;
  /** Hard upper bound. Default 100 — multi-source search results are
   *  visual; 100 is enough for a recruiter to scan and decide. */
  limit?: number;
}

export interface LibrarySearchResult {
  id: string;
  name: string;
  headline: string | null;
  location: string | null;
  linkedinUrl: string | null;
  jobAdderUrl: string | null;
  photoFileId: string | null;
  matchScore: number | null;
  source: string;
  /** profileText snippet for relevance / scoring; capped server-side. */
  profileTextSnippet: string | null;
  candidateIdentityId: string | null;
  createdAt: Date;
}

/**
 * Run a library search.
 *
 * Behaviour notes:
 * - Empty parsedQuery (no must-have / no anyOf / no must-not) returns
 *   the recent-rows shape so a recruiter who clears their query still
 *   sees something.
 * - Each anyOf group becomes a Prisma OR clause inside an AND.
 * - mustNot terms become a chain of `NOT { profileText: { contains: ... } }`.
 * - Owner (accessibleOrgIds === null) sees all rows; otherwise rows are
 *   gated to the caller's accessible org list via the same OR-of-orgIds
 *   pattern the library helper uses.
 * - profileText is sliced to PROFILE_SNIPPET_CHARS in the response to
 *   keep network payloads small. The full text stays in the DB.
 */
export async function searchLibrary(
  opts: LibrarySearchOptions,
): Promise<LibrarySearchResult[]> {
  const { parsedQuery, accessibleOrgIds, location, limit = 100 } = opts;

  // Org-scope clause. accessibleOrgIds === null is "owner sees all".
  // Empty array means caller has no accessible orgs — return nothing.
  const orgScope = accessibleOrgIds === null
    ? {}
    : accessibleOrgIds.length === 0
      ? { AND: [{ orgId: { in: [] as string[] } }] }
      : {
          OR: [
            { orgId: { in: accessibleOrgIds } },
            { job: { orgId: { in: accessibleOrgIds } } },
          ],
        };

  // Build query terms as Prisma clauses. Each `mustHave` term becomes
  // its own AND-level `contains` predicate. `anyOf` groups OR within
  // a group, AND across groups (a recruiter typing `(A OR B) AND (C OR D)`
  // wants rows that have at least one of {A,B} AND at least one of {C,D}).
  // `mustNot` terms negate via a NOT-contains chain.
  const containsClause = (term: string) =>
    ({ profileText: { contains: term, mode: "insensitive" as const } });

  const mustHaveClauses = parsedQuery.mustHave.map(containsClause);

  const anyOfClauses = parsedQuery.anyOf.map((group) => ({
    OR: group.map(containsClause),
  }));

  const mustNotClauses = parsedQuery.mustNot.map((term) => ({
    NOT: containsClause(term),
  }));

  // Combine. Empty term lists short-circuit to no-op so the query still
  // returns recent rows when nothing was typed.
  const termClauses: Record<string, unknown>[] = [
    ...mustHaveClauses,
    ...anyOfClauses,
    ...mustNotClauses,
  ];

  // Location filter — plain-text substring. The recruiter typing
  // "Wellington" should match "Wellington, New Zealand" rows.
  const locationClause = location && location.trim().length > 0
    ? [{ location: { contains: location.trim(), mode: "insensitive" as const } }]
    : [];

  // Final WHERE: org scope + term clauses + location, plus the
  // hardcoded "must have profileText" gate (no point surfacing rows
  // we can't ever match against).
  const where: Record<string, unknown> = {
    profileText: { not: null },
    ...orgScope,
    ...(termClauses.length + locationClause.length > 0
      ? { AND: [...termClauses, ...locationClause] }
      : {}),
  };

  const rows = await prisma.candidate.findMany({
    where,
    select: {
      id: true,
      name: true,
      headline: true,
      location: true,
      linkedinUrl: true,
      jobAdderUrl: true,
      photoFileId: true,
      matchScore: true,
      source: true,
      profileText: true,
      candidateIdentityId: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  // Trim profileText to a snippet — full bodies are TOAST'd and expensive
  // to ship to the client. The recruiter only needs a peek.
  const PROFILE_SNIPPET_CHARS = 400;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    headline: r.headline,
    location: r.location,
    linkedinUrl: r.linkedinUrl,
    jobAdderUrl: r.jobAdderUrl,
    photoFileId: r.photoFileId,
    matchScore: r.matchScore,
    source: r.source,
    candidateIdentityId: r.candidateIdentityId,
    createdAt: r.createdAt,
    profileTextSnippet: r.profileText
      ? r.profileText.slice(0, PROFILE_SNIPPET_CHARS) + (r.profileText.length > PROFILE_SNIPPET_CHARS ? "…" : "")
      : null,
  }));
}
