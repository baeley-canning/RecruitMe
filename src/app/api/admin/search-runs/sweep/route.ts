/**
 * POST /api/admin/search-runs/sweep — safety-net for durable search runs.
 *
 * Reclaims zombie "processing" ScrapeJobs (dead/restarted worker), re-drives
 * runs abandoned mid-POST, and settles runs whose children have all finished.
 * Without this, a worker crash mid-run would leave a SearchRun stuck
 * "running" forever (a child counted as in-flight that never completes).
 *
 * Auth: x-scraper-secret (the worker drives this every ~8 poll cycles) OR
 * x-cron-secret (wireable to a systemd timer later). Timing-safe compare.
 */

import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { sweepStuckRuns } from "@/lib/search-run";

function timingSafe(provided: string | null, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  const scraperOk = timingSafe(req.headers.get("x-scraper-secret"), process.env.SCRAPER_SECRET);
  const cronOk = timingSafe(req.headers.get("x-cron-secret"), process.env.CONTACT_SYNC_CRON_SECRET);
  if (!scraperOk && !cronOk) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await sweepStuckRuns();
  return NextResponse.json(result);
}
