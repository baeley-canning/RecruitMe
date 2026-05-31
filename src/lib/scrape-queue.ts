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

export type ScrapePlatform = "linkedin" | "seek" | "jobadder";

export async function enqueueScrapeJob(args: {
  orgId: string;
  platform: ScrapePlatform;
  profileUrl: string;
  candidateId?: string | null;
  requestedBy?: string | null;
}): Promise<{ id: string } | null> {
  try {
    const existing = await prisma.scrapeJob.findFirst({
      where: {
        orgId: args.orgId,
        profileUrl: args.profileUrl,
        status: { in: ["pending", "processing"] },
      },
      select: { id: true },
    });
    if (existing) return null; // already queued or being scraped

    return await prisma.scrapeJob.create({
      data: {
        orgId: args.orgId,
        platform: args.platform,
        kind: "profile",
        profileUrl: args.profileUrl,
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
      select: { id: true, priority: true, searchRunId: true },
    });
    if (existing) {
      // Promote priority + adopt the live run's searchRunId if the existing
      // row had none. Without the searchRunId stamp, a background flywheel
      // job would absorb the live run's enqueue and the run would complete
      // library-only, silently dropping discovery.
      const data: { priority?: number; searchRunId?: string } = {};
      if (priority > existing.priority) data.priority = priority;
      if (args.searchRunId && existing.searchRunId == null) data.searchRunId = args.searchRunId;
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
      },
      select: { id: true },
    });
  } catch (err) {
    reportError(err, { route: "scrape-queue:enqueueSearch", orgId: args.orgId });
    return null;
  }
}

/** The job fields the worker poll needs (mirrors the GET claim's select). */
export interface ClaimedScrapeJob {
  id: string;
  orgId: string;
  platform: string;
  kind: string;
  profileUrl: string | null;
  searchQuery: string | null;
  searchRunId: string | null;
  priority: number;
  retryCount: number;
}

/**
 * Atomically claim pending scrape jobs for the worker poll.
 *
 * The old path did findMany() then a separate updateMany() — NOT atomic: two
 * concurrent pollers could both SELECT the same pending rows and both flip them
 * to "processing", so the same profile got scraped + ingested twice (duplicate
 * results / double-counted). This uses a single `UPDATE … WHERE id IN (SELECT …
 * FOR UPDATE SKIP LOCKED) RETURNING` statement: each candidate row is locked as
 * it's selected and a concurrent poller SKIPs locked rows, so claims across
 * pollers are disjoint.
 *
 * Phase K fairness is preserved with two atomic claims: up to claimLimit-1 by
 * priority, then one reserved slot for the oldest background (priority<100) job
 * so a burst of live searches can't fully starve flywheel discovery. The first
 * claim has already flipped its rows to "processing", so the reserved query's
 * status='pending' filter naturally excludes them — no id bookkeeping needed.
 */
export async function claimScrapeJobs(
  orgId: string | null,
  claimLimit = 5,
): Promise<ClaimedScrapeJob[]> {
  const orgFilter = orgId ? Prisma.sql`AND "orgId" = ${orgId}` : Prisma.empty;
  const priorityLimit = Math.max(1, claimLimit - 1);

  const priorityClaim = await prisma.$queryRaw<ClaimedScrapeJob[]>`
    UPDATE "ScrapeJob" SET status = 'processing', "updatedAt" = now()
    WHERE id IN (
      SELECT id FROM "ScrapeJob"
      WHERE status = 'pending' ${orgFilter}
      ORDER BY priority DESC, "createdAt" ASC
      LIMIT ${priorityLimit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, "orgId", platform, kind, "profileUrl", "searchQuery", "searchRunId", priority, "retryCount"
  `;

  const reserved = await prisma.$queryRaw<ClaimedScrapeJob[]>`
    UPDATE "ScrapeJob" SET status = 'processing', "updatedAt" = now()
    WHERE id IN (
      SELECT id FROM "ScrapeJob"
      WHERE status = 'pending' ${orgFilter} AND priority < 100
      ORDER BY "createdAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, "orgId", platform, kind, "profileUrl", "searchQuery", "searchRunId", priority, "retryCount"
  `;

  return [...priorityClaim, ...reserved];
}
