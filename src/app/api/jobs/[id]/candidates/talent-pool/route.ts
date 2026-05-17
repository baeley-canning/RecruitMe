/**
 * POST /api/jobs/[id]/candidates/talent-pool
 *
 * Searches the local talent pool (all Candidate rows with a full profile,
 * across every job) and adds any matching, not-yet-imported candidates to
 * this job, scored against its requirements.
 *
 * This lets the user build up a rich DB of profiles over time and instantly
 * surface relevant people for new roles without hitting LinkedIn at all.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { scoreCandidatesBatch } from "@/lib/ai";
import { enrichCandidateInBackground } from "@/lib/firmable-enrich";
import { candidateTitleFitsRole } from "@/lib/title-family";
import type { ParsedRole } from "@/lib/ai";
import { applyLocationFitOverride, deriveUpdateData } from "@/lib/score-utils";
import { getJobTargetLocation } from "@/lib/job-target-location";
import { buildScoreCacheKey, safeParseJson } from "@/lib/utils";
import { normaliseLinkedInUrl } from "@/lib/linkedin";
import { shouldRejectAsOverseas } from "@/lib/location";
import { getCityCoords, getNearestCity } from "@/lib/nz-cities";
import { getAuth, requireJobAccess, unauthorized } from "@/lib/session";
import { getAccessibleOrgIds } from "@/lib/org-access";
import { hasFullCandidateProfile } from "@/lib/candidate-profile";
import { getJobScoringWeights } from "@/lib/scoring-config";
import { getCorrectionsVersion } from "@/lib/recruiter-memory";
import { checkRateLimit, checkSpendCap, recordUsage } from "@/lib/usage";
import { tryAcquireLock, releaseLock } from "@/lib/db-lock";
import { SCORE_CUTOFF_FULL_PROFILE } from "@/lib/provisional-scoring";
import { extractSignalsFromRequirement, signalMatchesText } from "@/lib/requirement-signals";
import { extractRoleAwareDistinctiveAnchors } from "@/lib/requirement-signals";

// Re-derive distinctive terms from a parsedRole — role-aware so hybrid IT-ops
// roles ("Technology Support Manager") don't gate the pool on ISMS/ISO 27001
// when the role's secondary compliance requirement would otherwise reject
// good IT-ops candidates whose full profile doesn't surface the acronym.
function distinctiveTerms(parsedRole: ParsedRole): string[] {
  return extractRoleAwareDistinctiveAnchors({
    title: parsedRole.title,
    requirements: [
      ...(parsedRole.must_haves ?? []),
      ...(parsedRole.knockout_criteria ?? []),
    ],
  }).map((t) => t.toLowerCase());
}

const BodySchema = z.object({
  minScore:  z.number().int().min(0).max(100).default(0),
  maxResults: z.number().int().min(1).max(200).default(50),
  radiusKm:  z.number().min(1).max(200).default(25),
  centerLat: z.number().min(-90).max(90).optional(),
  centerLng: z.number().min(-180).max(180).optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id: jobId } = await params;

  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 });
  }
  // radiusKm is accepted for back-compat with older clients but ignored —
  // the country gate replaces the city-radius filter.
  const { minScore, maxResults, centerLat, centerLng } = parsed.data;

  const { job, error } = await requireJobAccess(jobId, auth);
  if (error || !job) return error;

  const rateCheck = await checkRateLimit(auth.orgId, "score_all");
  if (!rateCheck.allowed) {
    const waitMin = Math.ceil((rateCheck.retryAfterMs ?? 60000) / 60000);
    return NextResponse.json({ error: `Talent pool rate limit reached. Try again in ~${waitMin} minute${waitMin !== 1 ? "s" : ""}.` }, { status: 429 });
  }

  // Cost ceiling — talent-pool can fire up to `maxResults * 2` Claude
  // calls in one click (~$1-3 at Haiku). Without this guard a single
  // mash on a 14k library could blow past the $5/day cap before the
  // route returns. The score-all sibling has the same guard.
  const spend = await checkSpendCap(auth.orgId);
  if (!spend.allowed) {
    return NextResponse.json({
      error: `Daily AI spend cap reached ($${spend.spentUsd.toFixed(2)} / $${spend.capUsd.toFixed(2)}). Try again tomorrow or raise AI_DAILY_SPEND_CAP_USD.`,
    }, { status: 429 });
  }

  // Per-job advisory lock — two recruiters clicking "Library only" on the
  // same job at the same time would otherwise both pay for scoring the
  // same overlapping pool. The lock holds for the route's lifetime and
  // releases in the finally block below. Stale entries auto-clear after
  // 15 min per the db-lock default.
  const lockName = `talent-pool:${jobId}`;
  const lockAcquired = await tryAcquireLock(lockName);
  if (!lockAcquired) {
    return NextResponse.json({
      error: "A library search is already running for this job. Wait a minute and try again.",
    }, { status: 429 });
  }
  try {

  const parsedRole = safeParseJson<ParsedRole | null>(job.parsedRole, null);
  if (!parsedRole) {
    return NextResponse.json(
      { error: "Analyse the job description first before searching the talent pool." },
      { status: 400 }
    );
  }

  // Recruiter-set job locations win over parsedRole.location (AI-extracted)
  // and feed through the multi-target branch of assessLocationFit when a
  // second location is set.
  const jobTargetLocation = getJobTargetLocation(job, parsedRole) ?? "";
  const locationSource = jobTargetLocation || parsedRole.location_rules || "";
  const salary = (job.salaryMin || job.salaryMax)
    ? { min: job.salaryMin ?? 0, max: job.salaryMax ?? 0 }
    : null;
  const weights = await getJobScoringWeights(job.scoringWeights, auth.orgId);
  // Fetched once per route call (60s in-process cache) — feeds every cache
  // key written below so a freshly-saved correction busts stale pool scores.
  const correctionsVersion = await getCorrectionsVersion(auth.orgId);

  // targetLocation feeds into score-time location_fit ranking. The hard
  // import gate is now country-only (NZ-wide), so we no longer need the
  // pre-loop city/keyword/radius expansion that used to filter the pool.
  const customCenterCity = centerLat != null && centerLng != null ? getNearestCity(centerLat, centerLng) : null;
  const canonicalJobCity = getCityCoords(locationSource)?.name ?? "";
  const targetLocation = customCenterCity?.name ?? (jobTargetLocation || canonicalJobCity || locationSource);

  // 1. Collect the LinkedIn URLs already in this job so we skip duplicates.
  const existingUrls = new Set(
    (await prisma.candidate.findMany({
      where: { jobId },
      select: { linkedinUrl: true },
    })).map((c) => c.linkedinUrl).filter(Boolean)
  );

  // 2. Pull all candidates with a full profile from any org the caller can
  // read (own org + cross-org library_read grants). Owners see all.
  const accessibleOrgIds = await getAccessibleOrgIds(auth);

  // SQL-side pre-filter: when the JD has enough must-have signals, push
  // a substring-OR clause into Postgres. The pg_trgm GIN index on
  // profileText (apply-schema-changes step 11) makes ILIKE %term% an
  // index-backed scan rather than a sequential table scan. This cuts
  // 14k rows down to typically ~500-2000 (candidates who mention any
  // must-have term) before we hydrate profileText into Node memory.
  //
  // When the JD has <3 must-have signals (parse failure, generic role)
  // we fall back to the old "pull everything, rank in JS" path so a
  // thin JD doesn't surface nothing.
  const earlyMustHaves = parsedRole.must_haves?.length ? parsedRole.must_haves : (parsedRole.skills_required ?? []);
  const prefilterTerms = earlyMustHaves
    .flatMap((req) => extractSignalsFromRequirement(req))
    .filter((s) => s.length >= 3 && !/^\d+$/.test(s))
    .slice(0, 12); // cap to keep the WHERE clause sane
  const usePrefilter = prefilterTerms.length >= 3;
  const prefilterClause = usePrefilter
    ? { OR: prefilterTerms.map((t) => ({ profileText: { contains: t, mode: "insensitive" as const } })) }
    : {};

  const poolRows = await prisma.candidate.findMany({
    where: {
      jobId: { not: jobId },
      profileText: { not: null },
      ...prefilterClause,
      ...(accessibleOrgIds === null
        ? {}
        : {
            AND: {
              OR: [
                { job: { orgId: { in: accessibleOrgIds } } },
                { jobId: null, orgId: { in: accessibleOrgIds } },
              ],
            },
          }),
    },
    select: {
      id: true,
      name: true,
      headline: true,
      location: true,
      linkedinUrl: true,
      profileText: true,
      profileCapturedAt: true,
      createdAt: true,
    },
    // id-desc tiebreaker prevents bulk-import timestamp-ties from biasing
    // the head when many rows share one createdAt. Cap of 12k stays as a
    // safety net for the no-prefilter fallback path.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 12000,
  });
  console.log(`[talent-pool] pre-filter terms=${prefilterTerms.length} usePrefilter=${usePrefilter} → ${poolRows.length} rows`);

  // 3. Deduplicate by normalised LinkedIn URL, keep the freshest profile per URL.
  const bestByUrl = new Map<string, typeof poolRows[number]>();
  for (const row of poolRows) {
    if (!row.linkedinUrl || !hasFullCandidateProfile(row)) continue;
    let normUrl: string;
    try { normUrl = normaliseLinkedInUrl(row.linkedinUrl); } catch { continue; }
    if (existingUrls.has(normUrl) || existingUrls.has(row.linkedinUrl)) continue;

    const existing = bestByUrl.get(normUrl);
    if (!existing) { bestByUrl.set(normUrl, row); continue; }
    const rowDate = row.profileCapturedAt ?? row.createdAt;
    const existDate = existing.profileCapturedAt ?? existing.createdAt;
    if (rowDate > existDate) bestByUrl.set(normUrl, row);
  }

  const candidatesBeforeRank = [...bestByUrl.values()];
  console.log(`[talent-pool] ${candidatesBeforeRank.length} unique profiles in pool (excluding this job)`);

  if (candidatesBeforeRank.length === 0) {
    return NextResponse.json({
      count: 0, candidates: [],
      message: "No talent pool profiles available yet. Capture LinkedIn profiles for other jobs first.",
    });
  }

  // Pre-rank by relevance to the JD's must-haves + nice-to-haves. This is
  // a cheap keyword-density pass that costs zero AI tokens — we just want
  // the 100 most-relevant candidates at the top of the queue so Claude
  // batch scoring spends its budget on the right people.
  //
  // Previously: candidates were ordered by createdAt desc, which after a
  // bulk import meant the first 100 the route saw were name-sorted ties
  // from the import (~3 of 25 actually matched the role).
  const mustHavesForRank   = parsedRole.must_haves?.length ? parsedRole.must_haves : (parsedRole.skills_required ?? []);
  const niceToHavesForRank = parsedRole.nice_to_haves?.length ? parsedRole.nice_to_haves : (parsedRole.skills_preferred ?? []);
  const computeRelevance = (row: typeof candidatesBeforeRank[number]): number => {
    const haystack = (row.profileText ?? "").toLowerCase();
    if (!haystack) return -Infinity;
    let score = 0;
    for (const req of mustHavesForRank) {
      const signals = extractSignalsFromRequirement(req);
      if (signals.some((s) => signalMatchesText(haystack, s))) score += 3;
    }
    for (const req of niceToHavesForRank.slice(0, 8)) {
      const signals = extractSignalsFromRequirement(req);
      if (signals.some((s) => signalMatchesText(haystack, s))) score += 1;
    }
    // Tie-break: prefer recently-captured (more current profile content).
    // Coerce — tests pass createdAt as strings; runtime Prisma passes Dates.
    const raw = row.profileCapturedAt ?? row.createdAt;
    const t = raw instanceof Date ? raw.getTime() : new Date(raw as unknown as string).getTime();
    score += (Number.isFinite(t) ? t : 0) / 1e15; // tiny additive — only breaks ties
    return score;
  };
  const candidates = candidatesBeforeRank
    .map((row) => ({ row, relevance: computeRelevance(row) }))
    .sort((a, b) => b.relevance - a.relevance)
    .map(({ row }) => row);
  console.log(`[talent-pool] ranked by JD relevance — top candidate score=${computeRelevance(candidates[0])}, bottom=${computeRelevance(candidates[candidates.length - 1])}`);

  // 4. Score each pool candidate against this job's role; save those that pass.
  type SavedCandidate = NonNullable<Awaited<ReturnType<typeof prisma.candidate.findFirst>>>;
  const saved: SavedCandidate[] = [];
  let scored = 0;
  let skippedScore = 0;
  let skippedOverseas = 0;

  // Hard time budget. 45s — chosen to be well under the frontend's 50s pool
  // abort so the recruiter always gets a response in time for LinkedIn search
  // to kick off as a fallback. Without this, a slow Anthropic batch could
  // hold the entire Find Candidates flow open for minutes, blocking the
  // LinkedIn search the recruiter actually needs for non-specialist roles.
  const startedAt = Date.now();
  const TIME_BUDGET_MS = 45_000;
  let stoppedEarly = false;

  // For specialist roles (SAFe Scrum Master, C++/Sybase developer, etc.) the pool
  // should only import candidates who have at least one distinctive term in their
  // full profile. Without this gate, every Wellington developer in the pool gets
  // added to every specialist job — e.g. an Azure architect ends up on a Scrum
  // Master candidate list because they're both Wellington-based.
  //
  // A SINGLE distinctive term isn't enough to gate on though — a .NET role's
  // "must-haves" contain just "SQL Server" as the rare-anchor by chance, and
  // gating on that alone drops every great .NET dev who happens to use Postgres
  // or Oracle. Require ≥2 anchors before flipping into hard-anchor mode;
  // otherwise treat the anchor as a relevance ranker (which we already did
  // above) and use must-have-signal presence as the admission test instead.
  const roleTerms = distinctiveTerms(parsedRole);
  const isSpecialistRole = roleTerms.length >= 2;
  // Pre-compute must-have signal sets once — checked for each candidate below
  // when we're not in strict specialist mode.
  const mustHaveSignalSets = mustHavesForRank.map((req) => extractSignalsFromRequirement(req));

  // ── Pre-filter: drop overseas + non-specialist-signal candidates before scoring.
  // Anything past this point is sent to Claude. We cap at maxResults * 2 so a
  // big library doesn't blow the token budget — the over-pull covers the case
  // where some candidates fail the post-score minScore filter.
  type PoolRow = typeof candidates[number];
  const toScore: PoolRow[] = [];
  for (const row of candidates) {
    if (toScore.length >= maxResults * 2) break;
    const overseasCheck = shouldRejectAsOverseas({
      explicitLocation: row.location ?? "",
      headline: row.headline,
      profileText: row.profileText,
      isRemote: job.isRemote,
    });
    if (overseasCheck.reject) {
      skippedOverseas++;
      continue;
    }
    const haystack = (row.profileText ?? "").toLowerCase();
    if (isSpecialistRole) {
      // ≥2 distinctive anchors — strict: at least one must appear in profile.
      const hasSignal = roleTerms.some((term) => haystack.includes(term));
      if (!hasSignal) { skippedScore++; continue; }
    } else {
      // Thin / no anchors — gate on must-have signal coverage, falling back
      // to title-family. A candidate is admitted if EITHER (a) profileText
      // contains a signal for at least one must-have, OR (b) the headline
      // is in the role's title family. (a) catches CV-shaped imports whose
      // headline is generic ("Software Engineer") but whose CV mentions
      // the actual must-haves. (b) is the original behaviour kept as a
      // fallback so candidates with great titles but uninformative profiles
      // still get a chance.
      const hasMustHaveSignal = mustHaveSignalSets.some(
        (signals) => signals.some((s) => signalMatchesText(haystack, s)),
      );
      if (!hasMustHaveSignal && !candidateTitleFitsRole(parsedRole.title, row.headline)) {
        skippedScore++;
        continue;
      }
    }
    if (!row.profileText) continue;
    toScore.push(row);
  }

  // ── Batch score everything that survived pre-filter.
  // scoreCandidatesBatch chunks into groups of 5 and dispatches in parallel,
  // so this typically returns in ~10-30s for up to 40 candidates instead of
  // the 5-15 MINUTES sequential scoring used to take.
  const batchResults = toScore.length > 0
    ? await Promise.race([
        scoreCandidatesBatch(
          toScore.map((r) => ({ candidateId: r.id, profileText: r.profileText! })),
          parsedRole,
          salary,
          weights,
          auth.orgId,
        ),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("batch score timeout")), TIME_BUDGET_MS)),
      ]).catch((err) => {
        console.warn("[talent-pool] batch scoring failed or timed out:", err);
        stoppedEarly = true;
        return [];
      })
    : [];

  scored = batchResults.length;

  // ── Save loop: each batch result → upsert candidate row (or skip on minScore).
  const breakdownById = new Map(batchResults.map((r) => [r.candidateId, r.breakdown]));

  for (const row of toScore) {
    if (saved.length >= maxResults) break;
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      stoppedEarly = true;
      console.warn(`[talent-pool] time budget exceeded during save loop`);
      break;
    }

    const profileText = row.profileText!;
    const rawBreakdown = breakdownById.get(row.id);
    if (!rawBreakdown) {
      // Batch failed or timed out before this candidate scored. Skip; the
      // recruiter can re-run to retry.
      if (minScore > 0) skippedScore++;
      continue;
    }

    const breakdown = applyLocationFitOverride(
      rawBreakdown,
      row.location,
      targetLocation,
      parsedRole.location_rules,
      job.isRemote,
      weights,
    );
    const matchScore = breakdown.overall;
    const scoreData: Record<string, unknown> = {
      ...deriveUpdateData(breakdown),
      profileTextHash: buildScoreCacheKey({
        profileText,
        parsedRole,
        salary,
        jobLocation: job.location,
        jobLocation2: job.location2,
        isRemote: job.isRemote,
        weights,
        correctionsVersion,
      }),
    };

    // Score floor for specialist roles — same threshold as the search route uses
    // for full profiles. Pool candidates have full text so the score is reliable;
    // an Azure architect scoring 8% on a Scrum Master JD is a real "no", not a
    // data-quality issue.
    const effectiveMinScore = isSpecialistRole
      ? Math.max(minScore, SCORE_CUTOFF_FULL_PROFILE)
      : minScore;
    if (matchScore < effectiveMinScore) {
      skippedScore++;
      continue;
    }

    try {
      const normUrl = normaliseLinkedInUrl(row.linkedinUrl!);
      // Upsert rather than create: the search route and this route can both
      // fire for the same job simultaneously (Q1.3 parallel pool+LinkedIn).
      // Using create causes a P2002 unique-constraint crash when they race
      // on the same (jobId, linkedinUrl). Upsert merges gracefully; the
      // score data always overwrites so the freshest result wins.
      const candidate = await prisma.candidate.upsert({
        where: { jobId_linkedinUrl: { jobId, linkedinUrl: normUrl } },
        create: {
          jobId,
          orgId: job.orgId ?? null,
          name: row.name,
          headline: row.headline,
          location: row.location || null,
          linkedinUrl: normUrl,
          profileText,
          source: "talent_pool",
          status: "new",
          ...(row.profileCapturedAt ? { profileCapturedAt: row.profileCapturedAt } : {}),
          ...scoreData,
        },
        update: {
          // Only update score-related fields so we don't clobber recruiter notes/status.
          ...scoreData,
          source: "talent_pool",
          ...(row.profileCapturedAt ? { profileCapturedAt: row.profileCapturedAt } : {}),
        },
      });
      saved.push(candidate as SavedCandidate);
    } catch (err) {
      console.error("[talent-pool] candidate save failed:", err);
    }
  }

  console.log(`[talent-pool] done — scored ${scored}, saved ${saved.length}, skipped ${skippedScore}, overseas ${skippedOverseas}, stoppedEarly=${stoppedEarly}`);
  void recordUsage(auth.orgId, auth.userId, "score_all", { jobId, scored: saved.length, source: "talent_pool" });

  // Background phone enrichment for the just-saved candidates. The existing
  // candidates' enriched-at timestamps + 90d cache mean re-imports of the
  // same person across jobs don't re-burn credits.
  for (const c of saved) enrichCandidateInBackground(c.id);

  const sorted = saved.sort((a, b) => (b.matchScore ?? -1) - (a.matchScore ?? -1));
  const partialNote = stoppedEarly
    ? " (Library is large — only the first batch was scored this run; click search again to keep going.)"
    : "";

  if (sorted.length === 0) {
    const reason = skippedScore > 0
      ? `Scored ${scored} pool candidates but none cleared ${minScore}% — try lowering the minimum score.${partialNote}`
      : skippedOverseas > 0
        ? `Skipped ${skippedOverseas} overseas candidate${skippedOverseas !== 1 ? "s" : ""}; no NZ-based pool candidates matched.${partialNote}`
        : `No pool candidates matched this role's location or requirements.${partialNote}`;
    return NextResponse.json({ count: 0, candidates: [], message: reason, skippedOverseas, stoppedEarly });
  }

  return NextResponse.json({
    count: sorted.length,
    candidates: sorted,
    skippedOverseas,
    stoppedEarly,
    ...(stoppedEarly ? { message: `Imported ${sorted.length} from the library so far.${partialNote}` } : {}),
  });
  } finally {
    await releaseLock(lockName);
  }
}
