/**
 * POST /api/watches/run-due — scheduler sweep for Profile-Update Alerts (Stage E).
 *
 * Selects every ACTIVE WatchedSearch whose nextRunAfter is due (<= now) and
 * enqueues one check per watch (a SEEK-only SearchRun + a priority-50 SEEK
 * search job, tagged requestedBy="watch:<id>"), up to an app-side daily cap so
 * watches can't starve background discovery / live recruiter search.
 *
 * This route holds the scheduler LOGIC only. The TRIGGER (a Railway scheduled
 * job or a box systemd timer hitting this with x-cron-secret) is deferred to the
 * owner — nothing here creates a cron. It also ships DARK: gated on BOTH
 * isProfileWatchSchedulerEnabled() AND isProfileWatchEnabled(), so it 404s
 * unless both flags are flipped on.
 *
 * Auth: x-cron-secret, timing-safe compare against CONTACT_SYNC_CRON_SECRET —
 * copied verbatim from src/app/api/admin/search-runs/sweep/route.ts so the two
 * cron entrypoints share one auth shape. (sweep also accepts x-scraper-secret
 * because the worker drives it; run-due is cron-only, so only the cron path.)
 *
 * Cap: WATCH_DAILY_CAP (env, default 40). Counted by tallying TODAY's
 * SearchRuns whose requestedBy starts with "watch:". The day boundary is
 * computed in JS (start-of-day as a Date) and handed to Prisma's query builder
 * (parameterised, NOT $queryRaw) — we never bind a Date into raw SQL (the box
 * tz-trap). Remaining budget = max(0, cap - already-run-today); we enqueue at
 * most that many due watches and skip the rest (they stay due for the next
 * sweep).
 */

import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { prisma } from "@/lib/db";
import { isProfileWatchEnabled, isProfileWatchSchedulerEnabled } from "@/lib/feature-flags";
import { enqueueWatchCheck } from "@/lib/watched-search";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_WATCH_DAILY_CAP = 40;

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

function notFound() {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

/** Resolve WATCH_DAILY_CAP from env; fall back to the default on absent/invalid. */
function watchDailyCap(): number {
  const raw = process.env.WATCH_DAILY_CAP;
  if (!raw) return DEFAULT_WATCH_DAILY_CAP;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_WATCH_DAILY_CAP;
}

export async function POST(req: Request) {
  // Ships dark: both flags must be on, else the route doesn't exist.
  if (!isProfileWatchSchedulerEnabled() || !isProfileWatchEnabled()) return notFound();

  // Cron-secret only (timing-safe), matching the sweep route's cron path.
  const cronOk = timingSafe(req.headers.get("x-cron-secret"), process.env.CONTACT_SYNC_CRON_SECRET);
  if (!cronOk) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();

  // App-side daily cap. Count today's watch-tagged runs (requestedBy "watch:%").
  // Day boundary computed in JS → Date handed to the Prisma query builder
  // (parameterised), never bound into $queryRaw (the box tz-trap).
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const ranToday = await prisma.searchRun.count({
    where: {
      requestedBy: { startsWith: "watch:" },
      createdAt: { gte: startOfDay },
    },
  });
  const cap = watchDailyCap();
  const remaining = Math.max(0, cap - ranToday);

  if (remaining === 0) {
    return NextResponse.json({
      ok: true,
      now: now.toISOString(),
      cap,
      ranToday,
      remaining: 0,
      due: 0,
      enqueued: 0,
      skippedForCap: 0,
      runs: [],
    });
  }

  // Due = active AND nextRunAfter <= now. Oldest-due first so a starved watch
  // (under a tight cap) eventually gets its turn rather than always losing to a
  // freshly-due one. Bounded fetch — we only need up to `remaining`, plus a
  // little headroom to report how many we had to skip.
  const dueWatches = await prisma.watchedSearch.findMany({
    where: {
      active: true,
      nextRunAfter: { lte: now },
    },
    orderBy: { nextRunAfter: "asc" },
    take: remaining + 50,
    select: {
      id: true,
      orgId: true,
      jobId: true,
      query: true,
      location: true,
      intervalMinutes: true,
    },
  });

  const dueCount = dueWatches.length;
  const toRun = dueWatches.slice(0, remaining);
  const skippedForCap = Math.max(0, dueCount - toRun.length);

  const runs: Array<{ watchId: string; runId: string; jobId: string | null }> = [];
  for (const w of toRun) {
    // enqueueWatchCheck stamps lastRunId / lastRunAt / nextRunAfter (= now +
    // intervalMinutes) on the watch, so the next sweep sees it as not-yet-due.
    const { runId, jobId } = await enqueueWatchCheck({
      id: w.id,
      orgId: w.orgId,
      jobId: w.jobId,
      query: w.query,
      location: w.location,
      intervalMinutes: w.intervalMinutes,
    });
    runs.push({ watchId: w.id, runId, jobId });
  }

  return NextResponse.json({
    ok: true,
    now: now.toISOString(),
    cap,
    ranToday,
    remaining,
    due: dueCount,
    enqueued: runs.length,
    skippedForCap,
    runs,
  });
}
