/**
 * POST /api/jobs/[id]/search/multi — multi-source talent search (Phase 2a).
 *
 * Takes a boolean query + filters + source toggles, fans out in parallel
 * to the enabled sources, dedups via the identity layer, returns a unified
 * result list for the recruiter to review and selectively import.
 *
 * NO IMPORT happens here. Recruiter picks rows in the UI, then a separate
 * bulk-add route (Day 5) handles the actual attach-to-job side. Keeping
 * search and import separate matches the JobAdder UX the user demoed
 * (search → pick → add) and avoids charging AI tokens on rows the
 * recruiter ends up rejecting.
 *
 * Auth: standard getAuth + requireJobAccess. Rate-limited via the
 * existing "search" type so multi-source counts against the same hourly
 * budget as the legacy search route.
 *
 * Partial failure tolerance: if one source errors (e.g. SerpAPI down)
 * but others succeed, the route returns 200 with results from the
 * working sources plus an `errors` object naming which source failed and
 * why. Hard 4xx only on auth / validation / rate-limit / cap.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuth, requireJobAccess, unauthorized } from "@/lib/session";
import { getAccessibleOrgIds } from "@/lib/org-access";
import { checkRateLimit, recordUsage } from "@/lib/usage";
import { getServerSetting } from "@/lib/settings";
import { parseBooleanQuery } from "@/lib/boolean-query";
import { searchLibrary } from "@/lib/talent-search/library";
import { searchLinkedIn } from "@/lib/talent-search/linkedin";
import { aggregateSources } from "@/lib/talent-search/aggregate";
import { reportError } from "@/lib/error-reporting";

const SourceSchema = z.enum(["library", "linkedin"]);

const BodySchema = z.object({
  query: z.string().max(2000),
  location: z.string().max(200).optional().nullable(),
  sources: z.array(SourceSchema).min(1).default(["library", "linkedin"]),
  /** Per-source hard caps. Library defaults to 100, LinkedIn to 30. */
  libraryLimit: z.number().int().min(1).max(500).optional(),
  linkedinLimit: z.number().int().min(1).max(50).optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;

  const { error: accessError } = await requireJobAccess(id, auth);
  if (accessError) return accessError;

  // Rate limit — multi-source search counts under the same "search"
  // bucket as the legacy route so a recruiter can't bypass the hourly
  // cap by alternating between endpoints.
  const rate = await checkRateLimit(auth.orgId, "search");
  if (!rate.allowed) {
    const waitMin = Math.ceil((rate.retryAfterMs ?? 60_000) / 60_000);
    return NextResponse.json(
      { error: `Search rate limit reached. Try again in ~${waitMin} minute${waitMin !== 1 ? "s" : ""}.` },
      { status: 429 },
    );
  }

  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 });
  }
  const { query, location, sources, libraryLimit, linkedinLimit } = parsed.data;

  const parsedQuery = parseBooleanQuery(query);

  const accessibleOrgIds = await getAccessibleOrgIds(auth);

  // Resolve SerpAPI key only if linkedin is requested — saves a Setting
  // table read on library-only searches. Same env-then-DB pattern as the
  // legacy search route at src/app/api/jobs/[id]/search/route.ts:397.
  let serpApiKey = "";
  if (sources.includes("linkedin")) {
    const dbKey = process.env.SERPAPI_API_KEY ? null : await getServerSetting("SERPAPI_API_KEY");
    serpApiKey = process.env.SERPAPI_API_KEY || dbKey || "";
  }

  // Track per-source errors without blowing up the whole request — one
  // source failing should NOT prevent the other from delivering results.
  const errors: Partial<Record<"library" | "linkedin", string>> = {};

  const librarySearchPromise = sources.includes("library")
    ? searchLibrary({
        parsedQuery,
        accessibleOrgIds,
        location,
        limit: libraryLimit ?? 100,
      }).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        reportError(err, { route: "search/multi/library", jobId: id, orgId: auth.orgId });
        errors.library = msg;
        return [];
      })
    : Promise.resolve([]);

  const linkedinSearchPromise = sources.includes("linkedin")
    ? !serpApiKey
      ? (() => {
          errors.linkedin = "SerpAPI key not configured. Set SERPAPI_API_KEY in env or via Settings → API Keys.";
          return Promise.resolve([] as Awaited<ReturnType<typeof searchLinkedIn>>);
        })()
      : searchLinkedIn({
          parsedQuery,
          location,
          limit: linkedinLimit ?? 30,
          serpApiKey,
        }).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          reportError(err, { route: "search/multi/linkedin", jobId: id, orgId: auth.orgId });
          errors.linkedin = msg;
          return [];
        })
    : Promise.resolve([]);

  const [libraryResults, linkedinResults] = await Promise.all([
    librarySearchPromise,
    linkedinSearchPromise,
  ]);

  const aggregated = aggregateSources({
    library: libraryResults,
    linkedin: linkedinResults,
  });

  // Record usage for rate-limit accounting + analytics. Fire-and-forget —
  // never block the response on the audit write.
  void recordUsage(auth.orgId, auth.userId, "search", {
    route: "search/multi",
    jobId: id,
    sources,
    libraryCount: aggregated.counts.libraryRaw,
    linkedinCount: aggregated.counts.linkedinRaw,
    dedupedCount: aggregated.counts.deduped,
    totalCount: aggregated.counts.total,
    hasErrors: Object.keys(errors).length > 0,
  });

  return NextResponse.json({
    query: {
      raw: parsedQuery.raw,
      mustHave: parsedQuery.mustHave,
      anyOf: parsedQuery.anyOf,
      mustNot: parsedQuery.mustNot,
      hasErrors: parsedQuery.hasErrors,
      errors: parsedQuery.errors,
    },
    results: aggregated.results,
    counts: aggregated.counts,
    errors: Object.keys(errors).length > 0 ? errors : undefined,
  });
}
