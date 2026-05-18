import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { safeParseJson } from "@/lib/utils";
import { normaliseLinkedInUrl } from "@/lib/linkedin";
import { getAuth, requireCandidateAccess, unauthorized } from "@/lib/session";
import type { ScoreBreakdown } from "@/lib/scoring";

const VALID_STATUSES = [
  "new", "reviewing", "shortlisted", "contacted",
  "interviewing", "offer_sent", "hired", "declined", "rejected",
] as const;

// Reject anything that isn't an http(s) URL. Zod's `.url()` permits
// javascript:/data:/vbscript: schemes — those land in an <a href> and
// execute on click. Belt-and-braces: also gated at the renderer.
const httpsHttpUrl = z
  .string()
  .url()
  .max(500)
  .refine((v) => /^https?:\/\//i.test(v), { message: "Must be an http(s) URL" });

const PatchCandidateSchema = z.object({
  status:        z.enum(VALID_STATUSES).optional(),
  notes:         z.string().max(10_000).optional(),
  name:          z.string().min(1).max(200).trim().optional(),
  headline:      z.string().max(500).trim().optional(),
  location:      z.string().max(200).trim().optional(),
  linkedinUrl:   httpsHttpUrl.optional().or(z.literal("")),
  jobAdderUrl:   httpsHttpUrl.optional().or(z.literal("")),
  screeningData:   z.string().optional(), // JSON string
  interviewNotes:  z.string().optional(), // JSON string
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; candidateId: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id, candidateId } = await params;
  const { error } = await requireCandidateAccess(id, candidateId, auth);
  if (error) return error;
  const result = PatchCandidateSchema.safeParse(await req.json().catch(() => ({})));
  if (!result.success) {
    return NextResponse.json({ error: result.error.flatten() }, { status: 422 });
  }
  const body = result.data;
  const linkedinUrl = body.linkedinUrl !== undefined
    ? body.linkedinUrl ? normaliseLinkedInUrl(body.linkedinUrl) : null
    : undefined;

  // Build base update
  const data: Record<string, unknown> = {
    ...(body.notes         !== undefined && { notes: body.notes }),
    ...(body.name          !== undefined && { name: body.name }),
    ...(body.headline      !== undefined && { headline: body.headline }),
    ...(body.location      !== undefined && { location: body.location }),
    ...(linkedinUrl        !== undefined && { linkedinUrl }),
    ...(body.jobAdderUrl   !== undefined && { jobAdderUrl: body.jobAdderUrl || null }),
    ...(body.screeningData  !== undefined && { screeningData: body.screeningData }),
    ...(body.interviewNotes !== undefined && { interviewNotes: body.interviewNotes }),
  };

  // If status is changing, append to history and track contactedAt. The read
  // (existing.statusHistory) and the write (data.statusHistory =
  // JSON.stringify(history)) must run in a single transaction or two
  // concurrent PATCHes can both read the same prior history and clobber each
  // other's appended event. Serializable isolation prevents the lost-update.
  if (body.status !== undefined) {
    const candidate = await prisma.$transaction(
      async (tx) => {
        const existing = await tx.candidate.findUnique({
          where: { id: candidateId },
          select: { status: true, statusHistory: true, contactedAt: true },
        });

        const txData: Record<string, unknown> = { ...data, status: body.status };

        if (existing && body.status !== existing.status) {
          const history = safeParseJson<Array<{ status: string; changedAt: string }>>(
            existing.statusHistory,
            []
          );
          history.push({ status: body.status!, changedAt: new Date().toISOString() });
          txData.statusHistory = JSON.stringify(history);

          if (body.status === "contacted" && !existing.contactedAt) {
            txData.contactedAt = new Date();
          }
        }

        return tx.candidate.update({ where: { id: candidateId }, data: txData });
      },
      { isolationLevel: "Serializable" }
    );

    // Fire-and-forget placement memory recording for terminal statuses.
    const TERMINAL = new Set(["hired", "rejected", "declined"]);
    if (body.status && TERMINAL.has(body.status) && auth.orgId) {
      recordArchetypePlacement(candidate.id, id, auth.orgId, body.status).catch((e) =>
        console.warn("[archetype] placement record failed:", e instanceof Error ? e.message : e)
      );
    }

    return NextResponse.json(candidate);
  }

  const candidate = await prisma.candidate.update({
    where: { id: candidateId },
    data,
  });

  return NextResponse.json(candidate);
}

// ── Archetype placement memory ─────────────────────────────────────────────
// Called asynchronously after a terminal status change. Computes the
// candidate's career fingerprint and writes an ArchetypePlacement record
// so the clustering engine can learn from this outcome.
async function recordArchetypePlacement(
  candidateId: string,
  jobId: string,
  orgId: string,
  finalStatus: string
): Promise<void> {
  const [candidate, job] = await Promise.all([
    prisma.candidate.findUnique({
      where: { id: candidateId },
      select: { profileText: true, matchScore: true, acceptanceScore: true, scoreBreakdown: true },
    }),
    prisma.job.findUnique({
      where: { id: jobId },
      select: { title: true, parsedRole: true },
    }),
  ]);

  if (!candidate?.profileText || !job) return;

  const { computeFingerprint } = await import("@/lib/archetype/fingerprint");
  const fingerprint = computeFingerprint(candidate.profileText);
  if (fingerprint.skillVector.length === 0) return;

  const outcomeCategory = finalStatus === "hired" ? "success" : "failure";

  let roleMustHaves: string[] = [];
  if (job.parsedRole) {
    const parsed = safeParseJson<{ must_haves?: string[] } | null>(job.parsedRole, null);
    roleMustHaves = parsed?.must_haves ?? [];
  }

  // Track recruiter correction: compare matchScore to AI's must_have_pct
  let recruiterCorrection: number | null = null;
  if (candidate.scoreBreakdown && candidate.matchScore !== null) {
    const bd = safeParseJson<ScoreBreakdown | null>(candidate.scoreBreakdown, null);
    if (bd) {
      const aiScore = Math.round(bd.overall);
      recruiterCorrection = candidate.matchScore - aiScore;
    }
  }

  await prisma.archetypePlacement.create({
    data: {
      orgId,
      candidateId,
      jobId,
      fingerprintVector: JSON.stringify(fingerprint.skillVector),
      finalStatus,
      outcomeCategory,
      roleTitle: job.title,
      roleMustHaves: JSON.stringify(roleMustHaves),
      matchScore: candidate.matchScore ?? 0,
      acceptanceScore: candidate.acceptanceScore,
      recruiterCorrection,
    },
  });

  // Also upsert the candidate's fingerprint record
  await prisma.candidateFingerprint.upsert({
    where: { candidateId },
    create: {
      candidateId,
      orgId,
      skillVector: JSON.stringify(fingerprint.skillVector),
      trajectory: fingerprint.trajectory,
      avgTenureMonths: fingerprint.avgTenureMonths,
      stabilityScore: fingerprint.stabilityScore,
      domainClusters: JSON.stringify(fingerprint.domainClusters),
      seniorityLevel: fingerprint.seniorityLevel,
    },
    update: {
      skillVector: JSON.stringify(fingerprint.skillVector),
      trajectory: fingerprint.trajectory,
      avgTenureMonths: fingerprint.avgTenureMonths,
      stabilityScore: fingerprint.stabilityScore,
      domainClusters: JSON.stringify(fingerprint.domainClusters),
      seniorityLevel: fingerprint.seniorityLevel,
      version: { increment: 1 },
      computedAt: new Date(),
    },
  });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; candidateId: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id, candidateId } = await params;
  const { error } = await requireCandidateAccess(id, candidateId, auth);
  if (error) return error;
  await prisma.candidate.delete({ where: { id: candidateId } });
  return NextResponse.json({ ok: true });
}
