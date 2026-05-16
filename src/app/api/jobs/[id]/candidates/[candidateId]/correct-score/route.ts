import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getAuth, requireCandidateAccess, unauthorized } from "@/lib/session";
import { safeParseJson } from "@/lib/utils";
import type { ParsedRole } from "@/lib/ai";

const CorrectScoreBodySchema = z.object({
  recruiterScore: z.number().int().min(0).max(100),
  reason: z.string().trim().max(500).optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; candidateId: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id, candidateId } = await params;

  const { job, candidate, error } = await requireCandidateAccess(id, candidateId, auth);
  if (error || !job || !candidate) return error;

  const parsed = CorrectScoreBodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", issues: parsed.error.issues },
      { status: 400 }
    );
  }
  const { recruiterScore: rawScore, reason } = parsed.data;
  const recruiterScore = Math.round(rawScore);

  // Capture the role title at correction time so future scoring runs can
  // match by role similarity (matches recruiter-memory's title-similarity logic).
  const parsedRole = safeParseJson<ParsedRole | null>(job.parsedRole, null);
  const roleTitle = parsedRole?.title ?? null;

  const correction = await prisma.scoreCorrection.create({
    data: {
      candidateId,
      jobId: id,
      orgId: candidate.orgId ?? job.orgId ?? null,
      originalScore: candidate.matchScore ?? 0,
      recruiterScore,
      reason: reason && reason.length > 0 ? reason : null,
      roleTitle,
    },
  });

  return NextResponse.json(correction);
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; candidateId: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id, candidateId } = await params;

  const { error } = await requireCandidateAccess(id, candidateId, auth);
  if (error) return error;

  const corrections = await prisma.scoreCorrection.findMany({
    where: { candidateId },
    orderBy: { createdAt: "desc" },
    select: { id: true, originalScore: true, recruiterScore: true, reason: true, createdAt: true },
  });

  return NextResponse.json(corrections);
}
