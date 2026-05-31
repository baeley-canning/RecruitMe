import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { scoreCandidateStructured, predictAcceptance, buildScorePrompt } from "@/lib/ai";
import type { ParsedRole } from "@/lib/ai";
import { AllProvidersFailedError } from "@/lib/ai/chat-with-failover";
import { applyLocationFitOverride, deriveUpdateData } from "@/lib/score-utils";
import { getJobTargetLocation } from "@/lib/job-target-location";
import { getAuth, requireCandidateAccess, unauthorized } from "@/lib/session";
import { buildScoreCacheKey, safeParseJson } from "@/lib/utils";
import { getJobScoringWeights } from "@/lib/scoring-config";
import { getCorrectionsVersion, getRecruitingContext } from "@/lib/recruiter-memory";
import { shouldRejectAsOverseas } from "@/lib/location";
import { checkRateLimit, checkSpendCap } from "@/lib/usage";
import { isLlamaScoreOffloadEnabled } from "@/lib/feature-flags";
import { enqueueScoreJob } from "@/lib/scrape-queue";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; candidateId: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id, candidateId } = await params;
  const { job, candidate, error } = await requireCandidateAccess(id, candidateId, auth);
  if (error || !job || !candidate) return error;
  if (!job.parsedRole) {
    return NextResponse.json({ error: "Job has not been parsed yet." }, { status: 400 });
  }
  if (!candidate.profileText) {
    return NextResponse.json({ error: "Candidate has no profile text to score against." }, { status: 400 });
  }

  // Per-event rate-limit + daily spend cap. Single-candidate score was
  // previously unguarded — a recruiter could mash the button repeatedly
  // and bypass score-all's caps. This route fires 2 Claude calls per
  // request (structured score + acceptance prediction).
  const rate = await checkRateLimit(auth.orgId, "score");
  if (!rate.allowed) {
    const waitMin = Math.ceil((rate.retryAfterMs ?? 60_000) / 60_000);
    return NextResponse.json({ error: `Score rate limit reached. Try again in ~${waitMin} minute${waitMin !== 1 ? "s" : ""}.` }, { status: 429 });
  }
  const spend = await checkSpendCap(auth.orgId);
  if (!spend.allowed) {
    return NextResponse.json({
      error: `Daily AI spend cap reached ($${spend.spentUsd.toFixed(2)} / $${spend.capUsd.toFixed(2)}). Try again tomorrow or raise AI_DAILY_SPEND_CAP_USD.`,
    }, { status: 429 });
  }

  try {
    const parsedRole = safeParseJson<ParsedRole | null>(job.parsedRole, null);
    if (!parsedRole) {
      return NextResponse.json({ error: "Job parse data is invalid. Parse the job description again." }, { status: 400 });
    }
    const salary = (job.salaryMin || job.salaryMax)
      ? { min: job.salaryMin ?? 0, max: job.salaryMax ?? 0 }
      : null;
    const weights = await getJobScoringWeights(job.scoringWeights, auth.orgId);
    const correctionsVersion = await getCorrectionsVersion(auth.orgId);

    // Cache hit: profile text + role + salary + location + weights all
    // match what was previously scored. Skip the API call entirely and
    // return the existing record. This is what makes re-pulling a
    // library candidate against the same job cost-free.
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
    if (
      candidate.profileTextHash === scoreCacheKey &&
      candidate.matchScore !== null &&
      candidate.scoreBreakdown
    ) {
      console.log(`[score] cache hit for candidate=${candidateId} — skipping API`);
      return NextResponse.json(candidate);
    }

    // No withRetry wrapper — scoreCandidateStructured / predictAcceptance
    // both route through chatWithFailover, which already attempts the
    // secondary provider (the local Ollama model) on any Claude error.
    // Stacking a 3-attempt retry on top would mean a single Claude outage
    // burns up to 6 API calls per Re-score click (3 × Claude + 3 ×
    // Ollama). The failover wrapper is the resilience layer; one primary
    // attempt + one secondary attempt is enough.
    const [rawBreakdown, acceptanceResult] = await Promise.allSettled([
      scoreCandidateStructured(candidate.profileText!, parsedRole, salary, weights, auth.orgId),
      predictAcceptance(candidate.profileText!, parsedRole, salary),
    ]);

    if (rawBreakdown.status === "rejected") {
      // Offload path: Claude is out AND the local Ollama-on-Railway is
      // unreachable (AllProvidersFailedError). When the offload flag is on,
      // hand the scoring prompt to the mini-PC box (which has its own local
      // Ollama) instead of failing the recruiter's click. Railway builds the
      // prompt + finalizes the box's raw text later (PATCH /api/scraper/jobs).
      // Flag OFF → fall through to the original rethrow → 500 (unchanged).
      if (rawBreakdown.reason instanceof AllProvidersFailedError && isLlamaScoreOffloadEnabled() && auth.orgId) {
        // Resolve recruiter context the same way scoreCandidateStructured
        // would have, so the offloaded prompt is identical to what Claude
        // would have received.
        const recruiterContext = await getRecruitingContext(parsedRole, auth.orgId).catch(() => "");
        const built = buildScorePrompt(candidate.profileText!, parsedRole, salary, weights, recruiterContext ?? "", auth.orgId);
        if (built.kind === "stub") {
          // Stage-1 gate produced a deterministic stub — no model needed. Score
          // it locally (no offload) so the recruiter still gets a number.
          const breakdown = applyLocationFitOverride(
            built.breakdown,
            candidate.location,
            getJobTargetLocation(job, parsedRole),
            parsedRole.location_rules,
            job.isRemote,
            weights,
          );
          await prisma.candidate.updateMany({
            where: { id: candidateId, profileTextHash: candidate.profileTextHash ?? null },
            data: { ...deriveUpdateData(breakdown), profileTextHash: scoreCacheKey },
          });
          return NextResponse.json(await prisma.candidate.findUnique({ where: { id: candidateId } }));
        }
        await enqueueScoreJob({
          orgId: auth.orgId,
          candidateId,
          scorePayload: {
            system: built.system,
            prompt: built.userPrompt,
            temperature: built.temperature,
            maxTokens: built.maxTokens,
            finalizeCtx: built.finalizeCtx,
          },
        });
        return NextResponse.json(
          { queued: true, message: "Claude unavailable — queued for the local model; check back shortly." },
          { status: 202 },
        );
      }
      throw rawBreakdown.reason;
    }

    const breakdown = applyLocationFitOverride(
      rawBreakdown.value,
      candidate.location,
      getJobTargetLocation(job, parsedRole),
      parsedRole.location_rules,
      job.isRemote,
      weights,
    );

    const acceptanceData = acceptanceResult.status === "fulfilled" ? acceptanceResult.value : null;

    // Country gate runs on every re-score. Two cases:
    // (a) Re-score reveals an overseas signal that wasn't visible before
    //     (profile updated, recruiter pasted new text) — auto-reject.
    // (b) Re-score on a candidate that was previously auto-rejected as
    //     overseas now passes the gate (e.g. recruiter corrected the
    //     location field) — un-reject by setting status back to "new".
    // We never overwrite manual progress (shortlisted / contacted / hired
    // / declined) — those are recruiter intent and stay put.
    const overseas = shouldRejectAsOverseas({
      explicitLocation: candidate.location,
      headline: candidate.headline,
      profileText: candidate.profileText,
      isRemote: job.isRemote,
    });
    let nextStatus: string | undefined;
    if (overseas.reject && ["new", "reviewing"].includes(candidate.status)) {
      nextStatus = "rejected";
    } else if (!overseas.reject && candidate.status === "rejected") {
      // Recovery path: previously auto-rejected, now passes gate.
      nextStatus = "new";
    }

    // Main score+cache write, plus optional status flip. Two concurrency
    // guards stack here:
    //
    //   (a) profileTextHash gate: only write if the row still carries the
    //       hash it had when we read it. A concurrent scorer (extension
    //       capture stage 2, score-all run, another re-score click) that
    //       landed first will have advanced the hash to its own
    //       scoreCacheKey — our older score must NOT overwrite it.
    //
    //   (b) status gate (only when we want to flip status): only write
    //       the status flip if the row is still in the right pre-flip
    //       status. If the recruiter moved them to shortlisted/contacted/
    //       etc. between read and write, we keep their manual choice and
    //       write the score without the status change.
    //
    // `count === 0` from the hash-gated write means another writer won.
    // We log and return the row as-is rather than erroring — the user's
    // re-score click effectively no-ops because a fresher score is
    // already in place.
    const oldHash = candidate.profileTextHash ?? null;
    const baseData = {
      ...deriveUpdateData(breakdown),
      profileTextHash: scoreCacheKey,
      ...(acceptanceData && {
        acceptanceScore: acceptanceData.score,
        acceptanceReason: JSON.stringify(acceptanceData),
      }),
    };
    let updated;
    if (nextStatus) {
      const allowed = nextStatus === "rejected" ? ["new", "reviewing"] : ["rejected"];
      const guarded = await prisma.candidate.updateMany({
        where: { id: candidateId, profileTextHash: oldHash, status: { in: allowed } },
        data: { ...baseData, status: nextStatus },
      });
      if (guarded.count === 0) {
        // Either the recruiter moved them OR a concurrent score landed.
        // Try again with just the hash gate (write score, leave status).
        const scoreOnly = await prisma.candidate.updateMany({
          where: { id: candidateId, profileTextHash: oldHash },
          data: baseData,
        });
        if (scoreOnly.count === 0) {
          console.log(`[score] concurrent writer won for candidate=${candidateId} — skipping stale score`);
        }
        updated = await prisma.candidate.findUnique({ where: { id: candidateId } });
      } else {
        updated = await prisma.candidate.findUnique({ where: { id: candidateId } });
      }
    } else {
      const guarded = await prisma.candidate.updateMany({
        where: { id: candidateId, profileTextHash: oldHash },
        data: baseData,
      });
      if (guarded.count === 0) {
        console.log(`[score] concurrent writer won for candidate=${candidateId} — skipping stale score`);
      }
      updated = await prisma.candidate.findUnique({ where: { id: candidateId } });
    }

    return NextResponse.json(updated);
  } catch (err) {
    // Graceful AI-down: Claude is out AND the local Ollama failover is
    // unreachable (AllProvidersFailedError), and the Llama offload branch
    // above did NOT handle it (flag off / null org → it rethrew here). This
    // is a provider outage, not a server bug — return a clean 503 the client
    // can render as a "temporarily unavailable" notice instead of a scary 500.
    // The flag-ON path returns 202 queued before reaching this catch, so it's
    // untouched.
    if (err instanceof AllProvidersFailedError) {
      return NextResponse.json(
        {
          error: "AI scoring is temporarily unavailable — Claude is out of credits and no local model is reachable. Try again later.",
          code: "ai_unavailable",
        },
        { status: 503 }
      );
    }
    const { reportError } = await import("@/lib/error-reporting");
    reportError(err, { route: "score:candidate", jobId: id, candidateId, orgId: auth.orgId });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Scoring failed" },
      { status: 500 }
    );
  }
}
