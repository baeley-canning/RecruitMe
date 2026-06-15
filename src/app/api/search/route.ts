/**
 * POST /api/search — create a durable, org-scoped multi-source search run.
 * GET  /api/search — list the caller's recent runs.
 *
 * POST is fast + durable: it commits the SearchRun row FIRST, then runs the
 * library FTS inline (instant results), then enqueues priority-100 scraper
 * search jobs for LinkedIn/SEEK. All the slow discovery work happens in the
 * worker; the recruiter can navigate away and the run keeps going. There is
 * NO SerpAPI — LinkedIn/SEEK discovery is scraper-only.
 *
 * Auth: getAuth + getAccessibleOrgIds. Owners (orgId null) may pass a target
 * orgId; a library-only owner run (no orgId) spans all orgs but skips the
 * scraper (a scrape job needs a concrete org).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuth, unauthorized } from "@/lib/session";
import { getAccessibleOrgIds } from "@/lib/org-access";
import { checkRateLimit, recordUsage } from "@/lib/usage";
import { parseBooleanQuery } from "@/lib/boolean-query";
import { searchLibrary } from "@/lib/talent-search/library";
import { isScraperDiscoveryEnabled } from "@/lib/feature-flags";
import { enqueueSearchJob } from "@/lib/scrape-queue";
import { linkedinKeywordsFromParsed, seekKeywordsFromParsed } from "@/lib/boolean-query/emit";
import { reportError } from "@/lib/error-reporting";
import {
  createRun,
  attachLibraryResults,
  setSourceStatus,
  loadRunSnapshot,
  type SourceKey,
  type SourceStatus,
} from "@/lib/search-run";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SourceSchema = z.enum(["library", "linkedin", "seek"]);

const BodySchema = z.object({
  query: z.string().max(2000),
  location: z.string().max(200).optional().nullable(),
  sources: z.array(SourceSchema).min(1).default(["library", "linkedin"]), // SEEK opt-in (credits)
  libraryLimit: z.number().int().min(1).max(500).optional(),
  orgId: z.string().optional(), // owners only
});

export async function POST(req: Request) {
  const auth = await getAuth();
  if (!auth) return unauthorized();

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
  const { query, location, sources, libraryLimit, orgId: bodyOrgId } = parsed.data;
  const parsedQuery = parseBooleanQuery(query);

  // ── Org scoping ──
  const accessibleOrgIds = await getAccessibleOrgIds(auth);
  // The org a scraper job is enqueued under (needs a CONCRETE org — ingested
  // profiles attach to it). Resolution: explicit body.orgId (owners only) →
  // the caller's own home org (auth.orgId) → as a last resort the single org
  // on a single-tenant box. This is the fix for "owner searches never scrape":
  // owners have a real home org (e.g. placemeIT), so default to it rather than
  // null, which previously skipped LinkedIn/SEEK entirely.
  let runOrgId = (auth.isOwner ? bodyOrgId : null) ?? auth.orgId ?? null;
  if (runOrgId == null) {
    // Owner with no home org on a box that has exactly one org → use it.
    const orgs = await prisma.org.findMany({ select: { id: true }, take: 2 });
    if (orgs.length === 1) runOrgId = orgs[0].id;
  }
  // Library FTS scope: owners span all accessible orgs (accessibleOrgIds=null),
  // non-owners are pinned to their accessible list. The scraper still uses the
  // concrete runOrgId above.
  const libraryScope = accessibleOrgIds;

  const wantLibrary = sources.includes("library");
  const wantLinkedin = sources.includes("linkedin");
  const wantSeek = sources.includes("seek");
  const scraperOn = isScraperDiscoveryEnabled();
  const queryRaw = parsedQuery.raw.trim();
  // A scraper job needs a concrete orgId — an untargeted owner run can't scrape.
  const canScrape = scraperOn && queryRaw.length > 0 && runOrgId != null;
  // Platform-correct keyword strings for the box (vs. the internal raw boolean).
  const linkedinKeywords = linkedinKeywordsFromParsed(parsedQuery) || queryRaw;
  const seekKeywords = seekKeywordsFromParsed(parsedQuery) || queryRaw;

  // Initial per-source statuses.
  const initial = (want: boolean, isScraper: boolean): SourceStatus => {
    if (!want) return "skipped";
    if (!isScraper) return "running"; // library runs inline next
    return canScrape ? "running" : "skipped";
  };

  // ── 1. Commit the run row FIRST (durable before any slow work) ──
  const run = await createRun({
    orgId: runOrgId,
    requestedBy: auth.userId,
    rawQuery: query,
    parsedQuery,
    location: location ?? null,
    sources,
    libraryStatus: initial(wantLibrary, false),
    linkedinStatus: initial(wantLinkedin, true),
    seekStatus: initial(wantSeek, true),
  });

  // ── 2. Library FTS inline (instant results attach to the run) ──
  if (wantLibrary) {
    try {
      const libraryResults = await searchLibrary({
        parsedQuery,
        accessibleOrgIds: libraryScope,
        location: location ?? null,
        limit: libraryLimit ?? 100,
      });
      await attachLibraryResults(run.id, libraryResults);
    } catch (err) {
      reportError(err, { route: "search:library", runId: run.id, orgId: auth.orgId });
      await setSourceStatus(run.id, "library", "failed");
    }
  }

  // ── 3. Enqueue scraper search jobs (priority 100), linked to the run ──
  const liveJobs: Array<{ id: string; platform: "linkedin" | "seek" }> = [];
  if (canScrape) {
    if (wantLinkedin) {
      const j = await enqueueSearchJob({
        orgId: runOrgId!,
        platform: "linkedin",
        searchQuery: linkedinKeywords,
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
        requestedBy: auth.userId,
        priority: 100,
        searchRunId: run.id,
      });
      if (j) liveJobs.push({ id: j.id, platform: "seek" });
      else await setSourceStatus(run.id, "seek", "failed");
    }
  } else {
    // Scraper unavailable / untargeted owner run — mark requested scraper sources skipped.
    if (wantLinkedin) await setSourceStatus(run.id, "linkedin", "skipped");
    if (wantSeek) await setSourceStatus(run.id, "seek", "skipped");
  }

  // ── 4. Overall status: running if any scraper source live, else complete ──
  const anyScraperLive = liveJobs.length > 0;
  await prisma.searchRun.update({
    where: { id: run.id },
    data: anyScraperLive
      ? { status: "running" }
      : { status: "complete", completedAt: new Date() },
  });

  void recordUsage(auth.orgId, auth.userId, "search", {
    route: "search",
    runId: run.id,
    sources,
    liveJobs: liveJobs.length,
  });

  const snapshot = await loadRunSnapshot(run.id);
  return NextResponse.json({
    runId: run.id,
    status: snapshot?.run.status ?? "queued",
    query: {
      raw: parsedQuery.raw,
      mustHave: parsedQuery.mustHave,
      anyOf: parsedQuery.anyOf,
      mustNot: parsedQuery.mustNot,
      hasErrors: parsedQuery.hasErrors,
      errors: parsedQuery.errors,
    },
    results: snapshot?.results ?? [],
    counts: snapshot?.run.counts ?? { library: 0, linkedin: 0, seek: 0, deduped: 0, total: 0 },
    sourceStatus: snapshot?.run.sourceStatus ?? { library: "skipped", linkedin: "skipped", seek: "skipped" },
    liveJobs,
  });
}

export async function GET(req: Request) {
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 50);
  const accessibleOrgIds = await getAccessibleOrgIds(auth);

  const where = accessibleOrgIds === null ? {} : { orgId: { in: accessibleOrgIds } };
  const runs = await prisma.searchRun.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return NextResponse.json({
    runs: runs.map((r) => ({
      id: r.id,
      rawQuery: r.rawQuery,
      location: r.location,
      sources: safeArr(r.sources),
      status: r.status,
      sourceStatus: { library: r.libraryStatus, linkedin: r.linkedinStatus, seek: r.seekStatus },
      counts: {
        total: r.totalCount,
        library: r.libraryCount,
        linkedin: r.linkedinCount,
        seek: r.seekCount,
        deduped: r.dedupedCount,
      },
      createdAt: r.createdAt.toISOString(),
      completedAt: r.completedAt?.toISOString() ?? null,
    })),
  });
}

function safeArr(json: string): SourceKey[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as SourceKey[]) : [];
  } catch {
    return [];
  }
}
