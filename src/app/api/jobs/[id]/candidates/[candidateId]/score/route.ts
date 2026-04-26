import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { scoreCandidateStructured, predictAcceptance } from "@/lib/ai";
import type { ParsedRole } from "@/lib/ai";
import { applyLocationFitOverride, deriveUpdateData } from "@/lib/score-utils";
import { getAuth, requireCandidateAccess, unauthorized } from "@/lib/session";

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
    const parsedRole = JSON.parse(job.parsedRole) as ParsedRole;
    const salary = (job.salaryMin || job.salaryMax)
      ? { min: job.salaryMin ?? 0, max: job.salaryMax ?? 0 }
      : null;

    const [rawBreakdown, acceptance] = await Promise.all([
      scoreCandidateStructured(candidate.profileText, parsedRole, salary),
      predictAcceptance(candidate.profileText, parsedRole, salary),
    ]);
    const breakdown = applyLocationFitOverride(
      rawBreakdown,
      candidate.location,
      parsedRole.location,
      parsedRole.location_rules,
      job.isRemote,
    );

    const updated = await prisma.candidate.update({
      where: { id: candidateId },
      data: {
        ...deriveUpdateData(breakdown),
        acceptanceScore: acceptance.score,
        acceptanceReason: JSON.stringify(acceptance),
      },
    });

    return NextResponse.json(updated);
  } catch (err) {
    console.error("Score error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Scoring failed" },
      { status: 500 }
    );
  }
}
