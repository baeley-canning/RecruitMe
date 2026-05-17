import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { withJobAuth } from "@/lib/session";

// Aggregates the discovery → shortlist funnel for a single job.
// Surfaced/imported/rejected come from SearchSession (per-run telemetry).
// Fetched/scored/shortlisted/declined come from the live Candidate table.
export const GET = withJobAuth(async ({ params }) => {
  const id = params.id;
  // "fetched" used to scan every candidate's profileText (multi-KB column)
  // just to bool-check non-null. Push it to a count() so Postgres returns
  // an integer and we don't drag profile bodies across the wire on every
  // funnel render. The remaining buckets still need the per-row select for
  // status + matchScore aggregation.
  const [sessionAgg, candidateBuckets, fetched] = await Promise.all([
    prisma.searchSession.aggregate({
      where: { jobId: id, status: { not: "running" } },
      _sum: { totalExamined: true, candidatesRejected: true, collected: true },
      _count: { id: true },
    }),
    prisma.candidate.findMany({
      where: { jobId: id },
      select: { status: true, matchScore: true },
    }),
    prisma.candidate.count({
      where: { jobId: id, profileText: { not: null } },
    }),
  ]);

  const surfaced = sessionAgg._sum.totalExamined ?? 0;
  const filteredAtSource = sessionAgg._sum.candidatesRejected ?? 0;
  const imported = sessionAgg._sum.collected ?? 0;
  const searchRuns = sessionAgg._count.id;

  let scored = 0;
  let shortlisted = 0;
  let rejectedByRecruiter = 0;
  let scoreSum = 0;

  for (const c of candidateBuckets) {
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
});
