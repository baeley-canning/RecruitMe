import { prisma } from "@/lib/db";
import { scoreCandidateStructured, predictAcceptance } from "@/lib/ai";
import type { ParsedRole } from "@/lib/ai";
import { applyLocationFitOverride, deriveUpdateData } from "@/lib/score-utils";
import { getJobTargetLocation } from "@/lib/job-target-location";
import { getAuth, requireJobAccess, unauthorized } from "@/lib/session";
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

const CONCURRENCY = 3;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;

  // ?onlyUnscored=1 — scope the score-all run to candidates that haven't been
  // AI-scored yet. Library-import callers pass this so freshly-imported pool
  // candidates get scored without re-rescoring the LinkedIn cohort.
  const url = new URL(req.url);
  const onlyUnscored = url.searchParams.get("onlyUnscored") === "1";

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
      profileText: { not: null },
      ...(onlyUnscored ? { matchScore: null } : {}),
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
      profileText: { not: null },
      ...(onlyUnscored ? { matchScore: null } : {}),
    },
    select: {
      id: true,
      profileText: true,
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
  const failed: string[] = [];
  const encoder = new TextEncoder();

  // Stream progress as newline-delimited JSON so the client can show a live counter.
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) =>
        controller.enqueue(encoder.encode(JSON.stringify(data) + "\n"));

      // Send total upfront so the client can show "0 of N" immediately.
      send({ scored: 0, total });

      // Mid-loop spend-cap re-check cadence. The cap was checked once before
      // we started — but with 11k+ candidates now scoreable in any org's
      // library, a single bad run could blow past the cap before completing.
      //
      // The check runs at TWO cadences:
      //   (1) Before every CONCURRENCY-wide chunk fires (concurrency boundary).
      //       This is the precise gate: when the cap is tripped we abort
      //       BEFORE the chunk's API calls are dispatched, so at most
      //       CONCURRENCY (currently 3) calls land over the cap, not 25.
      //   (2) Every SPEND_CHECK_EVERY candidates as a coarser backstop —
      //       same logging cadence as before, kept so the abort message
      //       still surfaces with a known periodic count if the per-chunk
      //       check were ever bypassed (e.g. when CONCURRENCY === 1 and an
      //       individual call is unusually expensive).
      let cappedHit = false;
      const SPEND_CHECK_EVERY = 25;
      let sinceLastCapCheck = 0;

      const evaluateSpendCap = async (): Promise<boolean> => {
        const midSpend = await checkSpendCap(auth.orgId);
        if (!midSpend.allowed) {
          cappedHit = true;
          send({
            scored, cached, total,
            capped: true,
            spentUsd: midSpend.spentUsd,
            capUsd: midSpend.capUsd,
            error: `Daily AI spend cap reached mid-run ($${midSpend.spentUsd.toFixed(2)} / $${midSpend.capUsd.toFixed(2)}). Run again tomorrow or raise AI_DAILY_SPEND_CAP_USD.`,
          });
          return true;
        }
        return false;
      };

      for (let i = 0; i < candidates.length; i += CONCURRENCY) {
        if (cappedHit) break;
        // Per-chunk pre-flight cap check. The previous code only checked
        // every 25 candidates AFTER the chunk completed, so a chunk of
        // CONCURRENCY API calls straddling the cap could be billed in full
        // before cappedHit flipped. The 25-wide post-chunk check below
        // stays in as a coarser backstop / logging cadence.
        if (i > 0 && await evaluateSpendCap()) break;
        const chunk = candidates.slice(i, i + CONCURRENCY);
        await Promise.all(
          chunk.map(async (candidate) => {
            if (!candidate.profileText || candidate.profileText.trim().length < 100) return;

            const scoreCacheKey = buildScoreCacheKey({
              profileText: candidate.profileText,
              parsedRole,
              salary,
              jobLocation: job.location,
              jobLocation2: job.location2,
              isRemote: job.isRemote,
              weights,
              correctionsVersion,
            });

            // Cache hit: profile text + role + salary + location + weights
            // all match what was previously scored. Skip the API call
            // entirely. Saves Sonnet/Haiku tokens on every re-pull of a
            // candidate that hasn't materially changed. Only writes the
            // hash + matchScore are already present — if the candidate has
            // a stored hash but no score (rare), fall through and rescore.
            if (
              candidate.profileTextHash === scoreCacheKey &&
              candidate.matchScore !== null &&
              candidate.scoreBreakdown
            ) {
              cached++;
              send({ scored, cached, total });
              return;
            }

            try {
              // No withRetry wrapper here — scoreCandidateStructured /
              // predictAcceptance already route through chatWithFailover,
              // which retries internally (primary → secondary). Stacking
              // a 3-attempt withRetry on top means a single Claude
              // outage triggers up to 6 API calls per candidate
              // (3 × Claude + 3 × Ollama) instead of 2.
              const [rawBreakdown, acceptanceResult] = await Promise.allSettled([
                scoreCandidateStructured(candidate.profileText!, parsedRole, salary, weights, auth.orgId, recruiterContext),
                predictAcceptance(candidate.profileText!, parsedRole, salary),
              ]);
              if (rawBreakdown.status === "rejected") throw rawBreakdown.reason;
              const breakdown = applyLocationFitOverride(
                rawBreakdown.value,
                candidate.location,
                getJobTargetLocation(job, parsedRole),
                parsedRole.location_rules,
                job.isRemote,
                weights,
              );
              const acceptance = acceptanceResult.status === "fulfilled" ? acceptanceResult.value : null;
              await prisma.candidate.update({
                where: { id: candidate.id },
                data: {
                  ...deriveUpdateData(breakdown),
                  profileTextHash: scoreCacheKey,
                  ...(acceptance && {
                    acceptanceScore: acceptance.score,
                    acceptanceReason: JSON.stringify(acceptance),
                  }),
                },
              });
              scored++;
              send({ scored, cached, total });
            } catch (err) {
              reportError(err, { route: "score-all", jobId: id, orgId: auth.orgId, candidateId: candidate.id });
              failed.push(candidate.id);
              // Surface the failure on the candidate row so the recruiter
              // sees "scoring blew up" on each failed card rather than
              // "Scored 0" with no per-candidate trail. updateMany scoped
              // to this candidate id keeps the write non-destructive even
              // if the row was deleted mid-run; read existing screeningData
              // first so we merge instead of clobbering recruiter notes.
              const reason = err instanceof Error ? err.message : String(err);
              const current = await prisma.candidate.findUnique({
                where: { id: candidate.id },
                select: { screeningData: true },
              }).catch(() => null);
              await prisma.candidate.updateMany({
                where: { id: candidate.id },
                data: {
                  matchScore: null,
                  screeningData: mergeScoringError(current?.screeningData ?? null, reason),
                },
              }).catch((flagErr) => {
                reportError(flagErr, { route: "score-all:flag-failure", jobId: id, orgId: auth.orgId, candidateId: candidate.id });
              });
            }
          })
        );

        // Periodically re-verify the spend cap. The pre-chunk check above
        // catches most cases; this 25-wide post-chunk check is the coarser
        // backstop kept for log cadence and as a safety net.
        sinceLastCapCheck += chunk.length;
        if (sinceLastCapCheck >= SPEND_CHECK_EVERY) {
          sinceLastCapCheck = 0;
          await evaluateSpendCap();
          // break out of the outer for-loop via the cappedHit guard
        }
      }

      // Final message signals completion to the client, including any failures.
      const finalMsg: Record<string, unknown> = { scored, cached, total, done: true };
      if (cappedHit) finalMsg.capped = true;
      if (failed.length > 0) finalMsg.failedIds = failed;
      send(finalMsg);
      controller.close();

      console.log(`[score-all] scored=${scored} cached=${cached} of ${total}`);
      void recordUsage(auth.orgId, auth.userId, "score_all", { jobId: id, scored, cached });
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
