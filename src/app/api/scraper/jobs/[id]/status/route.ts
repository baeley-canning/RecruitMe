/**
 * GET /api/scraper/jobs/[id]/status — poll endpoint for the client UI
 * (Phase H) that tracks a live scraper search.
 *
 * When a recruiter runs a multi-source search, the multi route enqueues
 * a priority=100 ScrapeJob and returns its id alongside the library hits.
 * The UI polls THIS endpoint every ~3s until status flips to "completed"
 * or "failed", then merges the harvested URLs into the result list.
 *
 * Response:
 *   {
 *     id, status: "pending" | "processing" | "completed" | "failed",
 *     platform, kind, searchQuery,
 *     error: string | null,
 *     // For kind="search" completed: list of harvested profile URLs.
 *     // The worker also enqueues each URL as a kind="profile" follow-up
 *     // so the library backfills automatically — the UI just needs the
 *     // raw URLs to render preview cards.
 *     urls: string[] | null,
 *     elapsedMs: number,
 *   }
 *
 * Auth: standard session via getAuth (recruiter must own the org the job
 * was enqueued under). Returns 404 if the job doesn't exist or belongs
 * to a different org — never leaks job existence across tenants.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized } from "@/lib/session";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;

  const job = await prisma.scrapeJob.findUnique({
    where: { id },
    select: {
      id: true,
      orgId: true,
      platform: true,
      kind: true,
      searchQuery: true,
      status: true,
      result: true,
      error: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!job || (!auth.isOwner && job.orgId !== auth.orgId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // For kind=search completed jobs, the worker stores `{ urls: [...] }`
  // in the result column. Parse defensively; a malformed payload should
  // surface as `urls: null` rather than 500.
  let urls: string[] | null = null;
  if (job.kind === "search" && job.status === "completed" && job.result) {
    try {
      const parsed = JSON.parse(job.result) as { urls?: unknown };
      if (Array.isArray(parsed.urls)) urls = parsed.urls.filter((u): u is string => typeof u === "string");
    } catch {/* leave urls null */}
  }

  return NextResponse.json({
    id: job.id,
    status: job.status,
    platform: job.platform,
    kind: job.kind,
    searchQuery: job.searchQuery,
    error: job.error,
    urls,
    elapsedMs: job.updatedAt.getTime() - job.createdAt.getTime(),
  });
}
