import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { withAuth } from "@/lib/session";

// Lists every score correction the recruiter's org has logged. These corrections
// are injected into future scoring prompts as calibration examples — recruiters
// need a way to see what's biasing their scores, and remove individual entries
// when their thinking has changed.
export const GET = withAuth(async ({ auth }) => {
  // ScoreCorrection has jobId but no `job` relation in the schema; fetch the
  // job titles separately so the UI can show "for [Role]" without a join.
  const corrections = await prisma.scoreCorrection.findMany({
    where: auth.isOwner ? {} : { orgId: auth.orgId },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      id: true,
      candidateId: true,
      candidate: { select: { name: true, headline: true } },
      jobId: true,
      originalScore: true,
      recruiterScore: true,
      reason: true,
      roleTitle: true,
      createdAt: true,
    },
  });
  const jobIds = [...new Set(corrections.map((c) => c.jobId).filter((id): id is string => Boolean(id)))];
  const jobs = jobIds.length === 0
    ? []
    : await prisma.job.findMany({ where: { id: { in: jobIds } }, select: { id: true, title: true } });
  const jobTitleById = new Map(jobs.map((j) => [j.id, j.title]));
  return NextResponse.json(
    corrections.map((c) => ({
      ...c,
      jobTitle: c.jobId ? jobTitleById.get(c.jobId) ?? null : null,
    })),
  );
});
