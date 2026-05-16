import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized, jobsWhere } from "@/lib/session";

export async function GET() {
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // last 7 days

  const [jobs, recentCaptures, recentSearches] = await Promise.all([
    // All active jobs with candidate stats
    prisma.job.findMany({
      where: { status: "active", ...jobsWhere(auth) },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        title: true,
        company: true,
        location: true,
        lastScoredAt: true,
        lastParsedAt: true,
        candidates: {
          select: {
            id: true,
            matchScore: true,
            status: true,
            profileCapturedAt: true,
            name: true,
            headline: true,
            location: true,
          },
        },
      },
    }),

    // Recent profile captures (last 7 days)
    prisma.candidate.findMany({
      where: {
        profileCapturedAt: { gte: since },
        ...(!auth.isOwner ? {
          OR: [
            { job: { orgId: auth.orgId } },
            { jobId: null, orgId: auth.orgId },
          ],
        } : {}),
      },
      orderBy: { profileCapturedAt: "desc" },
      take: 10,
      select: {
        id: true,
        name: true,
        matchScore: true,
        status: true,
        profileCapturedAt: true,
        job: { select: { id: true, title: true } },
      },
    }),

    // Recent search sessions (last 7 days)
    prisma.searchSession.findMany({
      where: {
        createdAt: { gte: since },
        status: "complete",
        ...(!auth.isOwner ? { orgId: auth.orgId } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: {
        id: true,
        collected: true,
        avgScore: true,
        evaluation: true,
        createdAt: true,
        job: { select: { id: true, title: true } },
      },
    }),
  ]);

  // Compute job health signals
  const jobStats = jobs.map((job) => {
    const all        = job.candidates;
    const scored     = all.filter((c) => c.matchScore !== null);
    const shortlisted = all.filter((c) => c.status === "shortlisted").length;
    const fetched    = all.filter((c) => c.profileCapturedAt).length;
    const needsFetch = all.filter((c) => !c.profileCapturedAt && c.matchScore !== null).length;
    const avgScore   = scored.length
      ? Math.round(scored.reduce((s, c) => s + (c.matchScore ?? 0), 0) / scored.length)
      : null;
    const topCandidates = scored
      .filter((c) => (c.matchScore ?? 0) >= 40 && !["shortlisted","contacted","interviewing","offer_sent","hired","declined","rejected"].includes(c.status))
      .sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0))
      .slice(0, 3)
      .map(({ id, name, headline, location, matchScore }) => ({ id, name, headline, location, matchScore }));

    // Staleness signal: JD re-parsed after last score-all
    const staleScores = !!(job.lastParsedAt && job.lastScoredAt && new Date(job.lastParsedAt) > new Date(job.lastScoredAt));

    return {
      id: job.id,
      title: job.title,
      company: job.company,
      location: job.location,
      totalCandidates: all.length,
      scored: scored.length,
      fetched,
      needsFetch,
      shortlisted,
      avgScore,
      topCandidates,
      staleScores,
      needsAttention: all.length > 0 && shortlisted === 0 && scored.length > 0,
    };
  });

  return NextResponse.json({
    jobs: jobStats,
    recentCaptures,
    recentSearches,
    totals: {
      activeJobs: jobs.length,
      totalCandidates: jobs.reduce((s, j) => s + j.candidates.length, 0),
      shortlisted: jobs.reduce((s, j) => s + j.candidates.filter(c => c.status === "shortlisted").length, 0),
      capturedThisWeek: recentCaptures.length,
    },
  });
}
