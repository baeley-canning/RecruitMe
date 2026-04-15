import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { scoreCandidateFull } from "@/lib/ai";
import type { ParsedRole } from "@/lib/ai";

const CONCURRENCY = 3; // parallel calls without hammering the API

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

  // Process in chunks to stay within rate limits
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const chunk = candidates.slice(i, i + CONCURRENCY);
    await Promise.all(
      chunk.map(async (candidate) => {
        if (!candidate.profileText) return;
        try {
          const { match, acceptance } = await scoreCandidateFull(candidate.profileText, parsedRole, salary);
          const updateData: Record<string, unknown> = {
            matchScore:  match.score,
            matchReason: JSON.stringify({
              summary:    match.summary,
              reasoning:  match.reasoning,
              dimensions: match.dimensions,
              strengths:  match.strengths,
              gaps:       match.gaps,
            }),
          };
          if (acceptance) {
            updateData.acceptanceScore  = acceptance.score;
            updateData.acceptanceReason = JSON.stringify({
              likelihood: acceptance.likelihood,
              headline:   acceptance.headline,
              signals:    acceptance.signals,
              summary:    acceptance.summary,
            });
          }
          await prisma.candidate.update({ where: { id: candidate.id }, data: updateData });
          scored++;
        } catch (err) {
          console.error(`Score failed for candidate ${candidate.id}:`, err);
        }
      })
    );
  }

  return NextResponse.json({ scored, total: candidates.length });
}
