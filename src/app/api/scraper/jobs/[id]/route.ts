/**
 * PATCH /api/scraper/jobs/[id] — worker posts a completed or failed result.
 *
 * On success (status: "completed"):
 *  1. Validates the result payload
 *  2. Runs scraper ingestion (identity resolution + candidate upsert)
 *  3. Fire-and-forgets insight re-extraction for the resolved identity
 *  4. Updates the ScrapeJob row with final status + candidateId + identityId
 *
 * On failure (status: "failed"):
 *  1. Increments retryCount
 *  2. Requeues as "pending" if retryCount < 3, else marks "failed"
 *
 * Auth: x-scraper-secret header (same as the poll route).
 */

import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { isScraperEnabled } from "@/lib/feature-flags";
import { ingestScraperResult } from "@/lib/scraper-ingestion";
import { reportError } from "@/lib/error-reporting";

const MAX_RETRIES = 3;

function checkScraperSecret(req: Request): boolean {
  const provided = req.headers.get("x-scraper-secret");
  const expected = process.env.SCRAPER_SECRET;
  if (!provided || !expected) return false;
  try {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

const PatchSchema = z.object({
  status: z.enum(["completed", "failed"]),
  result: z
    .object({
      profileText: z.string().max(300_000),
      name: z.string().max(500).optional().nullable(),
      headline: z.string().max(500).optional().nullable(),
      location: z.string().max(500).optional().nullable(),
      linkedinUrl: z.string().max(1000).optional().nullable(),
      seekUrl: z.string().max(1000).optional().nullable(),
    })
    .optional(),
  error: z.string().max(2000).optional().nullable(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isScraperEnabled()) {
    return NextResponse.json({ error: "Scraper not enabled." }, { status: 404 });
  }
  if (!checkScraperSecret(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { id } = await params;

  const job = await prisma.scrapeJob.findUnique({
    where: { id },
    select: { id: true, orgId: true, platform: true, profileUrl: true, retryCount: true, status: true },
  });

  if (!job) {
    return NextResponse.json({ error: "ScrapeJob not found." }, { status: 404 });
  }
  if (job.status === "completed" || job.status === "failed") {
    return NextResponse.json({ message: "Already finalised.", job }, { status: 200 });
  }

  const parsed = PatchSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 });
  }

  const { status, result, error } = parsed.data;

  // --- Failure path ---
  if (status === "failed") {
    const newRetryCount = job.retryCount + 1;
    const finalStatus = newRetryCount >= MAX_RETRIES ? "failed" : "pending";
    await prisma.scrapeJob.update({
      where: { id },
      data: {
        status: finalStatus,
        error: error ?? "Worker reported failure",
        retryCount: newRetryCount,
        updatedAt: new Date(),
      },
    });
    return NextResponse.json({ requeued: finalStatus === "pending", retryCount: newRetryCount });
  }

  // --- Success path ---
  if (!result?.profileText) {
    await prisma.scrapeJob.update({
      where: { id },
      data: { status: "failed", error: "Completed but no profileText returned", updatedAt: new Date() },
    });
    return NextResponse.json({ error: "No profileText in result." }, { status: 422 });
  }

  let ingestResult: Awaited<ReturnType<typeof ingestScraperResult>> | null = null;
  try {
    ingestResult = await ingestScraperResult({
      orgId: job.orgId,
      platform: job.platform as "linkedin" | "seek" | "jobadder",
      profileUrl: job.profileUrl,
      profileText: result.profileText,
      name: result.name,
      headline: result.headline,
      location: result.location,
      linkedinUrl: result.linkedinUrl,
      seekUrl: result.seekUrl,
    });
  } catch (err) {
    reportError(err, { route: "scraper/jobs/[id]", jobId: id, orgId: job.orgId });
    await prisma.scrapeJob.update({
      where: { id },
      data: {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        updatedAt: new Date(),
      },
    });
    return NextResponse.json({ error: "Ingestion failed." }, { status: 500 });
  }

  // Update ScrapeJob with final result.
  await prisma.scrapeJob.update({
    where: { id },
    data: {
      status: "completed",
      result: JSON.stringify(result),
      candidateId: ingestResult.candidateId,
      identityId: ingestResult.identityId,
      updatedAt: new Date(),
    },
  });

  // Fire-and-forget insight re-extraction. Never block the response on this.
  void triggerInsightExtraction(job.orgId, ingestResult.identityId);

  return NextResponse.json({
    candidateId: ingestResult.candidateId,
    identityId: ingestResult.identityId,
    identityAction: ingestResult.identityAction,
    candidateAction: ingestResult.candidateAction,
  });
}

async function triggerInsightExtraction(orgId: string, identityId: string): Promise<void> {
  const baseUrl = process.env.NEXTAUTH_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const secret = process.env.CONTACT_SYNC_CRON_SECRET;
  if (!secret) return;
  try {
    await fetch(`${baseUrl}/api/admin/insights/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-cron-secret": secret },
      body: JSON.stringify({ identityId }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    // Non-fatal — the insight can be extracted on next backfill run.
  }
}
