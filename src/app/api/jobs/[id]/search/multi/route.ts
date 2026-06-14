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
import { safeParseJson } from "@/lib/utils";
import type { ParsedRole } from "@/lib/ai";
import { searchLibrary } from "@/lib/talent-search/library";
import { runResultToUnified } from "@/lib/talent-search/run-to-unified";
import { createRun, attachLibraryResults, setSourceStatus, loadRunSnapshot } from "@/lib/search-run";
import { reportError } from "@/lib/error-reporting";
import { isScraperDiscoveryEnabled } from "@/lib/feature-flags";
import { enqueueSearchJob } from "@/lib/scrape-queue";
import { linkedinKeywordsFromParsed, linkedinTitleQuery, seekKeywordsFromParsed } from "@/lib/boolean-query/emit";

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
  const { query, location, sources, libraryLimit, excludeCompanies } = parsed.data;

  // Effective company exclusion: a list sent with the request is authoritative
  // and persisted on the job (so the next search remembers it); otherwise fall
  // back to the job's stored excludedCompanies.
  const storedExclusions = (job?.excludedCompanies ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const effectiveExclusions = excludeCompanies ?? storedExclusions;
  if (excludeCompanies !== undefined) {
    const normalised = excludeCompanies.map((s) => s.trim()).filter(Boolean).join(", ");
    // Persist ONLY when it actually changed, so a zero-interaction role auto-run
    // can't silently make a transient exclusion sticky on the job.
    if (normalised !== (job?.excludedCompanies ?? "").trim()) {
      void prisma.job.update({ where: { id }, data: { excludedCompanies: normalised || null } }).catch(() => {});
    }
  }

  const parsedQuery = parseBooleanQuery(query);
  const queryRaw = parsedQuery.raw.trim();
  // Per-platform keyword strings for the scraper (was: the raw boolean for both).
  // Each emitter renders the parsed AST in that platform's keyword syntax (quotes
  // phrases, parenthesises OR-groups, LinkedIn strips `*`), so the box types a
  // clean, platform-correct query rather than our internal raw string. Fall back
  // to the raw query if an emitter yields nothing.
  //
  // LinkedIn EXCEPTION: its basic people-search returns 0 on the full
  // `(titles) AND (skills)` boolean (verified on the box), so when the job has a
  // parsed role, search LinkedIn by the role's TITLE synonyms only — the signal
  // it matches reliably — and let AI scoring filter skills. Manual/no-role
  // searches fall back to the emitted boolean.
  const roleForLi = safeParseJson<ParsedRole | null>(job?.parsedRole ?? null, null);
  const liTitleQuery = roleForLi
    ? linkedinTitleQuery([roleForLi.title, ...(roleForLi.synonym_titles ?? [])])
    : "";
  const linkedinKeywords = liTitleQuery || linkedinKeywordsFromParsed(parsedQuery) || queryRaw;
  const seekKeywords = seekKeywordsFromParsed(parsedQuery) || queryRaw;

  // Library FTS scope (owners span their accessible orgs; non-owners pinned).
  const accessibleOrgIds = await getAccessibleOrgIds(auth);
  // Scraper jobs + the run need a CONCRETE org (ingested profiles attach to it).
  // A job always has one: use the job's org, falling back to the caller's.
  const runOrgId = job?.orgId ?? auth.orgId ?? null;

  // Track per-source errors without blowing up the whole request.
  const errors: Partial<Record<"library" | "linkedin", string>> = {};

  const wantLibrary = sources.includes("library");
  const wantLinkedin = sources.includes("linkedin");
  const wantSeek = sources.includes("seek");
  const scraperOn = isScraperDiscoveryEnabled();
  // A scraper job needs a concrete org + a non-empty query.
  const canScrape = scraperOn && queryRaw.length > 0 && runOrgId != null;
  if (wantLinkedin && !scraperOn) {
    errors.linkedin = "LinkedIn discovery is offline (scraper unavailable).";
  }

  // Initial per-source statuses for the run row.
  const initialStatus = (want: boolean, isScraper: boolean) => {
    if (!want) return "skipped" as const;
    if (!isScraper) return "running" as const; // library runs inline next
    return canScrape ? ("running" as const) : ("skipped" as const);
  };

  // ── 1. Commit the durable run FIRST (survives a tab close). Scoped to the
  // job so the page can resume "this job's latest search" on return. ──
  const run = await createRun({
    orgId: runOrgId,
    jobId: id,
    requestedBy: auth.userId,
    rawQuery: query,
    parsedQuery,
    location: location ?? null,
    sources,
    libraryStatus: initialStatus(wantLibrary, false),
    linkedinStatus: initialStatus(wantLinkedin, true),
    seekStatus: initialStatus(wantSeek, true),
  });

  // ── 2. Library FTS inline — instant results attach to the run ──
  // AUTO-BROADEN: if the precise query finds nothing, don't dead-end the
  // recruiter — automatically retry through the AI's own pre-generated
  // alternative searches (parsedRole.search_queries — broader keyword combos)
  // until results appear, then tell the UI what it broadened to. This is the
  // "the AI tweaks the search instead of returning 0" behaviour.
  let broadenedTo: string | null = null;
  if (wantLibrary) {
    try {
      const lib = (q: ReturnType<typeof parseBooleanQuery>) => searchLibrary({
        parsedQuery: q,
        accessibleOrgIds,
        location,
        excludeCompanies: effectiveExclusions,
        limit: libraryLimit ?? 100,
      });
      let libraryResults = await lib(parsedQuery);
      if (libraryResults.length === 0) {
        const role = safeParseJson<ParsedRole | null>(job?.parsedRole ?? null, null);
        // Try the AI's alternative searches, then each alternative title alone.
        const fallbacks = [
          ...(role?.search_queries ?? []),
          ...(role?.synonym_titles ?? []).map((t) => `"${t.replace(/"/g, "")}"`),
        ];
        for (const fb of fallbacks) {
          const r = await lib(parseBooleanQuery(fb));
          if (r.length > 0) { libraryResults = r; broadenedTo = fb; break; }
        }
      }
      await attachLibraryResults(run.id, libraryResults);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reportError(err, { route: "search/multi/library", jobId: id, runId: run.id, orgId: auth.orgId });
      await setSourceStatus(run.id, "library", "failed");
      errors.library = msg;
    }
  }

  // ── 3. Enqueue priority=100 scraper search jobs, LINKED to the run, so the
  // box drives them to completion and attaches hits even after the tab closes. ──
  const liveJobs: Array<{ id: string; platform: "linkedin" | "seek" }> = [];
  if (canScrape) {
    if (wantLinkedin) {
      const j = await enqueueSearchJob({
        orgId: runOrgId!,
        platform: "linkedin",
        searchQuery: linkedinKeywords,
        searchLocation: location,
        requestedBy: auth.userId,
        priority: 100,
        searchRunId: run.id,
      });
      if (j) liveJobs.push({ id: j.id, platform: "linkedin" });
      else await setSourceStatus(run.id, "linkedin", "failed");
    }
    if (wantSeek) {
      const j = await enqueueSearchJob({
        orgId: runOrgId!,
        platform: "seek",
        searchQuery: seekKeywords,
        // Scopes the SEEK leg to the recruiter's region (was nation-wide).
        searchLocation: location,
        requestedBy: auth.userId,
        priority: 100,
        searchRunId: run.id,
      });
      if (j) liveJobs.push({ id: j.id, platform: "seek" });
      else await setSourceStatus(run.id, "seek", "failed");
    }
  } else {
    if (wantLinkedin) await setSourceStatus(run.id, "linkedin", "skipped");
    if (wantSeek) await setSourceStatus(run.id, "seek", "skipped");
  }

  // ── 4. Overall status: running while any scraper source is live, else done ──
  const anyScraperLive = liveJobs.length > 0;
  await prisma.searchRun.update({
    where: { id: run.id },
    data: anyScraperLive
      ? { status: "running" }
      : { status: "complete", completedAt: new Date() },
  });

  void recordUsage(auth.orgId, auth.userId, "search", {
    route: "search/multi",
    jobId: id,
    runId: run.id,
    sources,
    liveJobs: liveJobs.length,
    hasErrors: Object.keys(errors).length > 0,
  });

  // Load the just-committed snapshot and map it into the modal's UnifiedResult
  // shape. The same run is now streamable at /api/search/[runId]/stream and
  // re-fetchable at /api/search/[runId] — so a closed/reopened tab resumes it.
  const snapshot = await loadRunSnapshot(run.id);
  const counts = snapshot?.run.counts ?? { library: 0, linkedin: 0, seek: 0, deduped: 0, total: 0 };
  return NextResponse.json({
    runId: run.id,
    status: snapshot?.run.status ?? "queued",
    sourceStatus: snapshot?.run.sourceStatus ?? { library: "skipped", linkedin: "skipped", seek: "skipped" },
    query: {
      raw: parsedQuery.raw,
      mustHave: parsedQuery.mustHave,
      anyOf: parsedQuery.anyOf,
      mustNot: parsedQuery.mustNot,
      hasErrors: parsedQuery.hasErrors,
      errors: parsedQuery.errors,
    },
    results: (snapshot?.results ?? []).map(runResultToUnified),
    counts: {
      // Keep the modal's existing keys; collapse seek into the scraper count.
      libraryRaw: counts.library,
      linkedinRaw: counts.linkedin + counts.seek,
      deduped: counts.deduped,
      total: counts.total,
      fromLibrary: counts.library,
      fromScraper: counts.linkedin + counts.seek,
    },
    liveJobs,
    errors: Object.keys(errors).length > 0 ? errors : undefined,
    // When the precise query found nothing, this is the AI alternative we
    // auto-broadened to (so the UI can say "no exact matches — showing …").
    broadenedTo,
  });
}
