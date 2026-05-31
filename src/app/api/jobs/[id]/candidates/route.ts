import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { extractCandidateInfo, predictAcceptance, scoreCandidateStructured } from "@/lib/ai";
import type { ParsedRole } from "@/lib/ai";
import { applyLocationFitOverride, deriveUpdateData } from "@/lib/score-utils";
import { getJobTargetLocation } from "@/lib/job-target-location";
import { getAuth, requireJobAccess, unauthorized } from "@/lib/session";
import { buildScoreCacheKey, safeParseJson } from "@/lib/utils";
import { normaliseLinkedInUrl } from "@/lib/linkedin";
import { isSeekProfileUrl, normaliseSeekUrl } from "@/lib/seek";
import { getJobScoringWeights } from "@/lib/scoring-config";
import { shouldRejectAsOverseas } from "@/lib/location";
import { reportError } from "@/lib/error-reporting";
import { mergeScoringError } from "@/lib/linkedin-capture";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;
  const { error } = await requireJobAccess(id, auth);
  if (error) return error;
  const candidates = await prisma.candidate.findMany({
    where: { jobId: id },
    orderBy: [{ matchScore: "desc" }, { createdAt: "desc" }],
  });
  return NextResponse.json(candidates);
}

const CreateCandidateSchema = z.object({
  name:        z.string().min(1).max(200).trim().optional(),
  headline:    z.string().max(500).trim().optional(),
  location:    z.string().max(200).trim().optional(),
  linkedinUrl: z.string().url().max(500).optional().or(z.literal("")),
  // SEEK profile URL — optional; must be a real SEEK profile URL when present.
  seekUrl:     z.string().max(500).refine((v) => isSeekProfileUrl(v), { message: "Must be a valid SEEK profile URL" }).optional().or(z.literal("")),
  profileText: z.string().max(50_000).optional(),
  autoScore:   z.boolean().optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;
  try {
  const result = CreateCandidateSchema.safeParse(await req.json().catch(() => ({})));
  if (!result.success) {
    return NextResponse.json({ error: result.error.flatten() }, { status: 422 });
  }
  const body = result.data;
  const linkedinUrl = body.linkedinUrl ? normaliseLinkedInUrl(body.linkedinUrl) : null;
  const seekUrl = body.seekUrl ? normaliseSeekUrl(body.seekUrl) : null;

  const { job, error } = await requireJobAccess(id, auth);
  if (error || !job) return error;

  let name = body.name ?? "";
  let headline = body.headline ?? "";
  let location = body.location ?? "";

  if (body.profileText && !name) {
    try {
      const info = await extractCandidateInfo(body.profileText);
      name = info.name;
      headline = headline || info.headline;
      location = location || info.location;
    } catch {
      name = "Unknown";
    }
  }

  // Country gate: same `shouldRejectAsOverseas` helper used everywhere else,
  // so a recruiter who pastes a profile body that says "based in London"
  // gets the candidate auto-marked rejected even when the location field
  // wasn't provided. Row is preserved (recruiter can recover via pipeline),
  // they just don't pollute the active list.
  const overseas = shouldRejectAsOverseas({
    explicitLocation: location,
    headline,
    profileText: body.profileText,
    isRemote: job.isRemote,
  });
  const candidate = await prisma.candidate.create({
    data: {
      jobId: id,
      orgId: job.orgId ?? null,
      name: name || "Unknown",
      headline: headline || null,
      location: location || null,
      linkedinUrl,
      seekUrl,
      profileText: body.profileText?.trim() || null,
      source: "manual",
      status: overseas.reject ? "rejected" : "new",
    },
  });

  if (body.autoScore !== false && body.profileText && job.parsedRole) {
    const parsedRole = safeParseJson<ParsedRole | null>(job.parsedRole, null);
    if (!parsedRole) return NextResponse.json({ ...candidate, rejectedAsOverseas: overseas.reject ? overseas.evidence : undefined }, { status: 201 });
    const salary = (job.salaryMin || job.salaryMax)
      ? { min: job.salaryMin ?? 0, max: job.salaryMax ?? 0 }
      : null;
    const weights = await getJobScoringWeights(job.scoringWeights, auth.orgId);

    try {
      const rawBreakdown = await scoreCandidateStructured(body.profileText, parsedRole, salary, weights, auth.orgId);
      const breakdown = applyLocationFitOverride(
        rawBreakdown,
        location || null,
        getJobTargetLocation(job, parsedRole),
        parsedRole.location_rules,
        job.isRemote,
        weights,
      );
      const updateData: Record<string, unknown> = {
        ...deriveUpdateData(breakdown),
        profileTextHash: buildScoreCacheKey({
          profileText: body.profileText,
          parsedRole,
          salary,
          jobLocation: job.location,
          jobLocation2: job.location2,
          isRemote: job.isRemote,
          weights,
        }),
      };
      if (body.profileText.length >= 250) {
        const acceptance = await predictAcceptance(body.profileText, parsedRole, salary);
        updateData.acceptanceScore  = acceptance.score;
        updateData.acceptanceReason = JSON.stringify({
          likelihood: acceptance.likelihood,
          headline:   acceptance.headline,
          signals:    acceptance.signals,
          summary:    acceptance.summary,
        });
      }
      const updated = await prisma.candidate.update({
        where: { id: candidate.id },
        data: updateData,
      });
      return NextResponse.json({
        ...updated,
        rejectedAsOverseas: overseas.reject ? overseas.evidence : undefined,
      }, { status: 201 });
    } catch (err) {
      // Auto-score blew up. The candidate row already exists — flag the
      // failure on screeningData and leave matchScore null so the UI can
      // distinguish "imported, scoring failed" from "imported, not yet
      // scored". reportError gets the structured logs + Sentry trail.
      console.error("Auto-score failed:", err);
      reportError(err, { route: "candidates:post:auto-score", jobId: id, candidateId: candidate.id, orgId: auth.orgId });
      const reason = err instanceof Error ? err.message : String(err);
      await prisma.candidate.update({
        where: { id: candidate.id },
        data: {
          matchScore: null,
          screeningData: mergeScoringError(null, reason),
        },
      }).catch((updateErr) => {
        reportError(updateErr, { route: "candidates:post:auto-score-flag", jobId: id, candidateId: candidate.id, orgId: auth.orgId });
      });
    }
  }

  return NextResponse.json({
    ...candidate,
    rejectedAsOverseas: overseas.reject ? overseas.evidence : undefined,
  }, { status: 201 });
  } catch (err) {
    // P2002 = unique constraint violation. The only @@unique on Candidate is
    // (jobId, linkedinUrl), so this means the recruiter pasted a LinkedIn URL
    // that's already on this job. Surface a clear 409 instead of a bare 500.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json(
        { error: "A candidate with this LinkedIn URL is already on this job." },
        { status: 409 },
      );
    }
    reportError(err, { route: "candidates:post", jobId: id, orgId: auth.orgId });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to add candidate" },
      { status: 500 },
    );
  }
}
