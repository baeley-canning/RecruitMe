import { prisma } from "@/lib/db";
import { predictAcceptance } from "@/lib/ai";
import type { ParsedRole } from "@/lib/ai";
import { scoreCandidatesBatch } from "@/lib/ai/scoring";
import type { BatchScoreInput } from "@/lib/ai/scoring";
import { providerHealth, deriveProviderState } from "@/lib/provider-health";
import { applyLocationFitOverride, deriveUpdateData } from "@/lib/score-utils";
import { getJobTargetLocation } from "@/lib/job-target-location";
import { getAuth, requireJobAccess, unauthorized } from "@/lib/session";
import { requireCapability } from "@/lib/require-capability";
import { buildScoreCacheKey, safeParseJson } from "@/lib/utils";
import { checkRateLimit, checkSpendCap, recordUsage } from "@/lib/usage";
import { getJobScoringWeights } from "@/lib/scoring-config";
import { getRecruitingContext, getCorrectionsVersion } from "@/lib/recruiter-memory";
import { reportError } from "@/lib/error-reporting";
import { mergeScoringError } from "@/lib/linkedin-capture";
import { NextResponse } from "next/server";

// Allow up to 5 minutes for large scoring runs. Without this, Vercel (and some
// Railway proxy configurations) cut the connection at ~30s leaving partial results.
export const maxDuration = 300;

// Outer group size for batched scoring (M1). Each group's candidates go to
// scoreCandidatesBatch, which chunks internally at SCORE_BATCH_SIZE (5) and shares
// the cached system block + per-role context across the batch — a ~5:1 cut in the
// (often-Sonnet) scoring calls. The group also bounds the spend-cap re-check
// cadence and the concurrent fan-out.
const BATCH_GROUP_SIZE = 10;
// Acceptance prediction has no batch form, so it stays 1:1; bound its fan-out so a
// group doesn't fire BATCH_GROUP_SIZE concurrent (cheap Haiku) calls at once.
const ACCEPTANCE_CONCURRENCY = 5;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const denied = await requireCapability(auth, "score");
  if (denied) return denied;
  const { id } = await params;

  // ?onlyUnscored=1 — scope the score-all run to candidates that haven't been
  // AI-scored yet. Library-import callers pass this so freshly-imported pool
  // candidates get scored without re-rescoring the LinkedIn cohort.
  const url = new URL(req.url);
  const onlyUnscored = url.searchParams.get("onlyUnscored") === "1";
  // ?force=1 — bypass the "profile unchanged" cache so EVERY candidate is
  // re-scored even when nothing materially changed. The rate-limit + daily spend
  // cap still apply (real cost guards); this only overrides the token-saving
  // cache-hit skip. Mutually exclusive with onlyUnscored (force = rescore all).
  const force = url.searchParams.get("force") === "1";

  const { job, error } = await requireJobAccess(id, auth);
  if (error || !job) return error;
  if (!job.parsedRole) {
    return NextResponse.json({ error: "Parse the job description first." }, { status: 400 });
  }

  const rateCheck = await checkRateLimit(auth.orgId, "score_all");
  if (!rateCheck.allowed) {
    const waitMin = Math.ceil((rateCheck.retryAfterMs ?? 60000) / 60000);
    return NextResponse.json({ error: `Score-all rate limit reached. Try again in ~${waitMin} minute${waitMin !== 1 ? "s" : ""}.` }, { status: 429 });
  }

  // Cost ceiling — the per-event rate-limit caps call *count* but not *spend*.
  // The $10 burn that motivated this came from rescoring 30 candidates well
  // under the 20/hr score_all cap; a daily USD cap is the real safety net.
  const spend = await checkSpendCap(auth.orgId);
  if (!spend.allowed) {
    return NextResponse.json({
      error: `Daily AI spend cap reached ($${spend.spentUsd.toFixed(2)} / $${spend.capUsd.toFixed(2)}). Try again tomorrow or raise AI_DAILY_SPEND_CAP_USD.`,
    }, { status: 429 });
  }

  // Select first, claim later. The cooldown stamp protects against
  // double-billing two concurrent runs, but if there's nothing to score
  // we shouldn't 429 a chained `?onlyUnscored=1` call from a library
  // import that found zero new candidates — that path is supposed to be
  // a no-op, not an error.
  //
  // Select only the fields we need for scoring. Without this we fetch every
  // candidate's profileText (50KB+), scoreBreakdown (~5KB), matchReason etc —
  // turning a 500-candidate score-all into a 25MB+ memory hit even before
  // any scoring fires.
  const candidatesPreflight = await prisma.candidate.findMany({
    where: {
      jobId: id,
      ...(onlyUnscored ? { matchScore: null } : {}),
      // Scoreable = has profileText OR a headline/location we can synthesise a
      // thin profile from. The old `profileText: { not: null }` silently
      // EXCLUDED LinkedIn/SEEK snippet finds (which carry name+headline but no
      // full profileText) — they never even entered the loop. The per-candidate
      // score route already scores these via synthesis; score-all now matches.
      OR: [{ profileText: { not: null } }, { headline: { not: null } }, { location: { not: null } }],
    },
    select: { id: true },
  });
  if (candidatesPreflight.length === 0) {
    return NextResponse.json({ scored: 0, total: 0, message: onlyUnscored ? "Nothing to score." : "No scoreable candidates." });
  }

  // Conditional cooldown stamp — only one score-all run can claim the job at
  // a time. Two recruiters who hit the button simultaneously both pass the
  // process-local rate limiter; without this guard they'd both stamp
  // lastScoredAt and double-bill the AI. updateMany returns count=0 when the
  // claim is already held; we bail with 429.
  const SCORE_ALL_COOLDOWN_MS = 60_000;
  const claim = await prisma.job.updateMany({
    where: {
      id,
      OR: [
        { lastScoredAt: null },
        { lastScoredAt: { lt: new Date(Date.now() - SCORE_ALL_COOLDOWN_MS) } },
      ],
    },
    data: { lastScoredAt: new Date() },
  });
  if (claim.count === 0) {
    return NextResponse.json({
      error: "Score-all is already running for this job. Wait a minute and try again.",
    }, { status: 429 });
  }

  const candidates = await prisma.candidate.findMany({
    where: {
      jobId: id,
      ...(onlyUnscored ? { matchScore: null } : {}),
      // See preflight: include headline/location-only finds so LinkedIn/SEEK
      // snippet cards are scored (via synthesis) instead of silently skipped.
      OR: [{ profileText: { not: null } }, { headline: { not: null } }, { location: { not: null } }],
    },
    select: {
      id: true,
      profileText: true,
      name: true,
      headline: true,
      location: true,
      // Cache-hit signal: skip the API call when these match the freshly
      // computed cache key. Avoids re-scoring candidates whose profile +
      // role + salary + weights haven't materially changed.
      profileTextHash: true,
      matchScore: true,
      scoreBreakdown: true,
    },
  });

  if (candidates.length === 0) {
    return NextResponse.json({ scored: 0, total: 0 });
  }

  const parsedRole = safeParseJson<ParsedRole | null>(job.parsedRole, null);
  if (!parsedRole) {
    return NextResponse.json({ error: "Job parse data is invalid. Parse the job description again." }, { status: 400 });
  }
  const salary = (job.salaryMin || job.salaryMax)
    ? { min: job.salaryMin ?? 0, max: job.salaryMax ?? 0 }
    : null;
  const weights = await getJobScoringWeights(job.scoringWeights, auth.orgId);

  // Pre-fetch recruiter memory once per job — avoids one DB query per candidate.
  const recruiterContext = await getRecruitingContext(parsedRole, auth.orgId).catch(() => "");
  // Pre-fetch the per-org corrections version once so every candidate's cache
  // key in this run uses the same version snapshot. A correction saved
  // mid-run will bust the cache on the NEXT score-all (its bumpCorrectionsVersion
  // happens in the correct-score route, not here).
  const correctionsVersion = await getCorrectionsVersion(auth.orgId);

  const total = candidates.length;
  let scored = 0;
  let cached = 0;
  // `queued` is a constant 0 kept only so the streamed message shape stays
  // unchanged for the UI. There is no box-Llama score offload anymore (removed
  // 2026-07-04) — nothing is ever queued to the mini-PC for scoring.
  const queued = 0;
  const failed: string[] = [];
  // Subset of `failed` that failed specifically because every AI provider was
  // down (Claude out + Ollama unreachable) while the offload flag was OFF. When
  // ALL failures are this kind — and nothing scored/cached/queued — the summary
  // reads as a provider outage rather than a generic per-candidate failure, so
  // the recruiter understands it's not bad data.
  let providerOutageFails = 0;
  const encoder = new TextEncoder();

  // Stream progress as newline-delimited JSON so the client can show a live counter.
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) =>
        controller.enqueue(encoder.encode(JSON.stringify(data) + "\n"));

      // Send total upfront so the client can show "0 of N" immediately.
      send({ scored: 0, total });

      // Mid-run spend-cap re-check. The cap is checked once before we start, but
      // with 11k+ candidates scoreable in a library a single run could blow past
      // it — so we re-check before every BATCH_GROUP_SIZE-wide group dispatches,
      // aborting BEFORE that group's API calls fire (at most one group lands over
      // the cap).
      let cappedHit = false;

      const evaluateSpendCap = async (): Promise<boolean> => {
        const midSpend = await checkSpendCap(auth.orgId);
        if (!midSpend.allowed) {
          cappedHit = true;
          send({
            scored, cached, queued, total,
            capped: true,
            spentUsd: midSpend.spentUsd,
            capUsd: midSpend.capUsd,
            error: `Daily AI spend cap reached mid-run ($${midSpend.spentUsd.toFixed(2)} / $${midSpend.capUsd.toFixed(2)}). Run again tomorrow or raise AI_DAILY_SPEND_CAP_USD.`,
          });
          return true;
        }
        return false;
      };

      // ─── PASS 1: partition — cache-hits (skip) vs needs-scoring ───────────
      // No API calls here; mirrors the per-candidate cache check so only
      // materially-changed candidates (or ?force=1) go to the scorer.
      type ToScore = { id: string; scoreText: string; cacheKey: string; location: string | null };
      const toScore: ToScore[] = [];
      for (const candidate of candidates) {
        // Synthesise a thin profile from name/headline/location when there's no
        // full profileText — so LinkedIn/SEEK snippet finds get scored (as a
        // low-confidence ESTIMATE) instead of silently skipped. Reject only when
        // there's truly nothing (no profileText AND no headline AND no location).
        const scoreText = (candidate.profileText && candidate.profileText.trim().length > 0)
          ? candidate.profileText
          : [candidate.name, candidate.headline, candidate.location].filter(Boolean).join("\n");
        if (!scoreText || scoreText.trim().length < 10) continue;

        const scoreCacheKey = buildScoreCacheKey({
          profileText: scoreText,
          parsedRole,
          salary,
          jobLocation: job.location,
          jobLocation2: job.location2,
          isRemote: job.isRemote,
          weights,
          correctionsVersion,
        });

        // Cache hit: profile + role + salary + location + weights unchanged AND a
        // real score is already stored → skip the API call entirely.
        if (
          !force &&
          candidate.profileTextHash === scoreCacheKey &&
          candidate.matchScore !== null &&
          candidate.scoreBreakdown
        ) {
          cached++;
          send({ scored, cached, total });
          continue;
        }
        toScore.push({ id: candidate.id, scoreText, cacheKey: scoreCacheKey, location: candidate.location });
      }

      // Per-candidate acceptance prediction (no batch form exists), bounded so a
      // group doesn't fan out BATCH_GROUP_SIZE concurrent calls. A failure degrades
      // to null — the score is still written, same tolerance the old
      // Promise.allSettled path had.
      const predictAcceptanceBounded = async (
        group: ToScore[],
      ): Promise<Map<string, Awaited<ReturnType<typeof predictAcceptance>> | null>> => {
        const out = new Map<string, Awaited<ReturnType<typeof predictAcceptance>> | null>();
        for (let j = 0; j < group.length; j += ACCEPTANCE_CONCURRENCY) {
          const sub = group.slice(j, j + ACCEPTANCE_CONCURRENCY);
          const settled = await Promise.all(sub.map((g) =>
            predictAcceptance(g.scoreText, parsedRole, salary, { orgId: auth.orgId, userId: auth.userId })
              .then((a) => [g.id, a] as const)
              .catch(() => [g.id, null] as const),
          ));
          for (const [cid, a] of settled) out.set(cid, a);
        }
        return out;
      };

      // ─── PASS 2: score in outer groups (M1 — batched) ─────────────────────
      for (let i = 0; i < toScore.length; i += BATCH_GROUP_SIZE) {
        if (cappedHit) break;
        if (await evaluateSpendCap()) break;
        const group = toScore.slice(i, i + BATCH_GROUP_SIZE);
        const inputs: BatchScoreInput[] = group.map((g) => ({ candidateId: g.id, profileText: g.scoreText }));

        // scoreCandidatesBatch chunks the group internally at SCORE_BATCH_SIZE (5),
        // sharing the cached system block + per-role context across each batch (the
        // ~5:1 scoring-call cut). It never THROWS on an AI failure — it returns
        // deterministic stub breakdowns. Acceptance runs concurrently, bounded.
        const [batchResults, acceptances] = await Promise.all([
          scoreCandidatesBatch(inputs, parsedRole, salary, weights, auth.orgId, recruiterContext)
            .catch((err) => {
              reportError(err, { route: "score-all:batch", jobId: id, orgId: auth.orgId });
              return null;
            }),
          predictAcceptanceBounded(group),
        ]);

        // OUTAGE GUARD. Because the batch returns stubs (not throws) on a provider
        // outage, persisting them with the cache key would PERMANENTLY cache stub
        // scores (skipped on every future non-force run). chat.ts records each
        // Claude failure in provider-health, and a credit-out is FATAL
        // (consecutiveFailures→"down"), so "claude down" right after the batch means
        // these are outage stubs. Flag them re-scoreable (NO cache key) + surface
        // "AI unavailable" — the same outcome as the old per-candidate outage path —
        // and stop (no point continuing while Claude is down).
        const claudeDown = deriveProviderState("claude", providerHealth.claude) === "down";
        if (batchResults === null || claudeDown) {
          for (const g of group) {
            failed.push(g.id);
            providerOutageFails++;
            const current = await prisma.candidate.findUnique({
              where: { id: g.id },
              select: { screeningData: true },
            }).catch(() => null);
            await prisma.candidate.updateMany({
              where: { id: g.id },
              data: {
                matchScore: null,
                screeningData: mergeScoringError(current?.screeningData ?? null, "AI scoring unavailable (provider outage) — re-score when restored."),
              },
            }).catch((flagErr) => {
              reportError(flagErr, { route: "score-all:flag-outage", jobId: id, orgId: auth.orgId, candidateId: g.id });
            });
            send({ scored, cached, queued, total });
          }
          break;
        }

        const breakdownById = new Map(batchResults.map((r) => [r.candidateId, r.breakdown]));
        for (const g of group) {
          const raw = breakdownById.get(g.id);
          if (!raw) {
            // Defensive: scoreCandidatesBatch returns one entry per input, but if a
            // candidate is ever missing, flag it (re-scoreable) rather than drop it.
            failed.push(g.id);
            send({ scored, cached, queued, total });
            continue;
          }
          const breakdown = applyLocationFitOverride(
            raw,
            g.location,
            getJobTargetLocation(job, parsedRole),
            parsedRole.location_rules,
            job.isRemote,
            weights,
          );
          const acceptance = acceptances.get(g.id) ?? null;
          try {
            await prisma.candidate.update({
              where: { id: g.id },
              data: {
                ...deriveUpdateData(breakdown),
                profileTextHash: g.cacheKey,
                ...(acceptance && {
                  acceptanceScore: acceptance.score,
                  acceptanceReason: JSON.stringify(acceptance),
                }),
              },
            });
            scored++;
          } catch (err) {
            reportError(err, { route: "score-all:write", jobId: id, orgId: auth.orgId, candidateId: g.id });
            failed.push(g.id);
          }
          send({ scored, cached, queued, total });
        }
      }

      // Final message signals completion to the client, including any failures.
      const finalMsg: Record<string, unknown> = { scored, cached, queued, total, done: true };
      if (cappedHit) finalMsg.capped = true;
      if (failed.length > 0) finalMsg.failedIds = failed;
      // Provider-outage summary: if NOTHING succeeded (no scores, no cache hits,
      // no offloads) and EVERY failure was an all-providers-down error, this was
      // a Claude/Ollama outage, not bad candidate data. Surface a single clear
      // message so the recruiter retries later instead of distrusting the rows.
      if (
        failed.length > 0 &&
        providerOutageFails === failed.length &&
        scored === 0 &&
        cached === 0 &&
        queued === 0
      ) {
        finalMsg.aiUnavailable = true;
        finalMsg.message = "AI scoring unavailable (Claude out of credits)";
      }
      send(finalMsg);
      controller.close();

      console.log(`[score-all] scored=${scored} cached=${cached} queued=${queued} of ${total}`);
      void recordUsage(auth.orgId, auth.userId, "score_all", { jobId: id, scored, cached });
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
