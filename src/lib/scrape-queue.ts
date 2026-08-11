/**
 * Auto-enqueue helper for the external scraper worker.
 *
 * When a search surfaces a snippet-only LinkedIn candidate (headline +
 * snippet, no full profileText), we drop a ScrapeJob row so the worker
 * fetches the full profile on its own carrier IP. ingestScraperResult
 * later links the result back to the candidate by normalised linkedinUrl,
 * so the snippet row gets enriched in place — no jobId/candidateId
 * threading required (though we store candidateId for the audit trail).
 *
 * Matches the CURRENT ScrapeJob model (profileUrl-based). The richer
 * jobType/input/workerId design from the review-deployment branch was
 * intentionally NOT adopted — the deployed worker + routes standardised
 * on profileUrl, and ingestion's URL-match makes the extra context moot.
 *
 * Deduped against any in-flight job for the same (orgId, profileUrl) so a
 * busy team of recruiters all searching the same person enqueues once.
 * Never throws — callers fire-and-forget from the search hot path.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { reportError } from "./error-reporting";
import { applyPlatformBudget, parsePlatformBudgets } from "./platform-budget";
import { cleanProfileUrl, platformForUrl } from "./profile-url";

export type ScrapePlatform = "linkedin" | "seek" | "jobadder";

export async function enqueueScrapeJob(args: {
  orgId: string;
  platform: ScrapePlatform;
  profileUrl: string;
  candidateId?: string | null;
  requestedBy?: string | null;
}): Promise<{ id: string } | null> {
  try {
    // Never store a row whose platform disagrees with its URL. A merge-key
    // string ("seek:https://…") that leaked into the linkedinUrl column once
    // filed 100 SEEK profiles as LinkedIn work — they failed in ~4s each,
    // spinning the worker loop ~6x too fast and getting the account flagged.
    // Cleaning here also keeps the per-platform daily budget honest, since it
    // counts what the queue claims each platform is doing.
    const profileUrl = cleanProfileUrl(args.profileUrl);
    if (!profileUrl) {
      reportError(new Error(`Refusing to enqueue an unusable profile URL: ${args.profileUrl}`), {
        route: "scrape-queue:enqueue",
        orgId: args.orgId,
      });
      return null;
    }
    const platform = platformForUrl(profileUrl, args.platform) ?? args.platform;

    const existing = await prisma.scrapeJob.findFirst({
      where: {
        orgId: args.orgId,
        profileUrl,
        status: { in: ["pending", "processing"] },
      },
      select: { id: true },
    });
    if (existing) return null; // already queued or being scraped

    return await prisma.scrapeJob.create({
      data: {
        orgId: args.orgId,
        platform,
        kind: "profile",
        profileUrl,
        candidateId: args.candidateId ?? null,
        requestedBy: args.requestedBy ?? null,
        status: "pending",
      },
      select: { id: true },
    });
  } catch (err) {
    reportError(err, { route: "scrape-queue:enqueue", orgId: args.orgId });
    return null;
  }
}

/**
 * Phase B (scraper-side discovery): enqueue a SEARCH job. The worker will run
 * the boolean query against LinkedIn search itself, harvest result profile
 * URLs, and POST each back as a regular kind="profile" ScrapeJob — those then
 * flow through ingestion into the local Candidate library, feeding the Phase A
 * + C DB-first search the next time the same query is run.
 *
 * Deduped against any in-flight search for the same (orgId, platform, query)
 * so a flurry of recruiter searches on the same query enqueues once.
 * Fire-and-forget; never throws.
 */
export async function enqueueSearchJob(args: {
  orgId: string;
  platform: ScrapePlatform;
  searchQuery: string;
  requestedBy?: string | null;
  /** Phase H — priority for worker poll ordering. 0 = background discovery
   *  (flywheel), 100 = live recruiter search (jumps the queue). When an
   *  existing dedup hit is found at a LOWER priority, the existing row is
   *  promoted in place so live searches don't get stuck behind background
   *  ones. Defaults to 0 (existing flywheel callers untouched). */
  priority?: number;
  /** Phase K — links this search job to a durable SearchRun so its
   *  harvested results attach to the run. When a dedup hit is found whose
   *  searchRunId is null, we stamp it so the live run still owns the work. */
  searchRunId?: string | null;
  /** Region filter (e.g. "Wellington") for the worker to scope SEEK. Carried
   *  on the job for flows WITHOUT a SearchRun (the job-context modal); SearchRun
   *  flows enrich location from the run at claim time instead. Without this the
   *  modal's SEEK search ran nation-wide and hit its 100-card harvest cap. */
  searchLocation?: string | null;
}): Promise<{ id: string } | null> {
  const priority = args.priority ?? 0;
  try {
    const existing = await prisma.scrapeJob.findFirst({
      where: {
        orgId: args.orgId,
        platform: args.platform,
        kind: "search",
        searchQuery: args.searchQuery,
        status: { in: ["pending", "processing"] },
      },
      select: { id: true, priority: true, searchRunId: true, searchLocation: true },
    });
    if (existing) {
      // Promote priority + adopt the live run's searchRunId if the existing
      // row had none. Without the searchRunId stamp, a background flywheel
      // job would absorb the live run's enqueue and the run would complete
      // library-only, silently dropping discovery.
      const data: { priority?: number; searchRunId?: string; searchLocation?: string } = {};
      if (priority > existing.priority) data.priority = priority;
      if (args.searchRunId && existing.searchRunId == null) data.searchRunId = args.searchRunId;
      // Stamp the location onto a location-less existing job (e.g. a background
      // job being promoted to a located live search) so it scopes correctly.
      if (args.searchLocation && existing.searchLocation == null) data.searchLocation = args.searchLocation;
      if (Object.keys(data).length > 0) {
        await prisma.scrapeJob.update({ where: { id: existing.id }, data });
      }
      return { id: existing.id };
    }

    return await prisma.scrapeJob.create({
      data: {
        orgId: args.orgId,
        platform: args.platform,
        kind: "search",
        searchQuery: args.searchQuery,
        profileUrl: null,
        requestedBy: args.requestedBy ?? null,
        status: "pending",
        priority,
        searchRunId: args.searchRunId ?? null,
        searchLocation: args.searchLocation ?? null,
      },
      select: { id: true },
    });
  } catch (err) {
    reportError(err, { route: "scrape-queue:enqueueSearch", orgId: args.orgId });
    return null;
  }
}

// NOTE: the Llama score-offload path (enqueueScoreJob + ScoreJobPayload +
// kind="score" jobs) was removed 2026-07-04. The GPU-less box couldn't run real
// scoring, and deterministic Fit scoring is the default now, so there is no
// local-model fallback to enqueue. The ScrapeJob.scorePayload column + "score"
// kind value are left in the schema (inert, nothing writes them) to avoid a
// migration; failStaleScoreJobs was dropped from the sweep alongside this.

/** The job fields the worker poll needs (mirrors the GET claim's select). */
export interface ClaimedScrapeJob {
  id: string;
  orgId: string;
  platform: string;
  kind: string;
  profileUrl: string | null;
  searchQuery: string | null;
  searchLocation: string | null;
  searchRunId: string | null;
  priority: number;
  retryCount: number;
  // Legacy score-offload fields. No active writer creates kind="score" jobs
  // anymore; these stay nullable so old rows/schema shape remain readable.
  scorePayload: string | null;
  candidateId: string | null;
}

/**
 * Atomically claim pending scrape jobs for the worker poll.
 *
 * The old path did findMany() then a separate updateMany() — NOT atomic: two
 * concurrent pollers could both SELECT the same pending rows and both flip them
 * to "processing", so the same profile got scraped + ingested twice (duplicate
 * results / double-counted). Each claim here is an `UPDATE … WHERE id IN (SELECT
 * … FOR UPDATE SKIP LOCKED) RETURNING` statement: each candidate row is locked
 * as it's selected and a concurrent poller SKIPs locked rows, so claims across
 * pollers are disjoint.
 *
 * Phase K fairness uses TWO such claims — up to claimLimit-1 by priority, then
 * one reserved slot for the oldest background (priority<100) job so a burst of
 * live searches can't fully starve flywheel discovery. Both run inside ONE
 * interactive `prisma.$transaction`, so the pair is a single claim operation:
 * if the reserved claim throws after the priority claim has flipped its rows to
 * "processing", the whole transaction rolls back rather than stranding those
 * rows as "processing" without ever returning them to the caller. The reserved
 * query sees the priority claim's flip within the same transaction, so its
 * status='pending' filter excludes the just-claimed rows — no id bookkeeping.
 */
export async function claimScrapeJobs(
  orgId: string | null,
  claimLimit = 5,
): Promise<ClaimedScrapeJob[]> {
  const orgFilter = orgId ? Prisma.sql`AND "orgId" = ${orgId}` : Prisma.empty;
  const priorityLimit = Math.max(1, claimLimit - 1);

  return await prisma.$transaction(async (tx) => {
    const priorityClaim = await tx.$queryRaw<ClaimedScrapeJob[]>`
      UPDATE "ScrapeJob" SET status = 'processing', "updatedAt" = now()
      WHERE id IN (
        SELECT id FROM "ScrapeJob"
        WHERE status = 'pending' ${orgFilter}
        ORDER BY priority DESC, "createdAt" ASC
        LIMIT ${priorityLimit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, "orgId", platform, kind, "profileUrl", "searchQuery", "searchLocation", "searchRunId", priority, "retryCount", "scorePayload", "candidateId"
    `;

    const reserved = await tx.$queryRaw<ClaimedScrapeJob[]>`
      UPDATE "ScrapeJob" SET status = 'processing', "updatedAt" = now()
      WHERE id IN (
        SELECT id FROM "ScrapeJob"
        WHERE status = 'pending' ${orgFilter} AND priority < 100
        ORDER BY "createdAt" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, "orgId", platform, kind, "profileUrl", "searchQuery", "searchLocation", "searchRunId", priority, "retryCount", "scorePayload", "candidateId"
    `;

    const claimed = [...priorityClaim, ...reserved];

    // Daily ceiling per platform, enforced HERE because it is the one point the
    // worker cannot route around: it can only act on what this returns. Today a
    // routing bug made jobs fail in ~4s and the loop ran six times faster than
    // intended (LinkedIn flagged the account), and a separate bug retried an MFA
    // wall 33 times. Both were stopped by a human reading logs, which is not a
    // control. Unbudgeted platforms are unlimited, so this changes nothing until
    // a budget is set; a budget of 0 is a real stop.
    const budgets = parsePlatformBudgets(process.env.SCRAPE_DAILY_BUDGETS);
    if (Object.keys(budgets).length === 0 || claimed.length === 0) return claimed;

    const since = new Date();
    since.setHours(0, 0, 0, 0);
    const usedRows = await tx.scrapeJob.groupBy({
      by: ["platform"],
      where: { updatedAt: { gte: since }, status: { in: ["processing", "completed", "failed"] } },
      _count: { _all: true },
    });
    const usedToday: Record<string, number> = {};
    for (const row of usedRows) usedToday[row.platform] = row._count._all;

    const { allowed, deferred, cappedPlatforms } = applyPlatformBudget(claimed, usedToday, budgets);

    if (deferred.length > 0) {
      // Put the held-back jobs straight back to pending — they were flipped to
      // "processing" by the UPDATE above and would otherwise be stranded.
      await tx.scrapeJob.updateMany({
        where: { id: { in: deferred.map((j) => j.id) } },
        data: { status: "pending", updatedAt: new Date() },
      });
      console.warn(
        `[scrape-queue] daily budget reached for ${cappedPlatforms.join(", ")} — ` +
        `deferred ${deferred.length} job(s); used today: ${JSON.stringify(usedToday)}`,
      );
    }
    return allowed;
  });
}
