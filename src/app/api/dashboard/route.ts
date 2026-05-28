import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized, jobsWhere } from "@/lib/session";
import { scoreTier } from "@/lib/score-utils";

export async function GET() {
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // last 7 days

  const today = new Date();
  today.setHours(23, 59, 59, 999);

  const [jobs, recentCaptures, recentSearches, remindersToday, placementStats] = await Promise.all([
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
        linkedinUrl: true,
        photoFileId: true,
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

    // Reminders due today (or overdue)
    prisma.reminder.findMany({
      where: {
        dismissed: false,
        dueAt: { lte: today },
        ...(!auth.isOwner ? { orgId: auth.orgId ?? "__none__" } : {}),
      },
      orderBy: { dueAt: "asc" },
      take: 10,
      select: { id: true, type: true, dueAt: true, note: true, candidateId: true, jobId: true, clientId: true },
    }),

    // Placement fee totals (this calendar month)
    prisma.placement.findMany({
      where: {
        placedAt: { gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) },
        ...(!auth.isOwner ? { orgId: auth.orgId ?? "__none__" } : {}),
      },
      select: { feeAmount: true, feePct: true, salaryPlaced: true, paidAt: true },
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
    // "Top candidates" = anything not in the "poor" tier (40+) and not yet
    // actioned. Tier definition lives in lib/score-utils so threshold stays
    // aligned with the recruiter-visible tier labels.
    const topCandidates = scored
      .filter((c) => scoreTier(c.matchScore ?? 0, "match") !== "poor" && !["shortlisted","contacted","interviewing","offer_sent","hired","declined","rejected"].includes(c.status))
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

  const monthlyFeeTotal = placementStats.reduce((s, p) => {
    if (p.feeAmount) return s + p.feeAmount;
    if (p.feePct && p.salaryPlaced) return s + Math.round(p.salaryPlaced * p.feePct / 100);
    return s;
  }, 0);
  const monthlyFeePaid = placementStats.filter(p => p.paidAt).reduce((s, p) => {
    if (p.feeAmount) return s + p.feeAmount;
    if (p.feePct && p.salaryPlaced) return s + Math.round(p.salaryPlaced * p.feePct / 100);
    return s;
  }, 0);

  return NextResponse.json({
    jobs: jobStats,
    recentCaptures,
    recentSearches,
    remindersToday,
    placements: {
      monthlyFeeTotal,
      monthlyFeePaid,
      thisMonthCount: placementStats.length,
    },
    totals: {
      activeJobs: jobs.length,
      totalCandidates: jobs.reduce((s, j) => s + j.candidates.length, 0),
      shortlisted: jobs.reduce((s, j) => s + j.candidates.filter(c => c.status === "shortlisted").length, 0),
      capturedThisWeek: recentCaptures.length,
    },
  });
}
