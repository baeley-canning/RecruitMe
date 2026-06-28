import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized, jobsWhere } from "@/lib/session";
import { scoreTier } from "@/lib/score-utils";
import { getLibraryStats } from "@/lib/library";

export async function GET() {
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // last 7 days

  const [jobs, recentCaptures, recentSearches, libraryStats] = await Promise.all([
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
          // Cap the nested read: aging jobs can have thousands of candidates and
          // an unbounded select here materialized every row (7 cols each) just to
          // compute counts + a top-3. orderBy matchScore desc keeps the highest
          // scorers (the only ones topCandidates can surface) within the cap, so
          // the response shape is unchanged while the worst-case read is bounded.
          orderBy: { matchScore: "desc" },
          take: 50,
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

    // Library stat triple (deduped people / strong / with-CV) — runs in parallel
    // with the queries above since it only needs `auth` (was serial-awaited below).
    getLibraryStats(auth),
  ]);

  // The nested `candidates` select above is CAPPED at 50 (top by matchScore) so
  // an aging job can't materialize thousands of rows — that cap is only safe
  // for the top-3 display. The per-job COUNTS must be exact, so compute them as
  // bounded DB aggregates (no row materialization, no raw SQL):
  // "Total candidates" headline = UNIQUE people, the SAME deduped count the
  // Candidates Library shows — so the two screens never disagree. (The old
  // headline summed per-job pipeline rows, which double-counted anyone in
  // multiple jobs and skipped library-only people, so it read ~1250 while the
  // library showed ~713 — looked like the count was lying.)
  const jobIds = jobs.map((j) => j.id);
  const [byJob, shortlistedByJob, needsFetchByJob] = jobIds.length
    ? await Promise.all([
        // total (_all), scored (non-null matchScore), fetched (non-null
        // profileCapturedAt) and avg score — all in one grouped query.
        prisma.candidate.groupBy({
          by: ["jobId"],
          where: { jobId: { in: jobIds } },
          _count: { _all: true, matchScore: true, profileCapturedAt: true },
          _avg: { matchScore: true },
        }),
        prisma.candidate.groupBy({
          by: ["jobId"],
          where: { jobId: { in: jobIds }, status: "shortlisted" },
          _count: { _all: true },
        }),
        prisma.candidate.groupBy({
          by: ["jobId"],
          where: { jobId: { in: jobIds }, matchScore: { not: null }, profileCapturedAt: null },
          _count: { _all: true },
        }),
      ])
    : [[], [], []];
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  const totalBy = new Map(byJob.map((g) => [g.jobId, num(g._count._all)]));
  const scoredBy = new Map(byJob.map((g) => [g.jobId, num(g._count.matchScore)]));
  const fetchedBy = new Map(byJob.map((g) => [g.jobId, num(g._count.profileCapturedAt)]));
  const avgBy = new Map(byJob.map((g) => [g.jobId, g._avg.matchScore == null ? null : Math.round(g._avg.matchScore)]));
  const shortlistedBy = new Map(shortlistedByJob.map((g) => [g.jobId, num(g._count._all)]));
  const needsFetchBy = new Map(needsFetchByJob.map((g) => [g.jobId, num(g._count._all)]));

  // Compute job health signals (counts from the exact aggregates above;
  // topCandidates from the capped, matchScore-ordered nested select).
  const jobStats = jobs.map((job) => {
    const total = totalBy.get(job.id) ?? 0;
    const scored = scoredBy.get(job.id) ?? 0;
    const shortlisted = shortlistedBy.get(job.id) ?? 0;
    const fetched = fetchedBy.get(job.id) ?? 0;
    const needsFetch = needsFetchBy.get(job.id) ?? 0;
    const avgScore = avgBy.get(job.id) ?? null;
    // "Top candidates" = anything not in the "poor" tier (40+) and not yet
    // actioned. The take:50 cap is matchScore-desc, so the genuine top-3 are
    // always present.
    const topCandidates = job.candidates
      .filter((c) => c.matchScore !== null && scoreTier(c.matchScore ?? 0, "match") !== "poor" && !["shortlisted","contacted","interviewing","offer_sent","hired","declined","rejected"].includes(c.status))
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
      totalCandidates: total,
      scored,
      fetched,
      needsFetch,
      shortlisted,
      avgScore,
      topCandidates,
      staleScores,
      needsAttention: total > 0 && shortlisted === 0 && scored > 0,
    };
  });

  return NextResponse.json({
    jobs: jobStats,
    recentCaptures,
    recentSearches,
    totals: {
      activeJobs: jobs.length,
      // Unique deduped people (matches the Candidates Library "People" stat),
      // not the sum of per-job pipeline rows.
      totalCandidates: libraryStats.total,
      shortlisted: jobStats.reduce((s, j) => s + j.shortlisted, 0),
      capturedThisWeek: recentCaptures.length,
    },
  });
}
