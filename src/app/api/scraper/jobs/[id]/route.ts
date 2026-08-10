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
 * Auth: per-box Bearer token or the shared x-scraper-secret (authenticateScraper).
 * A tenant-bound token may only finalise jobs belonging to its own org.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { isScraperEnabled } from "@/lib/feature-flags";
import { authenticateScraper, resolveScraperOrgId } from "@/lib/scraper-auth";
import { ingestScraperResult } from "@/lib/scraper-ingestion";
import { reportError } from "@/lib/error-reporting";
import { enqueueScrapeJob } from "@/lib/scrape-queue";
import { planProfileFetches, type FetchCandidate } from "@/lib/fetch-planner";
import { detectWatchHitsForRun } from "@/lib/watched-search";
import {
  attachScraperHits,
  attachIngestedProfile,
  settleRunIfDone,
  setSourceStatus,
  scraperMergeKey,
  platformToSource,
} from "@/lib/search-run";

const MAX_RETRIES = 3;

/**
 * How many SEEK profiles to deep-scrape per harvested search.
 *
 * ON by default — a SEEK candidate with no profile body is close to useless for
 * scoring, so this shouldn't need switching on. The bound exists because the box
 * fetches sequentially at ~30–40s a profile: 25 is roughly fifteen minutes of
 * box time per search, which leaves the queue responsive for Pulse checks and
 * on-demand fetches. Raise SEEK_DEEP_SCRAPE_PER_SEARCH if the box is idle.
 */
const SEEK_DEEP_SCRAPE_PER_SEARCH = Math.max(
  0,
  Number(process.env.SEEK_DEEP_SCRAPE_PER_SEARCH ?? 25) || 0,
);

const PatchSchema = z.object({
  status: z.enum(["completed", "failed"]),
  // Single permissive shape covering all job kinds. The handler branches on
  // `job.kind`: kind="profile" requires `profileText`; kind="search" requires
  // `urls`; kind="score" requires `text` (the raw LLM output).
  result: z
    .object({
      // profile job fields
      profileText: z.string().max(300_000).optional(),
      // Legacy score-offload field (removed 2026-07-04). Kept optional so an
      // in-flight worker POST can't 422; ignored by the handler now.
      text: z.string().max(100_000).optional(),
      name: z.string().max(500).optional().nullable(),
      headline: z.string().max(500).optional().nullable(),
      location: z.string().max(500).optional().nullable(),
      linkedinUrl: z.string().max(1000).optional().nullable(),
      seekUrl: z.string().max(1000).optional().nullable(),
      // search job fields
      urls: z.array(z.string().max(1000)).max(200).optional(),
      // per-card metadata harvested from the search results page
      cards: z
        .array(
          z.object({
            url: z.string().max(1000),
            name: z.string().max(500).nullable().optional(),
            headline: z.string().max(500).nullable().optional(),
            location: z.string().max(500).nullable().optional(),
            // SEEK "Updated X ago" recency label (additive; null/absent for
            // LinkedIn + pre-watch-feature SEEK harvests).
            updatedAgo: z.string().max(200).nullable().optional(),
          }),
        )
        .max(200)
        .optional(),
      // SEEK search jobs: true when SEEK itself scoped the search to the
      // requested region (locationList= in the results URL). Tells
      // attachScraperHits to skip its own card-location re-filter, which
      // silently dropped legit harvests whose location line didn't parse.
      locationApplied: z.boolean().optional(),
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
  const principal = await authenticateScraper(req);
  if (!principal) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { id } = await params;

  const job = await prisma.scrapeJob.findUnique({
    where: { id },
    select: {
      id: true,
      orgId: true,
      platform: true,
      kind: true,
      profileUrl: true,
      searchQuery: true,
      searchRunId: true,
      retryCount: true,
      status: true,
      // Legacy score-offload columns (inert since 2026-07-04); still selected
      // so a stray kind="score" job can be recognised + failed cleanly.
      candidateId: true,
      scorePayload: true,
    },
  });

  if (!job) {
    return NextResponse.json({ error: "ScrapeJob not found." }, { status: 404 });
  }
  // Tenant binding: a per-box token may only finalise jobs in its own org; an
  // owner-scope principal (shared SCRAPER_SECRET / null-org token) may act on
  // any org. Mirrors the GET/POST routes and closes the cross-tenant write
  // where any holder of the shared secret could PATCH another org's job.
  const bound = resolveScraperOrgId(principal.boundOrgId, job.orgId);
  if ("error" in bound) {
    return NextResponse.json({ error: bound.error }, { status: 403 });
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
    // An auth challenge (session expired / login wall) won't fix itself on
    // retry — fail it immediately instead of burning 3 attempts that each
    // re-hit the wall. Everything else gets the normal retry budget.
    const isChallenge = (error ?? "").includes("_challenge:");
    const newRetryCount = job.retryCount + 1;
    const finalStatus = isChallenge || newRetryCount >= MAX_RETRIES ? "failed" : "pending";
    await prisma.scrapeJob.update({
      where: { id },
      data: {
        status: finalStatus,
        error: error ?? "Worker reported failure",
        retryCount: newRetryCount,
        updatedAt: new Date(),
      },
    });
    // Phase K: a permanently-failed child must not block its SearchRun forever.
    if (finalStatus === "failed" && job.searchRunId) {
      const source = platformToSource(job.platform);
      // Flag the source "failed" so the UI shows the re-auth banner when:
      //  - a kind="search" job failed (the harvest itself hit an auth wall), OR
      //  - a kind="profile" job failed with a *_challenge: prefix — a session
      //    challenge often surfaces on the PROFILE fetch after the search
      //    harvested URLs fine. Without this the source pill would go
      //    running → done with zero candidates and no banner (a silent skip).
      if (source && (job.kind === "search" || isChallenge)) {
        await setSourceStatus(job.searchRunId, source, "failed");
      }
      await settleRunIfDone(job.searchRunId);
      // Reconcile watch health immediately on a failed check too (so a failing
      // Pulse watch flips red without waiting for a feed-load). No-op otherwise.
      await detectWatchHitsForRun(job.searchRunId).catch(() => {});
    }
    return NextResponse.json({ requeued: finalStatus === "pending", retryCount: newRetryCount });
  }

  // --- Success path ---

  // Search jobs: result is a list of harvested profile URLs. We just persist
  // the URL list as the job's result and mark it completed. The worker is
  // responsible for separately POSTing each URL back as a kind="profile"
  // job (so each scrape gets its own retry/dedup/ingestion lifecycle).
  if (job.kind === "search") {
    const urls = result?.urls ?? [];
    const cards = result?.cards ?? [];
    await prisma.scrapeJob.update({
      where: { id },
      data: {
        status: "completed",
        result: JSON.stringify({ urls, harvestedAt: new Date().toISOString() }),
        updatedAt: new Date(),
      },
    });

    // SEEK Talent Search: turn the harvested result cards into persistent
    // candidates (name/headline/location/seekUrl from the card), then queue the
    // profiles themselves for a deep scrape.
    //
    // This used to stop at the card "for credit safety". That was wrong: opening
    // a SEEK profile does NOT cost a credit — scrapeSeekProfile only navigates,
    // scrolls and reads the DOM; it never clicks a reveal/unlock/download. The
    // cost in SEEK's model sits behind contact details, which we never touch.
    // The consequence of that mistaken premise was severe and entirely
    // self-inflicted: every SEEK candidate was stored with profileText "" and
    // then scored from a ~150-char card, so classifyDataQuality called it
    // "minimal", and a recruiter saw 40% WEAK / "not enough info" on someone
    // whose profile actually lists three or four roles with skills.
    //
    // Runs regardless of searchRunId so even legacy /search runs populate the
    // pool. ingestScraperResult dedups by seekUrl + reuses identity resolution.
    // Per-card try/catch so one malformed card can't fail the whole job.
    if (job.platform === "seek" && cards.length > 0) {
      const ingestedCandidates: FetchCandidate[] = [];
      // candidateId → the URL to deep-scrape. Needed because the planner returns
      // ids, and a candidate can only be re-found by the card it came from.
      const urlByCandidateId = new Map<string, string>();
      for (const card of cards) {
        if (!card.url) continue;
        try {
          const res = await ingestScraperResult({
            orgId: job.orgId,
            platform: "seek",
            profileUrl: card.url,
            // Card data only at this point — the deep scrape below fills in the
            // body text. The candidate is findable via FTS on
            // name/headline/location in the meantime.
            profileText: "",
            name: card.name ?? null,
            headline: card.headline ?? null,
            location: card.location ?? null,
          });
          ingestedCandidates.push({
            id: res.candidateId,
            platform: "seek",
            profileChars: 0,
            matchScore: null,
            fetchPriorityScore: null,
            status: "new",
            hasProfileUrl: true,
          });
          urlByCandidateId.set(res.candidateId, card.url);
        } catch (err) {
          reportError(err, { route: "scraper/jobs:seek-card-ingest", jobId: id, orgId: job.orgId });
        }
      }

      // Credits aren't the constraint — the box is. It fetches sequentially at
      // ~30–40s a profile, so one broad search could otherwise monopolise the
      // queue for a day. Bound each harvest and let the planner spend that
      // allowance on the candidates most likely to change a decision.
      const plan = planProfileFetches(ingestedCandidates, { budget: SEEK_DEEP_SCRAPE_PER_SEARCH });
      let queued = 0;
      for (const candidateId of plan.selected) {
        const profileUrl = urlByCandidateId.get(candidateId);
        if (!profileUrl) continue;
        const created = await enqueueScrapeJob({
          orgId: job.orgId,
          platform: "seek",
          profileUrl,
          candidateId,
        });
        if (created) queued++;
      }
      console.log(
        `[scraper] seek-search ${id}: ingested ${ingestedCandidates.length}/${cards.length} card(s), ` +
        `queued ${queued} profile fetch(es), ${plan.skippedForBudget} deferred`
      );
    }

    // Phase K: attach the harvested cards as result rows (with name/headline/
    // location so they render immediately, not as "fetching…").
    if (job.searchRunId) {
      const source = platformToSource(job.platform);
      if (source) {
        await attachScraperHits({
          searchRunId: job.searchRunId,
          source,
          urls,
          cards,
          sourceLocationApplied: result?.locationApplied === true,
        });
        // Mark the source COMPLETE the moment the harvest lands — the page of
        // results IS the search result (like the native sites). The pill flips
        // to "done · N" instantly instead of staying "live" while LinkedIn
        // profile children enrich in the background. settleRunIfDone still
        // gates the RUN-level status on in-flight children, so the SSE stream
        // stays open and enriched rows keep flowing in.
        await setSourceStatus(job.searchRunId, source, "complete");
      }
      await settleRunIfDone(job.searchRunId);
      // Pulse: detect profile-update hits the MOMENT this run settles, so a
      // watch surfaces updates within its check interval instead of only when
      // someone next opens the feed. No-op + idempotent for non-watch runs.
      await detectWatchHitsForRun(job.searchRunId).catch((err) =>
        reportError(err, { route: "scraper/jobs:detectWatchHits", runId: job.searchRunId }),
      );
    }
    return NextResponse.json({ kind: "search", urlCount: urls.length });
  }

  // NOTE: the kind="score" (Llama offload) result path was removed 2026-07-04
  // along with the rest of the offload feature — nothing enqueues score jobs
  // anymore. A stray legacy kind="score" job (there should be none) is failed
  // cleanly rather than processed.
  if (job.kind === "score") {
    await prisma.scrapeJob.update({
      where: { id },
      data: { status: "failed", error: "Score offload removed — kind=score no longer processed", updatedAt: new Date() },
    });
    return NextResponse.json({ error: "Score offload removed." }, { status: 410 });
  }

  // Profile jobs: existing ingestion flow.
  if (!result?.profileText) {
    await prisma.scrapeJob.update({
      where: { id },
      data: { status: "failed", error: "Completed but no profileText returned", updatedAt: new Date() },
    });
    return NextResponse.json({ error: "No profileText in result." }, { status: 422 });
  }
  if (!job.profileUrl) {
    await prisma.scrapeJob.update({
      where: { id },
      data: { status: "failed", error: "Profile job missing profileUrl", updatedAt: new Date() },
    });
    return NextResponse.json({ error: "Profile job missing profileUrl." }, { status: 422 });
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

  // Phase K: attach the ingested profile to its SearchRun (reconciling against
  // any existing library hit for the same candidate), then check completion.
  if (job.searchRunId) {
    const source = platformToSource(job.platform);
    if (source && job.profileUrl) {
      const mergeKey = scraperMergeKey({
        linkedinUrl: source === "linkedin" ? job.profileUrl : null,
        seekUrl: source === "seek" ? job.profileUrl : null,
        fallbackUrl: job.profileUrl,
      });
      await attachIngestedProfile({
        searchRunId: job.searchRunId,
        candidateId: ingestResult.candidateId,
        candidateIdentityId: ingestResult.identityId,
        mergeKey,
        source,
        profileUrl: job.profileUrl,
        name: result.name ?? null,
        headline: result.headline ?? null,
        location: result.location ?? null,
        snippet: result.profileText ? result.profileText.slice(0, 400) : null,
      });
    }
    await settleRunIfDone(job.searchRunId);
  }

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
