import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAuth, requireJobAccess, unauthorized } from "@/lib/session";

// Aggregates the discovery → shortlist funnel for a single job.
// Surfaced/imported/rejected come from SearchSession (per-run telemetry).
// Fetched/scored/shortlisted/declined come from the live Candidate table.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;

  const { error } = await requireJobAccess(id, auth);
  if (error) return error;

  const [sessionAgg, candidateBuckets] = await Promise.all([
    prisma.searchSession.aggregate({
      where: { jobId: id, status: { not: "running" } },
      _sum: { totalExamined: true, candidatesRejected: true, collected: true },
      _count: { id: true },
    }),
    prisma.candidate.findMany({
      where: { jobId: id },
      select: { status: true, profileText: true, matchScore: true },
    }),
  ]);

  const surfaced = sessionAgg._sum.totalExamined ?? 0;
  const filteredAtSource = sessionAgg._sum.candidatesRejected ?? 0;
  const imported = sessionAgg._sum.collected ?? 0;
  const searchRuns = sessionAgg._count.id;

  let fetched = 0;
  let scored = 0;
  let shortlisted = 0;
  let rejectedByRecruiter = 0;
  let scoreSum = 0;

  for (const c of candidateBuckets) {
    if (c.profileText) fetched++;
    if (c.matchScore !== null) {
      scored++;
      scoreSum += c.matchScore;
    }
    if (c.status === "shortlisted") shortlisted++;
    if (c.status === "rejected") rejectedByRecruiter++;
  }

  const totalCandidates = candidateBuckets.length;
  const avgScore = scored > 0 ? Math.round(scoreSum / scored) : null;

  return NextResponse.json({
    searchRuns,
    surfaced,
    filteredAtSource,
    imported,
    totalCandidates,
    fetched,
    scored,
    shortlisted,
    rejectedByRecruiter,
    avgScore,
  });
}
