/**
 * PATCH /api/candidates/[id]/profile-text
 *
 * Manual override for cases where the LinkedIn extension capture is
 * incomplete (Brendan-class: extension grabbed only the current role,
 * historical work missing). Recruiter pastes the missing work history
 * into the candidate drawer, the row's profileText is replaced or
 * appended-to, and the candidate is re-scored against the current job.
 *
 * Modes:
 *   - "replace": new text becomes the entire profileText
 *   - "append":  new text concatenated to existing profileText with a
 *                clear separator
 *
 * Re-scoring is best-effort and runs synchronously so the response
 * carries the new score. If the role isn't parsed yet, we save the text
 * but skip the score (front-end shows the new text immediately).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized } from "@/lib/session";
import { scoreCandidateStructured } from "@/lib/ai";
import { applyLocationFitOverride, deriveUpdateData } from "@/lib/score-utils";
import { getJobTargetLocation } from "@/lib/job-target-location";
import { buildScoreCacheKey, safeParseJson } from "@/lib/utils";
import { scorerFingerprint } from "@/lib/ai/scorer-fingerprint";
import { getJobScoringWeights } from "@/lib/scoring-config";
import { checkRateLimit, checkSpendCap } from "@/lib/usage";
import type { ParsedRole } from "@/lib/ai";

// PATCH re-scores the candidate synchronously after a manual profile-text
// paste — scoreCandidateStructured can take 10-30s under load. 60s gives the
// chain enough room while still failing fast on a stuck Claude provider.
export const maxDuration = 60;

const PatchSchema = z.object({
  text: z
    .string()
    .min(1)
    .max(200_000)
    .refine((s) => s.trim().length > 0, "text cannot be whitespace-only"),
  mode: z.enum(["replace", "append"]).default("append"),
});

const APPEND_SEPARATOR = "\n\n--- ADDITIONAL WORK HISTORY (manual paste) ---\n\n";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;

  // Profile-text re-paste fires one scoreCandidateStructured call per PATCH.
  // Cheap on its own, but a recruiter pasting into 20 candidates in a row
  // bypasses the per-call cost gate everywhere else. Same per-org rate
  // limit + daily USD cap as score-all so the field can't be turned into
  // a no-limit re-scoring loop.
  const rateCheck = await checkRateLimit(auth.orgId, "score");
  if (!rateCheck.allowed) {
    const waitMin = Math.ceil((rateCheck.retryAfterMs ?? 60000) / 60000);
    return NextResponse.json({ error: `Scoring rate limit reached. Try again in ~${waitMin} minute${waitMin !== 1 ? "s" : ""}.` }, { status: 429 });
  }
  const spend = await checkSpendCap(auth.orgId);
  if (!spend.allowed) {
    return NextResponse.json({
      error: `Daily AI spend cap reached ($${spend.spentUsd.toFixed(2)} / $${spend.capUsd.toFixed(2)}). Try again tomorrow or raise AI_DAILY_SPEND_CAP_USD.`,
    }, { status: 429 });
  }

  const candidate = await prisma.candidate.findUnique({
    where: { id },
    include: {
      job: {
        select: {
          id: true, title: true, company: true, location: true, location2: true,
          isRemote: true, salaryMin: true, salaryMax: true,
          parsedRole: true, scoringWeights: true, orgId: true,
        },
      },
    },
  });
  if (!candidate) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const orgId = candidate.orgId ?? candidate.job?.orgId ?? null;
  if (!auth.isOwner && orgId !== auth.orgId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const parsed = PatchSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 });
  }
  const { text, mode } = parsed.data;

  // Race-safe append: re-read the candidate's current profileText INSIDE
  // a transaction so a concurrent edit from another recruiter doesn't get
  // silently overwritten. If two recruiters both append simultaneously,
  // both appends survive (one comes first, the second sees the merged
  // text and appends to it). Replace mode still wins-the-write last.
  const newProfileText = await prisma.$transaction(async (tx) => {
    const fresh = await tx.candidate.findUnique({
      where: { id },
      select: { profileText: true },
    });
    const existing = fresh?.profileText ?? candidate.profileText ?? "";
    const merged = mode === "replace" || !existing
      ? text.trim()
      : `${existing.trim()}${APPEND_SEPARATOR}${text.trim()}`;
    await tx.candidate.update({
      where: { id },
      data: {
        profileText: merged,
        profileTextHash: null,
        matchScore: null,
        matchReason: null,
        scoreBreakdown: null,
        acceptanceScore: null,
        acceptanceReason: null,
        profileCapturedAt: new Date(),
      },
    });
    return merged;
  });

  // Re-score against the candidate's current job, if there is one and it
  // has a parsed role. Otherwise just return — the candidate library
  // listing isn't tied to a single job.
  let scored = false;
  let newScore: number | null = null;
  const parsedRole = safeParseJson<ParsedRole | null>(candidate.job?.parsedRole ?? null, null);
  if (parsedRole && candidate.job) {
    try {
      const salary = (candidate.job.salaryMin || candidate.job.salaryMax)
        ? { min: candidate.job.salaryMin ?? 0, max: candidate.job.salaryMax ?? 0 }
        : null;
      const weights = await getJobScoringWeights(candidate.job.scoringWeights, auth.orgId);
      const rawBreakdown = await scoreCandidateStructured(
        newProfileText, parsedRole, salary, weights, auth.orgId,
      );
      const breakdown = applyLocationFitOverride(
        rawBreakdown,
        candidate.location,
        getJobTargetLocation(candidate.job, parsedRole),
        parsedRole.location_rules,
        candidate.job.isRemote,
        weights,
      );
      const scoreUpdates = deriveUpdateData(breakdown);
      scoreUpdates.profileTextHash = buildScoreCacheKey({
        profileText: newProfileText,
        parsedRole,
        salary,
        jobLocation: candidate.job.location,
        jobLocation2: candidate.job.location2,
        isRemote: candidate.job.isRemote,
        weights,
      scorerFingerprint: scorerFingerprint(),
    });
      await prisma.candidate.update({ where: { id }, data: scoreUpdates });
      scored = true;
      newScore = typeof scoreUpdates.matchScore === "number" ? scoreUpdates.matchScore : null;
    } catch (err) {
      console.warn(`[profile-text] re-score failed for candidate ${id}`, err);
      // Fall through — text is saved, score will retry on next manual re-score
    }
  }

  const fresh = await prisma.candidate.findUnique({ where: { id } });
  return NextResponse.json({
    candidate: fresh,
    scored,
    matchScore: newScore,
    profileTextLength: newProfileText.length,
  });
}
