import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getAuth, requireJobAccess, unauthorized } from "@/lib/session";
import { scoreCandidateStructured } from "@/lib/ai";
import type { ParsedRole } from "@/lib/ai";
import { applyLocationFitOverride, deriveUpdateData } from "@/lib/score-utils";
import { buildScoreCacheKey, safeParseJson } from "@/lib/utils";
import { getJobScoringWeights } from "@/lib/scoring-config";
import { normaliseLinkedInUrl } from "@/lib/linkedin";

const BodySchema = z.object({
  jobId:       z.string().min(1),
  login:       z.string().min(1),          // GitHub username (for dedup)
  name:        z.string().min(1),
  headline:    z.string().nullable().optional(),
  location:    z.string().nullable().optional(),
  githubUrl:   z.string().url(),
  linkedinUrl: z.string().url().nullable().optional(),
  profileText: z.string().min(50),         // pre-built by githubUserToProfileText()
});

export async function POST(req: Request) {
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 });
  }

  const { jobId, login, name, headline, location, githubUrl, linkedinUrl, profileText } = parsed.data;

  const { job, error } = await requireJobAccess(jobId, auth);
  if (error || !job) return error;

  // Deduplicate by GitHub URL stored in notes (simple but effective for now)
  // or by linkedinUrl if we have it.
  let cleanLinkedIn: string | null = null;
  try {
    cleanLinkedIn = linkedinUrl ? normaliseLinkedInUrl(linkedinUrl) : null;
  } catch {
    cleanLinkedIn = null;
  }

  if (cleanLinkedIn) {
    const existing = await prisma.candidate.findFirst({
      where: { jobId, linkedinUrl: cleanLinkedIn },
      select: { id: true },
    });
    if (existing) {
      return NextResponse.json({ error: "This candidate is already in the job.", alreadyExists: true }, { status: 409 });
    }
  }

  // Auto-score if the JD is parsed.
  const parsedRole = safeParseJson<ParsedRole | null>(job.parsedRole, null);
  const salary = (job.salaryMin || job.salaryMax)
    ? { min: job.salaryMin ?? 0, max: job.salaryMax ?? 0 }
    : null;

  let scoreData: Record<string, unknown> = {};
  if (parsedRole) {
    try {
      const weights   = await getJobScoringWeights(job.scoringWeights, auth.orgId);
      const breakdown = applyLocationFitOverride(
        await scoreCandidateStructured(profileText, parsedRole, salary, weights, auth.orgId),
        location ?? null,
        parsedRole.location ?? job.location ?? "",
        parsedRole.location_rules,
        job.isRemote,
        weights,
      );
      scoreData = {
        ...deriveUpdateData(breakdown),
        profileTextHash: buildScoreCacheKey({ profileText, parsedRole, salary, jobLocation: job.location, isRemote: job.isRemote }),
      };
    } catch {
      // Scoring failed — import without a score, recruiter can re-score manually
    }
  }

  // Surface a warning if the score is low — recruiter chose this person
  // deliberately so we don't block, but make the low match visible.
  const finalScore = scoreData.matchScore as number | null ?? null;
  const lowScoreWarning = finalScore !== null && finalScore < 40
    ? `Score is ${finalScore}% — this candidate may not match the role. Check the hiring brief.`
    : null;

  const candidate = await prisma.candidate.create({
    data: {
      jobId,
      orgId:      job.orgId ?? null,
      name,
      headline:   headline ?? null,
      location:   location ?? null,
      linkedinUrl: cleanLinkedIn ?? null,
      profileText,
      profileCapturedAt: new Date(),
      source:     "manual",
      status:     "new",
      // Store GitHub URL in notes so we can identify the source
      notes: `GitHub: ${githubUrl}\nLogin: ${login}`,
      ...scoreData,
    },
  });

  return NextResponse.json({ ...candidate, lowScoreWarning }, { status: 201 });
}
