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
import { buildScoreCacheKey, safeParseJson } from "@/lib/utils";
import { getJobScoringWeights } from "@/lib/scoring-config";
import type { ParsedRole } from "@/lib/ai";

const PatchSchema = z.object({
  text: z.string().min(1).max(200_000),
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

  const candidate = await prisma.candidate.findUnique({
    where: { id },
    include: {
      job: {
        select: {
          id: true, title: true, company: true, location: true,
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

  const newProfileText = mode === "replace" || !candidate.profileText
    ? text.trim()
    : `${candidate.profileText.trim()}${APPEND_SEPARATOR}${text.trim()}`;

  // First, save the new text. We'll attempt to re-score next; even if the
  // re-score fails the text is persisted so the recruiter can refresh and
  // see the update.
  const baseUpdates: Record<string, unknown> = {
    profileText: newProfileText,
    profileTextHash: null,
    matchScore: null,
    matchReason: null,
    scoreBreakdown: null,
    acceptanceScore: null,
    acceptanceReason: null,
    profileCapturedAt: new Date(),
  };

  await prisma.candidate.update({ where: { id }, data: baseUpdates });

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
        parsedRole.location ?? candidate.job.location ?? "",
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
        isRemote: candidate.job.isRemote,
        weights,
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
