/**
 * Scrape queue — Railway side of the mobile scraper system.
 *
 * ── ARCHITECTURE OVERVIEW (for AI handoff) ────────────────────────────────────
 * This file manages the ScrapeJob table. Scrape jobs are created here on the
 * Railway server and consumed by a standalone scraper-worker process that runs
 * on a Raspberry Pi (4G carrier IP) or Fly.io (residential proxy).
 *
 * FLOW:
 *   1. Railway creates a ScrapeJob row via enqueueScrapeJob()
 *   2. scraper-worker polls GET /api/scraper/jobs → calls claimPendingJobs()
 *   3. Worker scrapes the target (LinkedIn, SEEK, JobAdder)
 *   4. Worker PATCHes /api/scraper/jobs/[id] → calls completeScrapeJob() or failScrapeJob()
 *   5. For "profile" jobs: the result's profileText is written to the Candidate row,
 *      triggering the existing AI scoring pipeline (same path as extension imports)
 *
 * GATING: enqueueScrapeJob() is a no-op unless SCRAPER_ENABLED=true is set in
 * Railway env vars. Set this once your Pi is running and polling.
 *
 * RELATED FILES:
 *   src/app/api/scraper/jobs/route.ts      — GET (claim) + POST (create via API)
 *   src/app/api/scraper/jobs/[id]/route.ts — PATCH (result submission)
 *   src/app/api/jobs/[id]/search/route.ts  — calls enqueueScrapeJob for snippet-only results
 *   scraper-worker/src/index.ts            — the worker that polls this queue
 *   prisma/schema.prisma                   — ScrapeJob model
 */

import { prisma } from "./db";
import { reportError } from "./error-reporting";

export type ScrapeJobPlatform = "linkedin" | "seek" | "jobadder";
export type ScrapeJobType = "profile" | "search";
export type ScrapeJobStatus = "pending" | "processing" | "done" | "error";

export interface ScrapeJobInput {
  url?:      string;   // LinkedIn profile URL or SEEK candidate URL
  query?:    string;   // search query string
  location?: string;   // target location
  count?:    number;   // max results for search jobs
  jobId?:    string;   // RecruitMe job ID — used to link profile result back
  candidateId?: string; // existing Candidate ID to update on completion
}

export interface ScrapeJobResult {
  profileText?: string;
  name?:        string;
  headline?:    string;
  location?:    string;
  candidates?:  Array<{ url: string; name: string; headline: string; location?: string }>;
  rawHtml?:     string; // optional, stripped before storage
}

/** Create a scrape job. No-op if SCRAPER_ENABLED is not "true". */
export async function enqueueScrapeJob(
  orgId: string,
  platform: ScrapeJobPlatform,
  jobType: ScrapeJobType,
  input: ScrapeJobInput,
  priority = 0,
): Promise<string | null> {
  if (process.env.SCRAPER_ENABLED !== "true") return null;
  try {
    const job = await prisma.scrapeJob.create({
      data: { orgId, platform, jobType, input: JSON.stringify(input), priority },
    });
    return job.id;
  } catch (err) {
    reportError(err, { context: "enqueueScrapeJob", orgId, platform, jobType });
    return null;
  }
}

/**
 * Atomically claim up to `limit` pending jobs for a worker.
 * Returns the claimed jobs (status already set to "processing").
 * Uses a two-phase approach: findMany + updateMany with status check to avoid
 * race conditions (multiple workers claiming the same job).
 */
export async function claimPendingJobs(
  orgId: string,
  workerId: string,
  limit = 5,
): Promise<Array<{
  id: string;
  platform: string;
  jobType: string;
  input: ScrapeJobInput;
  retryCount: number;
}>> {
  // Find candidates in a single read
  const candidates = await prisma.scrapeJob.findMany({
    where: { orgId, status: "pending" },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
    take: limit,
    select: { id: true, platform: true, jobType: true, input: true, retryCount: true },
  });

  if (candidates.length === 0) return [];

  // Update only those that are still "pending" (guards against concurrent workers)
  const ids = candidates.map((c) => c.id);
  await prisma.scrapeJob.updateMany({
    where: { id: { in: ids }, status: "pending" },
    data: { status: "processing", workerId },
  });

  // Re-fetch to confirm which ones we actually claimed
  const claimed = await prisma.scrapeJob.findMany({
    where: { id: { in: ids }, status: "processing", workerId },
    select: { id: true, platform: true, jobType: true, input: true, retryCount: true },
  });

  return claimed.map((j) => ({
    ...j,
    input: JSON.parse(j.input) as ScrapeJobInput,
  }));
}

/** Mark a job complete and write the result. */
export async function completeScrapeJob(id: string, result: ScrapeJobResult): Promise<void> {
  await prisma.scrapeJob.update({
    where: { id },
    data: {
      status: "done",
      result: JSON.stringify(result),
      completedAt: new Date(),
    },
  });

  // If this is a profile job with a linked candidate, update the candidate's profileText.
  // The existing scoring pipeline (same as extension import) will re-score it.
  const job = await prisma.scrapeJob.findUnique({
    where: { id },
    select: { input: true, orgId: true },
  });
  if (!job) return;

  const input = JSON.parse(job.input) as ScrapeJobInput;
  if (input.candidateId && result.profileText) {
    await applyProfileResult(input.candidateId, result, job.orgId);
  }
}

/** Requeue or permanently fail a job. Jobs with retryCount >= 3 are marked error. */
export async function failScrapeJob(id: string, error: string): Promise<void> {
  const job = await prisma.scrapeJob.findUnique({ where: { id }, select: { retryCount: true } });
  if (!job) return;

  if (job.retryCount >= 2) {
    // Third failure → permanent error
    await prisma.scrapeJob.update({
      where: { id },
      data: { status: "error", error, completedAt: new Date() },
    });
  } else {
    // Requeue with incremented retry count
    await prisma.scrapeJob.update({
      where: { id },
      data: { status: "pending", error, retryCount: { increment: 1 } },
    });
  }
}

/**
 * Apply a completed profile scrape result to an existing Candidate row.
 * Uses saveCapturedProfileFast + applyAiEnrichmentInBackground — the same
 * two-phase pipeline as the browser extension (see linkedin-capture.ts:643).
 *
 * Requires the ScrapeJob input to have both candidateId AND jobId so we can
 * use the existing pipeline without modification.
 */
async function applyProfileResult(
  candidateId: string,
  result: ScrapeJobResult,
  orgId: string,
): Promise<void> {
  if (!result.profileText) return;

  try {
    // Re-read the job input to get jobId (stored at enqueue time)
    const scrapeJobRow = await prisma.scrapeJob.findFirst({
      where: { input: { contains: candidateId } },
      orderBy: { createdAt: "desc" },
      select: { input: true },
    });
    const input: ScrapeJobInput = scrapeJobRow ? JSON.parse(scrapeJobRow.input) : {};

    const candidate = await prisma.candidate.findUnique({
      where: { id: candidateId },
      select: { jobId: true, linkedinUrl: true },
    });
    if (!candidate) return;

    const jobId = input.jobId ?? candidate.jobId;
    if (!jobId) {
      // Fallback: direct update without full pipeline
      await prisma.candidate.update({
        where: { id: candidateId },
        data: {
          profileText:       result.profileText,
          name:              result.name ?? undefined,
          headline:          result.headline ?? undefined,
          location:          result.location ?? undefined,
          profileCapturedAt: new Date(),
          profileTextHash:   null,
          source:            "scraper" as string,
        },
      });
      return;
    }

    // Full pipeline: phase 1 (save + identity) → phase 2 (AI score, fire-and-forget)
    const { saveCapturedProfileFast, applyAiEnrichmentInBackground } = await import("./linkedin-capture");
    const { identity } = await saveCapturedProfileFast({
      jobId,
      candidateId,
      profileText: result.profileText,
      linkedinUrl: candidate.linkedinUrl ?? input.url ?? "",
    });

    applyAiEnrichmentInBackground(candidateId, identity).catch((err) =>
      reportError(err, { context: "applyProfileResult:scoring", candidateId }),
    );
  } catch (err) {
    reportError(err, { context: "applyProfileResult", candidateId });
  }
}

/** List recent scrape jobs for an org (for admin/debug UI). */
export async function listScrapeJobs(
  orgId: string,
  options: { status?: ScrapeJobStatus; limit?: number } = {},
) {
  return prisma.scrapeJob.findMany({
    where: { orgId, ...(options.status ? { status: options.status } : {}) },
    orderBy: { createdAt: "desc" },
    take: options.limit ?? 50,
    select: {
      id: true,
      platform: true,
      jobType: true,
      status: true,
      error: true,
      workerId: true,
      priority: true,
      retryCount: true,
      createdAt: true,
      completedAt: true,
    },
  });
}
