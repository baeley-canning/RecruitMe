/**
 * refresh_known_profile — the flywheel's return stroke.
 *
 * We already TRACK which library profiles are stale (Candidate.profileCapturedAt,
 * indexed by [orgId, profileCapturedAt]) but nothing ever re-fetches them, so a
 * profile captured once slowly rots. This sweep picks the stalest LinkedIn
 * profiles we already hold and enqueues a normal background kind="profile"
 * ScrapeJob for each — the worker re-fetches, POSTs back, and ingestion
 * fill-merges the fresh data onto the SAME identity by URL.
 *
 * LIBRARY-SAFE BY CONSTRUCTION:
 *  - It only ENQUEUES re-fetch jobs — it never updates or deletes a Candidate.
 *  - It re-fetches URLs we ALREADY hold (no new discovery, no vendor spend).
 *  - enqueueScrapeJob dedups on (orgId, profileUrl, in-flight) so a person
 *    already queued isn't queued twice.
 *  - Jobs go in at background priority (the kind="profile" default of 0), so a
 *    refresh sweep can never starve a live recruiter search (priority 100) —
 *    claimScrapeJobs orders by priority DESC.
 *
 * SCOPE (first slice): LinkedIn only. SEEK re-fetch is credit-sensitive and
 * JobAdder re-sync is a separate archive concern; both are deliberately out of
 * scope here so this sweep can never spend SEEK credits.
 */

import { prisma } from "./db";
import { enqueueScrapeJob } from "./scrape-queue";
import { isLinkedInProfileUrl } from "./linkedin";

/** A profile is "stale" once its last capture is older than this many days. */
export const DEFAULT_STALE_AFTER_DAYS = 90;
/** Max profiles enqueued per sweep — small so refresh stays a background trickle. */
export const DEFAULT_REFRESH_LIMIT = 25;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RefreshSummary {
  /** Stale profiles the sweep selected (before enqueue dedup). */
  candidates: number;
  /** New background re-fetch jobs actually enqueued (post-dedup). */
  enqueued: number;
  staleAfterDays: number;
  limit: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Select the stalest known LinkedIn profiles and enqueue a background re-fetch
 * for each. Returns a summary. Never throws for a single bad row — a failed
 * enqueue is skipped (enqueueScrapeJob already swallows + reports its own
 * errors and returns null).
 */
export async function enqueueStaleProfileRefresh(
  opts: { limit?: number; staleAfterDays?: number } = {},
): Promise<RefreshSummary> {
  const staleAfterDays = opts.staleAfterDays ?? envInt("PROFILE_REFRESH_STALE_DAYS", DEFAULT_STALE_AFTER_DAYS);
  const limit = opts.limit ?? envInt("PROFILE_REFRESH_LIMIT", DEFAULT_REFRESH_LIMIT);
  const cutoff = new Date(Date.now() - staleAfterDays * DAY_MS);

  // Stalest-first, DISTINCT per (orgId, linkedinUrl) so N job-copies of the same
  // person don't each burn a slot. profileCapturedAt not null (we captured it
  // once) AND older than the cutoff. orgId not null so the job is org-scoped.
  const rows = await prisma.candidate.findMany({
    where: {
      orgId: { not: null },
      linkedinUrl: { not: null },
      profileCapturedAt: { not: null, lt: cutoff },
    },
    orderBy: { profileCapturedAt: "asc" },
    distinct: ["orgId", "linkedinUrl"],
    take: limit,
    select: { id: true, orgId: true, linkedinUrl: true },
  });

  let enqueued = 0;
  for (const r of rows) {
    // Guard the URL: only a genuine linkedin.com/in profile is a valid re-fetch
    // target (skips any legacy `library:<id>` placeholder or malformed value).
    if (!r.orgId || !r.linkedinUrl || !isLinkedInProfileUrl(r.linkedinUrl)) continue;
    const job = await enqueueScrapeJob({
      orgId: r.orgId,
      platform: "linkedin",
      profileUrl: r.linkedinUrl,
      candidateId: r.id,
      requestedBy: "refresh:auto",
    });
    if (job) enqueued++;
  }

  return { candidates: rows.length, enqueued, staleAfterDays, limit };
}
