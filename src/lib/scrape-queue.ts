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
