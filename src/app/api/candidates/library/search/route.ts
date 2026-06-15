/**
 * GET /api/candidates/library/search?q=...&location=...&limit=N
 *
 * Boolean search across the candidate library, backed by the Phase F
 * Postgres FTS pipeline (Candidate.searchTsv tsvector). Accepts the same
 * boolean syntax as the multi-source job search:
 *
 *   (java OR python) AND senior NOT junior "machine learning"
 *
 * Org-scoped via getAccessibleOrgIds — non-owners only see their own
 * org's library (and any shared orgs). Empty `q` returns recency-ordered
 * rows (same shape as the library glance) so the UI can show "all" too.
 *
 * Response shape is intentionally similar to the library SSR loader
 * (src/lib/library.ts) so the client component can swap between
 * SSR-paginated and search-driven results with minimal branching.
 */

import { NextResponse } from "next/server";
import { getAuth, unauthorized } from "@/lib/session";
import { getAccessibleOrgIds } from "@/lib/org-access";
import { parseBooleanQuery } from "@/lib/boolean-query";
import { searchLibrary } from "@/lib/talent-search/library";

export async function GET(req: Request) {
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const url      = new URL(req.url);
  const q        = url.searchParams.get("q") ?? "";
  const location = url.searchParams.get("location");
  const limit    = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);

  const accessibleOrgIds = await getAccessibleOrgIds(auth);
  const parsed = parseBooleanQuery(q);

  const results = await searchLibrary({
    parsedQuery: parsed,
    accessibleOrgIds,
    ownOrgId: auth.orgId, // own-org insight scope (never the grant set)
    location,
    limit,
  });

  // Map to the shape the library client component expects. Field names
  // mirror the SSR loader so the React layer doesn't care which path
  // produced the row.
  const candidates = results.map((r) => ({
    id: r.id,
    name: r.name,
    headline: r.headline,
    location: r.location,
    linkedinUrl: r.linkedinUrl,
    jobAdderUrl: r.jobAdderUrl,
    phone: null as string | null,        // not in FTS result; lazy if needed
    email: null as string | null,         // same
    photoFileId: r.photoFileId,
    matchScore: r.matchScore,
    source: r.source,
    importBatchId: null as string | null, // FTS doesn't carry this
    status: "new",
    notes: null,
    sharedFromOrgName: null as string | null,
    profileCapturedAt: null as string | null,
    createdAt: r.createdAt.toISOString(),
    job: null,
    archivedJobTitle: null,
    archivedJobCompany: null,
    files: [],
    relevance: r.relevance,
    profileTextSnippet: r.profileTextSnippet,
  }));

  return NextResponse.json({
    candidates,
    total: candidates.length,
    parsed: {
      mustHave: parsed.mustHave,
      anyOf: parsed.anyOf,
      mustNot: parsed.mustNot,
      hasErrors: parsed.hasErrors,
      errors: parsed.errors,
    },
  });
}
