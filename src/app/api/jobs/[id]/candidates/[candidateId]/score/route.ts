import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { scoreCandidateStructured } from "@/lib/ai";
import type { ParsedRole } from "@/lib/ai";
import { deriveUpdateData } from "@/lib/score-utils";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; candidateId: string }> }
) {
  const { id, candidateId } = await params;

  const [job, candidate] = await Promise.all([
    prisma.job.findUnique({ where: { id } }),
    prisma.candidate.findUnique({ where: { id: candidateId } }),
  ]);

  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  if (!candidate) return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
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

    const breakdown = await scoreCandidateStructured(candidate.profileText, parsedRole, salary);

    const updated = await prisma.candidate.update({
      where: { id: candidateId },
      data:  deriveUpdateData(breakdown),
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
