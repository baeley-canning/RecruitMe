import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { scoreCandidateStructured, predictAcceptance } from "@/lib/ai";
import type { ParsedRole } from "@/lib/ai";
import { applyLocationFitOverride, deriveUpdateData } from "@/lib/score-utils";
import { getJobTargetLocation } from "@/lib/job-target-location";
import { getAuth, requireCandidateAccess, unauthorized } from "@/lib/session";
import { buildScoreCacheKey, safeParseJson } from "@/lib/utils";
import { getJobScoringWeights } from "@/lib/scoring-config";
import { shouldRejectAsOverseas } from "@/lib/location";

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

  try {
    const parsedRole = safeParseJson<ParsedRole | null>(job.parsedRole, null);
    if (!parsedRole) {
      return NextResponse.json({ error: "Job parse data is invalid. Parse the job description again." }, { status: 400 });
    }
    const salary = (job.salaryMin || job.salaryMax)
      ? { min: job.salaryMin ?? 0, max: job.salaryMax ?? 0 }
      : null;
    const weights = await getJobScoringWeights(job.scoringWeights, auth.orgId);

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
    // secondary provider (OpenAI) on any Claude error. Stacking a
    // 3-attempt retry on top would mean a single Claude outage burns
    // up to 6 paid API calls per Re-score click (3 × Claude + 3 ×
    // OpenAI). The failover wrapper is the resilience layer; one
    // primary attempt + one secondary attempt is enough.
    const [rawBreakdown, acceptanceResult] = await Promise.allSettled([
      scoreCandidateStructured(candidate.profileText!, parsedRole, salary, weights, auth.orgId),
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

    const updated = await prisma.candidate.update({
      where: { id: candidateId },
      data: {
        ...deriveUpdateData(breakdown),
        profileTextHash: scoreCacheKey,
        ...(acceptanceData && {
          acceptanceScore: acceptanceData.score,
          acceptanceReason: JSON.stringify(acceptanceData),
        }),
        ...(nextStatus ? { status: nextStatus } : {}),
      },
    });

    return NextResponse.json(updated);
  } catch (err) {
    const { reportError } = await import("@/lib/error-reporting");
    reportError(err, { route: "score:candidate", jobId: id, candidateId, orgId: auth.orgId });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Scoring failed" },
      { status: 500 }
    );
  }
}
