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
import { finalizeScoreFromText } from "@/lib/ai";
import { deriveUpdateData } from "@/lib/score-utils";
import type { ScoringWeights } from "@/lib/scoring-config";
import {
  attachScraperHits,
  attachIngestedProfile,
  settleRunIfDone,
  setSourceStatus,
  scraperMergeKey,
  platformToSource,
} from "@/lib/search-run";

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
  // Single permissive shape covering all job kinds. The handler branches on
  // `job.kind`: kind="profile" requires `profileText`; kind="search" requires
  // `urls`; kind="score" requires `text` (the raw LLM output).
  result: z
    .object({
      // profile job fields
      profileText: z.string().max(300_000).optional(),
      // score job field: the raw text the box's local model returned for the
      // scoring prompt. finalizeScoreFromText parses it into a ScoreBreakdown.
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
          }),
        )
        .max(200)
        .optional(),
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
      // kind="score": the candidate this prompt scores + the serialized prompt
      // payload (carries finalizeCtx for finalizeScoreFromText).
      candidateId: true,
      scorePayload: true,
    },
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
    // Phase K: attach the harvested cards as result rows (with name/headline/
    // location so they render immediately, not as "fetching…").
    if (job.searchRunId) {
      const source = platformToSource(job.platform);
      if (source) {
        await attachScraperHits({ searchRunId: job.searchRunId, source, urls, cards });
        // Mark the source COMPLETE the moment the harvest lands — the page of
        // results IS the search result (like the native sites). The pill flips
        // to "done · N" instantly instead of staying "live" while LinkedIn
        // profile children enrich in the background. settleRunIfDone still
        // gates the RUN-level status on in-flight children, so the SSE stream
        // stays open and enriched rows keep flowing in.
        await setSourceStatus(job.searchRunId, source, "complete");
      }
      await settleRunIfDone(job.searchRunId);
    }
    return NextResponse.json({ kind: "search", urlCount: urls.length });
  }

  // Score jobs (Llama offload): the box ran the prompt Railway built against
  // its local Ollama and POSTed back the raw text. Railway finalizes that text
  // into a ScoreBreakdown (identical math to the single-score route — the
  // finalize seam is shared) and writes it to the candidate. No searchRunId
  // logic: score jobs never attach to a SearchRun.
  if (job.kind === "score") {
    if (!job.candidateId || !job.scorePayload || !result?.text) {
      await prisma.scrapeJob.update({
        where: { id },
        data: {
          status: "failed",
          error: "Score job missing candidateId, scorePayload, or result.text",
          updatedAt: new Date(),
        },
      });
      return NextResponse.json(
        { error: "Score job missing candidateId, scorePayload, or result.text." },
        { status: 422 },
      );
    }

    // scorePayload was serialized by enqueueScoreJob from buildScorePrompt's
    // output: { system, prompt, temperature, maxTokens, model?, finalizeCtx }.
    // finalizeCtx is the only part finalize needs (the prompt itself is the
    // box's job).
    let finalizeCtx: {
      mustHaves: string[];
      niceToHaves: string[];
      weights?: ScoringWeights;
      parsedRoleLocation: string | null;
      parsedRoleTitle?: string | null;
    };
    try {
      const payload = JSON.parse(job.scorePayload) as {
        finalizeCtx?: typeof finalizeCtx;
      };
      if (!payload.finalizeCtx) throw new Error("scorePayload has no finalizeCtx");
      finalizeCtx = payload.finalizeCtx;
    } catch (err) {
      await prisma.scrapeJob.update({
        where: { id },
        data: {
          status: "failed",
          error: `Score job has unparseable scorePayload: ${err instanceof Error ? err.message : String(err)}`,
          updatedAt: new Date(),
        },
      });
      return NextResponse.json({ error: "Score job has unparseable scorePayload." }, { status: 422 });
    }

    const candidate = await prisma.candidate.findUnique({
      where: { id: job.candidateId },
      select: { id: true, profileText: true, orgId: true, profileTextHash: true },
    });
    if (!candidate) {
      await prisma.scrapeJob.update({
        where: { id },
        data: { status: "failed", error: "Score job candidate not found", updatedAt: new Date() },
      });
      return NextResponse.json({ error: "Score job candidate not found." }, { status: 404 });
    }

    // Finalize the raw model text into a ScoreBreakdown — same seam the
    // single-score route uses, tagged scoredBy="ollama" since the box ran the
    // local model.
    const breakdown = finalizeScoreFromText(result.text, "ollama", {
      profileText: candidate.profileText ?? "",
      ...finalizeCtx,
    });

    // Concurrency-guarded write, mirroring the single-score route: only write
    // if the row still carries the profileTextHash it had when this job was
    // enqueued. A fresher Claude/Ollama score that landed while the box was
    // working will have advanced the hash; our older offload score must not
    // clobber it. count===0 → a fresher score won; we still mark the job
    // completed (the offload did its part) and report no write.
    const guarded = await prisma.candidate.updateMany({
      where: { id: candidate.id, profileTextHash: candidate.profileTextHash ?? null },
      data: deriveUpdateData(breakdown),
    });
    if (guarded.count === 0) {
      console.log(`[score-offload] concurrent writer won for candidate=${candidate.id} — skipping stale offload score`);
    }

    await prisma.scrapeJob.update({
      where: { id },
      data: {
        status: "completed",
        result: JSON.stringify({ matchScore: breakdown.overall, scoredBy: "ollama", finalizedAt: new Date().toISOString() }),
        updatedAt: new Date(),
      },
    });

    return NextResponse.json({ kind: "score", candidateId: candidate.id, matchScore: breakdown.overall });
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
