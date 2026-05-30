/**
 * POST /api/admin/jobadder/scrape
 *
 * Owner-only trigger that enqueues a full JobAdder library walk. The worker
 * picks up the kind="search" platform="jobadder" job, walks every page of
 * the candidate list, harvests every profile URL, then enqueues each as a
 * separate kind="profile" job (the worker processes them human-paced via
 * SCRAPER_JOBADDER_DELAY_MIN/MAX_MS, bounded by SCRAPER_JOBADDER_DAILY_CAP).
 *
 * The walk is dedup'd by enqueueSearchJob against any in-flight walk for
 * the same org — re-clicking the button while one is running is a no-op.
 *
 * Gates: scraper enabled + owner role + auth.orgId present.
 */

import { NextResponse } from "next/server";
import { getAuth, unauthorized } from "@/lib/session";
import { isScraperEnabled } from "@/lib/feature-flags";
import { enqueueSearchJob } from "@/lib/scrape-queue";

// Sentinel value stored in ScrapeJob.searchQuery for JobAdder library walks.
// The worker's jobadder branch doesn't actually use the query (the scraper
// always walks the whole list) — this string just makes the row identifiable
// in logs / SQL queries.
const JOBADDER_WALK_SENTINEL = "__JOBADDER_FULL_LIBRARY_WALK__";

export async function POST() {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  if (!auth.isOwner) {
    return NextResponse.json({ error: "Owner only." }, { status: 403 });
  }
  if (!isScraperEnabled()) {
    return NextResponse.json({ error: "Scraper not enabled." }, { status: 404 });
  }
  if (!auth.orgId) {
    return NextResponse.json({ error: "No orgId on session." }, { status: 400 });
  }

  const job = await enqueueSearchJob({
    orgId: auth.orgId,
    platform: "jobadder",
    searchQuery: JOBADDER_WALK_SENTINEL,
    requestedBy: auth.userId,
  });

  if (!job) {
    return NextResponse.json({
      ok: true,
      enqueued: false,
      reason: "A JobAdder library walk is already in-flight for this org.",
    });
  }

  return NextResponse.json({
    ok: true,
    enqueued: true,
    jobId: job.id,
    note: "Worker will pick up the walk on its next poll cycle (~15s). Watch progress with `journalctl -u recruitme-scraper -f` on the mini-PC.",
  });
}
