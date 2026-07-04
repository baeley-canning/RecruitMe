/**
 * Profile-Update Alerts — app pipeline (Stage C).
 *
 * A "watch" is a recruiter-defined SEEK Talent-Search query that the system
 * re-runs on an interval to spot candidates who recently updated their SEEK
 * profile. The architecture deliberately REUSES the durable search lifecycle:
 *
 *   enqueueWatchCheck(watch)
 *     → createRun({ sources: ["seek"], requestedBy: "watch:<id>" })   (search-run.ts)
 *     → enqueueSearchJob({ platform: "seek", priority: 50, searchRunId })  (scrape-queue.ts)
 *
 * The worker harvests the SEEK result cards back onto the run as
 * SearchRunResult rows (attachScraperHits stores each card's "Updated X ago"
 * recency label verbatim). detectHits then reads those rows, parses the
 * recency label into a bucketed Date (parseUpdatedAgo), JS-thresholds the
 * bucket against the watch's notifyFrom (NEVER a $queryRaw Date bind — known
 * box tz-trap), and upserts a ProfileUpdateHit per new (watch, profile,
 * bucket) via a raw ON CONFLICT DO NOTHING. The unique key dedupes so the same
 * profile at the same bucketed update-time is flagged once per watch.
 *
 * Everything is org-scoped: both models carry a non-null orgId and every query
 * filters by it. Nothing here flips a flag or runs a migration — the routes
 * that call these helpers gate on isProfileWatchEnabled() (404 when off).
 */

import { randomUUID } from "node:crypto";
import { prisma } from "./db";
import { parseBooleanQuery } from "./boolean-query";
import { seekKeywordsFromParsed } from "./boolean-query/emit";
import { normaliseSeekUrl } from "./seek";
import { parseUpdatedAgo, startOfUtcDay } from "./seek-updated-ago";
import { createRun } from "./search-run";
import { enqueueSearchJob } from "./scrape-queue";

// Interval clamp [30, 1440] minutes (issue I9). Below the floor is rejected at
// the route layer (422); here we clamp defensively so a direct caller can't
// schedule a sub-floor (ban-cadence) check.
export const MIN_INTERVAL_MINUTES = 30;
export const MAX_INTERVAL_MINUTES = 1440;

function clampInterval(minutes: number): number {
  if (!Number.isFinite(minutes)) return MAX_INTERVAL_MINUTES;
  return Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, Math.round(minutes)));
}

export interface WatchedSearchDTO {
  id: string;
  orgId: string;
  jobId: string | null;
  createdBy: string | null;
  /** Resolved username of the creator (null if unknown/system). Surfaced as
   *  "by <user>" in the Pulse watch list. */
  createdByName: string | null;
  name: string;
  query: string;
  location: string | null;
  notifyFrom: string;
  intervalMinutes: number;
  active: boolean;
  lastRunAt: string | null;
  nextRunAfter: string | null;
  lastRunId: string | null;
  // Health (reconciled from the last settled check).
  lastCheckAt: string | null;
  lastCheckStatus: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  lastHitAt: string | null;
  /** Derived rollup for the UI badge — see deriveWatchHealth(). */
  health: WatchHealth;
  createdAt: string;
  updatedAt: string;
}

export type WatchHealth = "ok" | "pending" | "stale" | "failing";

// A watch is "failing" after 3 consecutive failed checks (persistent SEEK
// re-auth / selector drift); "stale" if it's active but its last check settled
// well over an interval ago (the scheduler isn't reaching it); "pending" if it
// has never completed a check yet; else "ok". Two missed intervals (or 6h,
// whichever's larger) is the staleness threshold — generous enough not to
// false-alarm on a single skipped sweep.
export function deriveWatchHealth(w: {
  active: boolean;
  consecutiveFailures: number;
  lastCheckAt: Date | null;
  intervalMinutes: number;
}, now: Date = new Date()): WatchHealth {
  if (w.consecutiveFailures >= 3) return "failing";
  if (!w.lastCheckAt) return "pending";
  if (!w.active) return "ok";
  const staleMs = Math.max(2 * w.intervalMinutes * 60_000, 6 * 60 * 60_000);
  if (now.getTime() - w.lastCheckAt.getTime() > staleMs) return "stale";
  return "ok";
}

interface WatchRow {
  id: string; orgId: string; jobId: string | null; createdBy: string | null;
  name: string; query: string; location: string | null; notifyFrom: Date;
  intervalMinutes: number; active: boolean; lastRunAt: Date | null;
  nextRunAfter: Date | null; lastRunId: string | null;
  lastCheckAt: Date | null; lastCheckStatus: string | null; lastError: string | null;
  consecutiveFailures: number; lastHitAt: Date | null;
  createdAt: Date; updatedAt: Date;
}

function toDTO(w: WatchRow, createdByName: string | null = null): WatchedSearchDTO {
  return {
    id: w.id,
    orgId: w.orgId,
    jobId: w.jobId,
    createdBy: w.createdBy,
    createdByName,
    name: w.name,
    query: w.query,
    location: w.location,
    notifyFrom: w.notifyFrom.toISOString(),
    intervalMinutes: w.intervalMinutes,
    active: w.active,
    lastRunAt: w.lastRunAt?.toISOString() ?? null,
    nextRunAfter: w.nextRunAfter?.toISOString() ?? null,
    lastRunId: w.lastRunId,
    lastCheckAt: w.lastCheckAt?.toISOString() ?? null,
    lastCheckStatus: w.lastCheckStatus ?? null,
    lastError: w.lastError ?? null,
    consecutiveFailures: w.consecutiveFailures ?? 0,
    lastHitAt: w.lastHitAt?.toISOString() ?? null,
    health: deriveWatchHealth(w),
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
  };
}

// ── CRUD (all org-scoped) ─────────────────────────────────────────────────────

export interface CreateWatchArgs {
  orgId: string;
  createdBy?: string | null;
  jobId?: string | null;
  name: string;
  query: string;
  location?: string | null;
  /** Default: now (only profile updates AFTER the watch is created count). */
  notifyFrom?: Date | null;
  intervalMinutes?: number | null;
}

export async function createWatch(args: CreateWatchArgs): Promise<WatchedSearchDTO> {
  const interval = clampInterval(args.intervalMinutes ?? MAX_INTERVAL_MINUTES);
  const w = await prisma.watchedSearch.create({
    data: {
      orgId: args.orgId,
      createdBy: args.createdBy ?? null,
      jobId: args.jobId ?? null,
      name: args.name,
      query: args.query,
      location: args.location ?? null,
      notifyFrom: args.notifyFrom ?? new Date(),
      intervalMinutes: interval,
      active: true,
      // Eligible for the scheduler immediately; run-due picks it up on the next sweep.
      nextRunAfter: new Date(),
    },
  });
  return toDTO(w);
}

/** List a single org's watches, newest first — with the creator's username
 *  resolved (one batched User query) so the UI can show "by <user>". */
export async function listWatches(orgId: string): Promise<WatchedSearchDTO[]> {
  const rows = await prisma.watchedSearch.findMany({
    where: { orgId },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  const creatorIds = [...new Set(rows.map((r) => r.createdBy).filter((x): x is string => !!x))];
  const creators = creatorIds.length
    ? await prisma.user.findMany({ where: { id: { in: creatorIds } }, select: { id: true, username: true } })
    : [];
  const nameMap = new Map(creators.map((u) => [u.id, u.username]));
  return rows.map((r) => toDTO(r, r.createdBy ? (nameMap.get(r.createdBy) ?? null) : null));
}

export interface UpdateWatchArgs {
  name?: string;
  query?: string;
  location?: string | null;
  notifyFrom?: Date;
  intervalMinutes?: number;
  active?: boolean;
}

/**
 * Patch a watch. Org-scoped via updateMany(where: { id, orgId }) so a caller
 * can never mutate another org's watch. Returns the updated DTO, or null when
 * no row matched (wrong id / wrong org → the route 404s).
 */
export async function updateWatch(
  id: string,
  orgId: string,
  patch: UpdateWatchArgs,
): Promise<WatchedSearchDTO | null> {
  const data: Record<string, unknown> = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.query !== undefined) data.query = patch.query;
  if (patch.location !== undefined) data.location = patch.location;
  if (patch.notifyFrom !== undefined) data.notifyFrom = patch.notifyFrom;
  if (patch.intervalMinutes !== undefined) data.intervalMinutes = clampInterval(patch.intervalMinutes);
  if (patch.active !== undefined) data.active = patch.active;

  const res = await prisma.watchedSearch.updateMany({ where: { id, orgId }, data });
  if (res.count === 0) return null;
  const w = await prisma.watchedSearch.findUnique({ where: { id } });
  return w ? toDTO(w) : null;
}

/** Toggle a watch active/paused. Convenience wrapper over updateWatch. */
export async function setActive(
  id: string,
  orgId: string,
  active: boolean,
): Promise<WatchedSearchDTO | null> {
  return updateWatch(id, orgId, { active });
}

/** Delete a watch (cascades its ProfileUpdateHit rows via the FK). Org-scoped.
 *  Returns true when a row was deleted, false on id/org miss. */
export async function deleteWatch(id: string, orgId: string): Promise<boolean> {
  const res = await prisma.watchedSearch.deleteMany({ where: { id, orgId } });
  return res.count > 0;
}

/** Org-scoped single fetch (routes that PATCH/DELETE/check use this for 404). */
export async function getWatch(id: string, orgId: string): Promise<WatchedSearchDTO | null> {
  const w = await prisma.watchedSearch.findFirst({ where: { id, orgId } });
  return w ? toDTO(w) : null;
}

// ── enqueue a check (reuses the durable search lifecycle) ─────────────────────

/**
 * Kick off one watch check. Creates a SEEK-only SearchRun tagged
 * requestedBy="watch:<id>" (so the scheduler's WATCH_DAILY_CAP can count watch
 * runs distinctly), then enqueues a priority-50 SEEK search job linked to that
 * run. Priority 50 sits between background flywheel discovery (0) and live
 * recruiter search (100) — watches shouldn't jump a recruiter's live search but
 * should beat opportunistic background crawls.
 *
 * Stamps lastRunId / lastRunAt / nextRunAfter on the watch so the feed can
 * lazily detect hits off lastRunId and the scheduler can compute due-ness.
 *
 * Returns the new run id (and the job id when one was enqueued).
 */
export async function enqueueWatchCheck(watch: {
  id: string;
  orgId: string;
  jobId?: string | null;
  query: string;
  location: string | null;
  intervalMinutes: number;
}): Promise<{ runId: string; jobId: string | null }> {
  const parsedQuery = parseBooleanQuery(watch.query);
  // Platform-correct keyword string for the box (vs. the internal raw boolean).
  const seekKeywords = seekKeywordsFromParsed(parsedQuery) || parsedQuery.raw.trim();

  const run = await createRun({
    orgId: watch.orgId,
    jobId: watch.jobId ?? null,
    requestedBy: `watch:${watch.id}`,
    rawQuery: watch.query,
    parsedQuery,
    location: watch.location,
    sources: ["seek"],
    libraryStatus: "skipped",
    linkedinStatus: "skipped",
    seekStatus: "running",
  });

  const job = await enqueueSearchJob({
    orgId: watch.orgId,
    platform: "seek",
    searchQuery: seekKeywords,
    requestedBy: `watch:${watch.id}`,
    priority: 50,
    searchRunId: run.id,
    searchLocation: watch.location,
  });

  const now = new Date();
  await prisma.watchedSearch.update({
    where: { id: watch.id },
    data: {
      lastRunId: run.id,
      lastRunAt: now,
      nextRunAfter: new Date(now.getTime() + clampInterval(watch.intervalMinutes) * 60_000),
    },
  });

  return { runId: run.id, jobId: job?.id ?? null };
}

// ── hit detection ─────────────────────────────────────────────────────────────

/** Numeric SEEK profile id from a profile URL (`/profile/<digits>`), else null. */
function seekIdFromUrl(url: string | null): string | null {
  if (!url) return null;
  const m = url.match(/\/profile\/(\d+)/);
  return m ? m[1] : null;
}

/**
 * Render a JS Date as a tz-less "YYYY-MM-DD HH:MM:SS" string in UTC. parseUpdatedAgo
 * floors buckets to UTC instants; emitting the UTC wall-clock here means the
 * value bound as `::timestamp` (timestamp WITHOUT time zone) stores exactly that
 * instant regardless of the DB session's timezone — no shift, stable dedupe key.
 */
function bucketToTimestampString(d: Date): string {
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

/**
 * Read a watch's SEEK SearchRun result rows, find candidates whose profile was
 * updated at/after the watch's notifyFrom, and record one ProfileUpdateHit per
 * new (watch, seekId, bucket). Idempotent — re-running over the same run is a
 * no-op once the hits exist (the @@unique + ON CONFLICT DO NOTHING dedupes).
 *
 * Threshold is computed in JS (parseUpdatedAgo returns a JS Date bucket; we
 * compare bucket >= notifyFrom in TS) — NEVER bind a Date into $queryRaw.
 *
 * candidateId is resolved by matching the row's normalised seekUrl to an
 * existing Candidate in the SAME org (so the feed can deep-link to the local
 * profile when we already hold it; null when it's a not-yet-ingested profile).
 *
 * Returns the count of NEWLY-inserted hits.
 */
export async function detectHits(watchId: string, runId: string): Promise<number> {
  const watch = await prisma.watchedSearch.findUnique({
    where: { id: watchId },
    select: { id: true, orgId: true, notifyFrom: true, lastRunId: true },
  });
  if (!watch) return 0;
  // Threshold against the START of the watch's notifyFrom day. notifyFrom may be
  // an arbitrary creation instant (e.g. 14:00Z) while parseUpdatedAgo floors
  // buckets to UTC midnight — without flooring the cutoff too, a same-day
  // "Updated today" (00:00Z bucket) would fall just below a 14:00Z notifyFrom
  // and be silently dropped on the watch's first day.
  const notifyFromDay = startOfUtcDay(watch.notifyFrom).getTime();

  // SEEK rows for this run. The run is org-scoped at creation; we still confirm
  // the run belongs to the watch's org so a mismatched runId can't leak rows.
  const run = await prisma.searchRun.findUnique({
    where: { id: runId },
    select: { orgId: true, createdAt: true, completedAt: true },
  });
  if (!run || run.orgId !== watch.orgId) return 0;

  // Anchor "now" to WHEN THE SEARCH RAN, not to detection wall-clock. The card's
  // "Updated 3 hours ago" label was rendered at scrape time, so it must be
  // interpreted relative to the run — and this also makes re-detection of the
  // same run (every SSE tick) deterministic, so the dedupe bucket never drifts.
  const now = run.completedAt ?? run.createdAt ?? new Date();

  const rows = await prisma.searchRunResult.findMany({
    where: { searchRunId: runId },
    select: {
      profileUrl: true,
      name: true,
      headline: true,
      location: true,
      updatedAgo: true,
      sources: true,
    },
  });

  // Pre-resolve candidateId for the rows we'll keep, by normalised seekUrl
  // within the org (one query, not N).
  let newHits = 0;
  const kept: Array<{
    seekId: string;
    profileUrl: string;
    bucket: Date;
    name: string | null;
    headline: string | null;
    location: string | null;
    updatedAgo: string | null;
  }> = [];

  for (const r of rows) {
    // Only SEEK rows carry a parseable recency label.
    let isSeek = false;
    try {
      const src = JSON.parse(r.sources) as unknown;
      isSeek = Array.isArray(src) && src.includes("seek");
    } catch {
      isSeek = false;
    }
    if (!isSeek) continue;
    if (!r.profileUrl) continue;

    const seekId = seekIdFromUrl(r.profileUrl);
    if (!seekId) continue; // no stable dedupe key — skip

    if (!r.updatedAgo) continue;
    const parsed = parseUpdatedAgo(r.updatedAgo, now);
    if (!parsed) continue;
    // JS threshold: keep only updates at/after the watch's notifyFrom DAY.
    if (parsed.bucket.getTime() < notifyFromDay) continue;

    kept.push({
      seekId,
      profileUrl: r.profileUrl,
      bucket: parsed.bucket,
      name: r.name,
      headline: r.headline,
      location: r.location,
      updatedAgo: r.updatedAgo,
    });
  }

  if (kept.length === 0) return 0;

  // Resolve candidateId for the kept profiles by normalised seekUrl, org-scoped.
  const normByUrl = new Map<string, string>(); // profileUrl → normalised
  for (const k of kept) normByUrl.set(k.profileUrl, normaliseSeekUrl(k.profileUrl));
  const normValues = Array.from(new Set(normByUrl.values()));
  const candidateByNorm = new Map<string, string>();
  if (normValues.length > 0) {
    const cands = await prisma.candidate.findMany({
      where: { orgId: watch.orgId, seekUrl: { in: normValues } },
      select: { id: true, seekUrl: true },
    });
    for (const c of cands) {
      if (c.seekUrl) candidateByNorm.set(normaliseSeekUrl(c.seekUrl), c.id);
    }
  }

  for (const k of kept) {
    const norm = normByUrl.get(k.profileUrl) ?? normaliseSeekUrl(k.profileUrl);
    const candidateId = candidateByNorm.get(norm) ?? null;
    // ON CONFLICT (watchId, seekId, updatedAtBucket) DO NOTHING — the dedupe
    // ledger. The bucket is the unique-key TARGET, so its stored value must be
    // stable across sessions: binding a JS Date would let the box's non-UTC
    // session tz-shift it (the known $queryRaw tz-trap) and break dedupe. Bind
    // a tz-less "YYYY-MM-DD HH:MM:SS" string cast ::timestamp instead, so the
    // exact UTC bucket parseUpdatedAgo floored is stored verbatim.
    const bucketTs = bucketToTimestampString(k.bucket);
    const inserted = await prisma.$executeRaw`
      INSERT INTO "ProfileUpdateHit"
        ("id","watchId","orgId","seekId","profileUrl","candidateId","name","headline","location","updatedAgo","updatedAtBucket","flaggedAt","seen")
      VALUES (${randomUUID()}, ${watchId}, ${watch.orgId}, ${k.seekId}, ${k.profileUrl},
              ${candidateId}, ${k.name}, ${k.headline}, ${k.location}, ${k.updatedAgo},
              ${bucketTs}::timestamp, now(), false)
      ON CONFLICT ("watchId","seekId","updatedAtBucket") DO NOTHING
    `;
    newHits += Number(inserted);
  }

  return newHits;
}

// ── feed (Stage D) ─────────────────────────────────────────────────────────

/** SearchRun statuses we treat as terminal — same set the SSE tick closes on. */
const SETTLED_RUN_STATUSES = new Set(["complete", "partial", "failed"]);

/**
 * Run lazy hit-detection for every org-scoped watch whose lastRunId points at a
 * SETTLED SearchRun. detectHits is idempotent (the @@unique + ON CONFLICT DO
 * NOTHING ledger), so re-detecting an already-processed run is a cheap no-op —
 * we don't need a "processed" flag column to stay correct. We only skip runs
 * that are still queued/running (no SEEK rows to read yet). Optionally narrow to
 * a single watchId (the per-watch feed filter).
 *
 * This is the "prefer lazy hit-detection on feed load" path from the BUILD doc:
 * the feed endpoint calls this before reading the ledger, so a recruiter opening
 * /updates sees hits from a check that settled while they were away — no
 * scheduler required.
 *
 * Returns the total count of newly-inserted hits across all processed watches.
 */
export async function detectHitsForOrg(orgId: string, watchId?: string): Promise<number> {
  const watches = await prisma.watchedSearch.findMany({
    where: {
      orgId,
      ...(watchId ? { id: watchId } : {}),
      lastRunId: { not: null },
    },
    select: { id: true, lastRunId: true, lastCheckStatus: true, lastRunAt: true, lastCheckAt: true },
  });
  if (watches.length === 0) return 0;

  const runIds = Array.from(
    new Set(watches.map((w) => w.lastRunId).filter((id): id is string => !!id)),
  );
  const runs = await prisma.searchRun.findMany({
    where: { id: { in: runIds } },
    select: { id: true, status: true, error: true },
  });
  const runById = new Map(runs.map((r) => [r.id, r]));

  let total = 0;
  for (const w of watches) {
    if (!w.lastRunId) continue;
    const run = runById.get(w.lastRunId);
    if (!run || !SETTLED_RUN_STATUSES.has(run.status)) continue; // still running — no outcome yet
    const newHits = await detectHits(w.id, w.lastRunId);
    total += newHits;
    // Reconcile this watch's health from the settled run. Skip when we've
    // already recorded THIS run's outcome (lastCheckAt >= lastRunAt) so a
    // busy feed (SSE ticks) doesn't rewrite the same result every second.
    const alreadyRecorded = w.lastCheckAt && w.lastRunAt && w.lastCheckAt.getTime() >= w.lastRunAt.getTime();
    if (!alreadyRecorded) {
      await reconcileWatchHealth(w.id, run.status, run.error, newHits);
    } else if (newHits > 0) {
      await prisma.watchedSearch.update({ where: { id: w.id }, data: { lastHitAt: new Date() } });
    }
  }
  return total;
}

/**
 * Record a settled check's outcome on the watch so a failing watch becomes
 * VISIBLE (the derived health badge) instead of silently dying. A "failed" run
 * increments consecutiveFailures and stores the error; a "complete"/"partial"
 * run resets the failure counter. lastHitAt advances only when the check
 * produced a new hit. Best-effort — a health-write hiccup must never break the
 * feed, so callers don't await-throw on it.
 */
export async function reconcileWatchHealth(
  watchId: string,
  runStatus: string,
  runError: string | null,
  newHits: number,
): Promise<void> {
  const failed = runStatus === "failed";
  try {
    if (failed) {
      await prisma.watchedSearch.update({
        where: { id: watchId },
        data: {
          lastCheckAt: new Date(),
          lastCheckStatus: runStatus,
          lastError: (runError ?? "SEEK check failed").slice(0, 500),
          consecutiveFailures: { increment: 1 },
        },
      });
    } else {
      await prisma.watchedSearch.update({
        where: { id: watchId },
        data: {
          lastCheckAt: new Date(),
          lastCheckStatus: runStatus,
          lastError: null,
          consecutiveFailures: 0,
          ...(newHits > 0 ? { lastHitAt: new Date() } : {}),
        },
      });
    }
  } catch {
    // non-fatal — health is advisory; the next settled check reconciles again.
  }
}

export interface ProfileUpdateHitDTO {
  id: string;
  watchId: string;
  watchName: string | null;
  /** Resolved username of the watch's creator — "who set this up". */
  watchCreatedByName: string | null;
  seekId: string;
  profileUrl: string;
  candidateId: string | null;
  name: string | null;
  headline: string | null;
  location: string | null;
  updatedAgo: string | null;
  updatedAtBucket: string;
  flaggedAt: string;
  seen: boolean;
}

/**
 * Read the org's hit ledger, newest-flagged first. Org-scoped (every row
 * carries orgId; we filter by it AND, when given, by watchId). Includes the
 * parent watch's name so the feed can label each row without an N+1.
 */
export async function listHits(
  orgId: string,
  opts: { watchId?: string; limit?: number; unseenOnly?: boolean } = {},
): Promise<ProfileUpdateHitDTO[]> {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
  const rows = await prisma.profileUpdateHit.findMany({
    where: {
      orgId,
      ...(opts.watchId ? { watchId: opts.watchId } : {}),
      ...(opts.unseenOnly ? { seen: false } : {}),
    },
    orderBy: { flaggedAt: "desc" },
    take: limit,
    include: { watch: { select: { name: true, createdBy: true } } },
  });
  const creatorIds = [...new Set(rows.map((r) => r.watch?.createdBy).filter((x): x is string => !!x))];
  const creators = creatorIds.length
    ? await prisma.user.findMany({ where: { id: { in: creatorIds } }, select: { id: true, username: true } })
    : [];
  const nameMap = new Map(creators.map((u) => [u.id, u.username]));
  return rows.map((r) => ({
    id: r.id,
    watchId: r.watchId,
    watchName: r.watch?.name ?? null,
    watchCreatedByName: r.watch?.createdBy ? (nameMap.get(r.watch.createdBy) ?? null) : null,
    seekId: r.seekId,
    profileUrl: r.profileUrl,
    candidateId: r.candidateId,
    name: r.name,
    headline: r.headline,
    location: r.location,
    updatedAgo: r.updatedAgo,
    updatedAtBucket: r.updatedAtBucket.toISOString(),
    flaggedAt: r.flaggedAt.toISOString(),
    seen: r.seen,
  }));
}

/** Count the org's UNSEEN hits (the bell badge). Org-scoped. */
export async function countUnseenHits(orgId: string): Promise<number> {
  return prisma.profileUpdateHit.count({ where: { orgId, seen: false } });
}

/**
 * Mark hits seen. Org-scoped via updateMany(where: { orgId, ... }) so a caller
 * can never flip another org's rows. When `ids` is given, only those rows
 * (still org-filtered); otherwise the whole org's unseen feed (optionally
 * narrowed to one watch). Returns the number of rows updated.
 */
export async function markHitsSeen(
  orgId: string,
  opts: { ids?: string[]; watchId?: string } = {},
): Promise<number> {
  const res = await prisma.profileUpdateHit.updateMany({
    where: {
      orgId,
      seen: false,
      ...(opts.ids && opts.ids.length > 0 ? { id: { in: opts.ids } } : {}),
      ...(opts.watchId ? { watchId: opts.watchId } : {}),
    },
    data: { seen: true },
  });
  return res.count;
}
