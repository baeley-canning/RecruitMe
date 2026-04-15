import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { scoreCandidateStructured } from "@/lib/ai";
import type { ParsedRole } from "@/lib/ai";
import { deriveUpdateData } from "@/lib/score-utils";

const CONCURRENCY = 3;

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const job = await prisma.job.findUnique({ where: { id } });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  if (!job.parsedRole) {
    return NextResponse.json({ error: "Parse the job description first." }, { status: 400 });
  }

  const candidates = await prisma.candidate.findMany({
    where: { jobId: id, profileText: { not: null } },
  });

  if (candidates.length === 0) {
    return NextResponse.json({ scored: 0, total: 0, message: "No candidates with profile text to score." });
  }

  const parsedRole = JSON.parse(job.parsedRole) as ParsedRole;
  const salary = (job.salaryMin || job.salaryMax)
    ? { min: job.salaryMin ?? 0, max: job.salaryMax ?? 0 }
    : null;

  let scored = 0;

  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const chunk = candidates.slice(i, i + CONCURRENCY);
    await Promise.all(
      chunk.map(async (candidate) => {
        if (!candidate.profileText) return;
        try {
          const breakdown = await scoreCandidateStructured(candidate.profileText, parsedRole, salary);
          await prisma.candidate.update({
            where: { id: candidate.id },
            data:  deriveUpdateData(breakdown),
          });
          scored++;
        } catch (err) {
          console.error(`Score failed for candidate ${candidate.id}:`, err);
        }
      })
    );
  }

  return NextResponse.json({ scored, total: candidates.length });
}
