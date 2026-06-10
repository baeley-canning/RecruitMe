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
import { prisma } from "@/lib/db";
import { getAccessibleOrgIds } from "@/lib/org-access";
import { checkRateLimit, recordUsage } from "@/lib/usage";
import { parseBooleanQuery } from "@/lib/boolean-query";
import { searchLibrary } from "@/lib/talent-search/library";
import { aggregateSources } from "@/lib/talent-search/aggregate";
import { reportError } from "@/lib/error-reporting";
import { isScraperDiscoveryEnabled } from "@/lib/feature-flags";
import { enqueueSearchJob } from "@/lib/scrape-queue";

const SourceSchema = z.enum(["library", "linkedin", "seek"]);

const BodySchema = z.object({
  query: z.string().max(2000),
  location: z.string().max(200).optional().nullable(),
  sources: z.array(SourceSchema).min(1).default(["library", "linkedin"]),
  /** Per-source hard caps. Library defaults to 100, LinkedIn to 30. */
  libraryLimit: z.number().int().min(1).max(500).optional(),
  linkedinLimit: z.number().int().min(1).max(50).optional(),
  /** Company names to exclude (the client + competitors). When sent, it's
   *  authoritative + persisted on the job so the next search remembers it. */
  excludeCompanies: z.array(z.string().max(120)).max(50).optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;

  const { job, error: accessError } = await requireJobAccess(id, auth);
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
  const { query, location, sources, libraryLimit, linkedinLimit, excludeCompanies } = parsed.data;

  // Effective company exclusion: a list sent with the request is authoritative
  // and persisted on the job (so the next search remembers it); otherwise fall
  // back to the job's stored excludedCompanies.
  const storedExclusions = (job?.excludedCompanies ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const effectiveExclusions = excludeCompanies ?? storedExclusions;
  if (excludeCompanies !== undefined) {
    const normalised = excludeCompanies.map((s) => s.trim()).filter(Boolean).join(", ");
    void prisma.job.update({ where: { id }, data: { excludedCompanies: normalised || null } }).catch(() => {});
  }

  const parsedQuery = parseBooleanQuery(query);

  const accessibleOrgIds = await getAccessibleOrgIds(auth);

  // Track per-source errors without blowing up the whole request — one
  // source failing should NOT prevent the other from delivering results.
  const errors: Partial<Record<"library" | "linkedin", string>> = {};

  const wantLibrary = sources.includes("library");
  const wantLinkedin = sources.includes("linkedin");

  // Target result count before reaching outward. Library-first: once the
  // library returns this many, we don't need the scraper for this query.
  const serpTarget = linkedinLimit ?? 30;

  let libraryResults: Awaited<ReturnType<typeof searchLibrary>> = [];
  if (wantLibrary) {
    try {
      libraryResults = await searchLibrary({
        parsedQuery,
        accessibleOrgIds,
        location,
        excludeCompanies: effectiveExclusions,
        limit: libraryLimit ?? 100,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reportError(err, { route: "search/multi/library", jobId: id, orgId: auth.orgId });
      errors.library = msg;
    }
  }

  // Phase K — SerpAPI removed. LinkedIn discovery is scraper-only: the live
  // priority=100 scraper job enqueued below IS the LinkedIn fetch. There is
  // no synchronous LinkedIn search anymore, so the aggregator's linkedin
  // slot is always empty here; harvested profiles land in the library and
  // surface on the next run (or via the durable /search SearchRun page).
  const linkedinResults: never[] = [];
  if (wantLinkedin && !isScraperDiscoveryEnabled()) {
    errors.linkedin = "LinkedIn discovery is offline (scraper unavailable).";
  }

  const aggregated = aggregateSources({
    library: libraryResults,
    linkedin: linkedinResults,
  });

  // Phase H — Live scraper jobs. Whenever the library shortfall isn't
  // covered, enqueue a priority=100 scraper search for each requested
  // external source. The worker's priority-aware poll picks these up
  // ahead of any background discovery work; the client polls
  // /api/scraper/jobs/[id]/status to merge results as they land.
  //
  // We surface the job IDs in the response so the client knows which to
  // poll. Empty list = nothing live in-flight (sources were satisfied by
  // the library, or external discovery is disabled).
  const libraryShortfall = wantLibrary
    ? Math.max(0, serpTarget - libraryResults.length)
    : serpTarget;
  const liveJobs: Array<{ id: string; platform: "linkedin" | "seek" }> = [];
  const queryRaw = parsedQuery.raw.trim();
  // Fire live discovery when the pool falls short (auto) OR whenever the
  // recruiter explicitly toggled a live source ON. A well-stocked library must
  // NOT suppress a deliberately-requested LinkedIn/SEEK search — that was the
  // old behaviour and it meant fresh discovery silently never ran for common
  // queries. Volume stays bounded by the hourly "search" rate limit above.
  const liveRequested = wantLinkedin || sources.includes("seek");
  if ((libraryShortfall > 0 || liveRequested) && queryRaw.length > 0 && isScraperDiscoveryEnabled() && auth.orgId) {
    if (wantLinkedin) {
      const j = await enqueueSearchJob({
        orgId: auth.orgId,
        platform: "linkedin",
        searchQuery: queryRaw,
        searchLocation: location,
        requestedBy: auth.userId,
        priority: 100,
      });
      if (j) liveJobs.push({ id: j.id, platform: "linkedin" });
    }
    if (sources.includes("seek")) {
      const j = await enqueueSearchJob({
        orgId: auth.orgId,
        platform: "seek",
        searchQuery: queryRaw,
        // Without this the modal's SEEK leg ran nation-wide and harvested its
        // 100-card cap; now it scopes to the recruiter's region like the library.
        searchLocation: location,
        requestedBy: auth.userId,
        priority: 100,
      });
      if (j) liveJobs.push({ id: j.id, platform: "seek" });
    }
  }

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
    liveJobs: liveJobs.length,
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
    counts: {
      ...aggregated.counts,
      // How many came from the local library vs the live scraper path.
      fromLibrary: aggregated.counts.libraryRaw,
      fromScraper: aggregated.counts.linkedinRaw,
    },
    // Phase H — IDs of priority=100 scraper jobs the client should poll
    // via /api/scraper/jobs/[id]/status. Empty array = no live work
    // in-flight (library satisfied the request, or discovery is gated off).
    liveJobs,
    errors: Object.keys(errors).length > 0 ? errors : undefined,
  });
}
