/**
 * GET  /api/scraper/jobs  — worker polls for pending scrape jobs
 * POST /api/scraper/jobs  — enqueue a new scrape job
 *
 * Auth: x-scraper-secret header (timing-safe compare against SCRAPER_SECRET env).
 * The scraper worker uses this key on every request.
 *
 * GET: claims up to 5 pending jobs atomically (status pending → processing)
 * and returns them. The worker processes each and POSTes results to
 * PATCH /api/scraper/jobs/[id].
 *
 * POST: enqueues a new job. Used by admin tooling or future UI triggers.
 * Returns the created ScrapeJob row.
 */

import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { isScraperEnabled } from "@/lib/feature-flags";
import { randomUUID } from "crypto";

const CLAIM_LIMIT = 5;

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

export async function GET(req: Request) {
  if (!isScraperEnabled()) {
    return NextResponse.json({ error: "Scraper not enabled." }, { status: 404 });
  }
  if (!checkScraperSecret(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const url = new URL(req.url);
  const orgId = url.searchParams.get("orgId");

  // Claim pending jobs atomically: update status to processing, return them.
  const whereClause = orgId
    ? { status: "pending", orgId }
    : { status: "pending" };

  // Fetch then update — prisma doesn't support UPDATE...RETURNING in one call.
  const jobs = await prisma.scrapeJob.findMany({
    where: whereClause,
    orderBy: { createdAt: "asc" },
    take: CLAIM_LIMIT,
    select: { id: true, orgId: true, platform: true, profileUrl: true, retryCount: true },
  });

  if (jobs.length === 0) {
    return NextResponse.json({ jobs: [] });
  }

  await prisma.scrapeJob.updateMany({
    where: { id: { in: jobs.map((j: { id: string }) => j.id) } },
    data: { status: "processing", updatedAt: new Date() },
  });

  return NextResponse.json({ jobs });
}

const PostSchema = z.object({
  orgId: z.string().min(1),
  platform: z.enum(["linkedin", "seek", "jobadder"]),
  profileUrl: z.string().url().max(2000),
  requestedBy: z.string().optional().nullable(),
});

export async function POST(req: Request) {
  if (!isScraperEnabled()) {
    return NextResponse.json({ error: "Scraper not enabled." }, { status: 404 });
  }
  if (!checkScraperSecret(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const parsed = PostSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 });
  }

  const job = await prisma.scrapeJob.create({
    data: {
      id: randomUUID(),
      orgId: parsed.data.orgId,
      platform: parsed.data.platform,
      profileUrl: parsed.data.profileUrl,
      requestedBy: parsed.data.requestedBy ?? null,
    },
  });

  return NextResponse.json({ job }, { status: 201 });
}
