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
import { scoreCandidateStructured } from "@/lib/ai";
import type { ParsedRole } from "@/lib/ai";
import { applyLocationFitOverride, deriveUpdateData } from "@/lib/score-utils";
import { buildScoreCacheKey, safeParseJson } from "@/lib/utils";
import { normaliseLinkedInUrl } from "@/lib/linkedin";
import { locationMatches, expandLocationKeywords, isConfirmedOutOfAreaForLocalRole } from "@/lib/location";
import { getCityCoords, getCityKeywordsWithinRadius, getNearestCity } from "@/lib/nz-cities";
import { getAuth, requireJobAccess, unauthorized } from "@/lib/session";
import { getAccessibleOrgIds } from "@/lib/org-access";
import { hasFullCandidateProfile } from "@/lib/candidate-profile";
import { getJobScoringWeights } from "@/lib/scoring-config";
import { checkRateLimit, recordUsage } from "@/lib/usage";
import { SCORE_CUTOFF_FULL_PROFILE } from "@/lib/provisional-scoring";
import { extractDistinctiveSignalsFromRequirement } from "@/lib/requirement-signals";

// Re-derive distinctive terms from a parsedRole — same logic as search/route.ts.
function distinctiveTerms(parsedRole: ParsedRole): string[] {
  const terms = new Set<string>();
  const musts = [...(parsedRole.must_haves ?? []), ...(parsedRole.knockout_criteria ?? [])];
  for (const req of musts) extractDistinctiveSignalsFromRequirement(req).forEach((t) => terms.add(t.toLowerCase()));
  return [...terms];
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
  const { minScore, maxResults, radiusKm, centerLat, centerLng } = parsed.data;

  const { job, error } = await requireJobAccess(jobId, auth);
  if (error || !job) return error;

  const rateCheck = await checkRateLimit(auth.orgId, "score_all");
  if (!rateCheck.allowed) {
    const waitMin = Math.ceil((rateCheck.retryAfterMs ?? 60000) / 60000);
    return NextResponse.json({ error: `Talent pool rate limit reached. Try again in ~${waitMin} minute${waitMin !== 1 ? "s" : ""}.` }, { status: 429 });
  }

  const parsedRole = safeParseJson<ParsedRole | null>(job.parsedRole, null);
  if (!parsedRole) {
    return NextResponse.json(
      { error: "Analyse the job description first before searching the talent pool." },
      { status: 400 }
    );
  }

  const location = parsedRole.location ?? "";
  const locationSource = location || parsedRole.location_rules || "";
  const salary = (job.salaryMin || job.salaryMax)
    ? { min: job.salaryMin ?? 0, max: job.salaryMax ?? 0 }
    : null;
  const weights = await getJobScoringWeights(job.scoringWeights, auth.orgId);

  const customCenterCity = centerLat != null && centerLng != null ? getNearestCity(centerLat, centerLng) : null;
  const canonicalJobCity = getCityCoords(locationSource)?.name ?? "";
  const targetLocation = customCenterCity?.name ?? (location || canonicalJobCity || locationSource);
  const baseKeywords   = customCenterCity?.keywords ?? expandLocationKeywords(targetLocation);
  const jobCoords      = getCityCoords(locationSource);
  const searchCenter   = centerLat != null && centerLng != null
    ? { lat: centerLat, lng: centerLng }
    : (jobCoords ? { lat: jobCoords.lat, lng: jobCoords.lng } : null);
  const radiusKeywords = searchCenter ? getCityKeywordsWithinRadius(searchCenter.lat, searchCenter.lng, radiusKm) : [];
  const locationKeywords = [...new Set([...baseKeywords, ...radiusKeywords])];

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
  const poolRows = await prisma.candidate.findMany({
    where: {
      jobId: { not: jobId },
      profileText: { not: null },
      ...(accessibleOrgIds === null
        ? {}
        : {
            OR: [
              { job: { orgId: { in: accessibleOrgIds } } },
              { jobId: null, orgId: { in: accessibleOrgIds } },
            ],
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
    orderBy: { createdAt: "desc" },
  });

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

  const candidates = [...bestByUrl.values()];
  console.log(`[talent-pool] ${candidates.length} unique profiles in pool (excluding this job)`);

  if (candidates.length === 0) {
    return NextResponse.json({
      count: 0, candidates: [],
      message: "No talent pool profiles available yet. Capture LinkedIn profiles for other jobs first.",
    });
  }

  // 4. Score each pool candidate against this job's role; save those that pass.
  type SavedCandidate = NonNullable<Awaited<ReturnType<typeof prisma.candidate.findFirst>>>;
  const saved: SavedCandidate[] = [];
  let scored = 0;
  let skippedScore = 0;

  // For specialist roles (SAFe Scrum Master, C++/Sybase developer, etc.) the pool
  // should only import candidates who have at least one distinctive term in their
  // full profile. Without this gate, every Wellington developer in the pool gets
  // added to every specialist job — e.g. an Azure architect ends up on a Scrum
  // Master candidate list because they're both Wellington-based.
  const roleTerms = distinctiveTerms(parsedRole);
  const isSpecialistRole = roleTerms.length > 0;

  for (let i = 0; i < candidates.length && saved.length < maxResults; i++) {
    const row = candidates[i];
    const loc = row.location ?? "";

    // Location filter (non-fatal if location unknown)
    if (loc && locationKeywords.length > 0 && !locationMatches(loc, locationKeywords)) {
      continue;
    }

    // Pre-score text signal filter for specialist roles.
    // If NONE of the role's distinctive terms appear in the full profile, skip
    // scoring entirely — saves Claude API spend and keeps irrelevant candidates
    // out of the list without paying for a full score to confirm they don't fit.
    if (isSpecialistRole) {
      const haystack = (row.profileText ?? "").toLowerCase();
      const hasSignal = roleTerms.some((term) => haystack.includes(term));
      if (!hasSignal) { skippedScore++; continue; }
    }

    const profileText = row.profileText!;
    scored++;
    console.log(`[talent-pool] scoring candidate ${row.id} — ${profileText.length}ch`);

    const scoreData: Record<string, unknown> = {};
    let matchScore: number | null = null;

    try {
      const rawBreakdown = await scoreCandidateStructured(profileText, parsedRole, salary, weights, auth.orgId);
      const breakdown = applyLocationFitOverride(
        rawBreakdown,
        row.location,
        targetLocation,
        parsedRole.location_rules,
        job.isRemote,
        weights,
      );
      matchScore = breakdown.overall;
      Object.assign(scoreData, deriveUpdateData(breakdown));
      scoreData.profileTextHash = buildScoreCacheKey({
        profileText,
        parsedRole,
        salary,
        jobLocation: job.location,
        isRemote: job.isRemote,
        weights,
      });
    } catch (err) {
      console.error(`[talent-pool] score failed for candidate ${row.id}:`, err);
      if (minScore > 0) { skippedScore++; continue; }
    }

    // Hard location cutoff: don't import talent-pool candidates who are clearly
    // out of area for non-remote local roles.
    if (isConfirmedOutOfAreaForLocalRole(row.location, targetLocation, parsedRole.location_rules, job.isRemote)) {
      skippedScore++;
      continue;
    }

    // Score floor for specialist roles — same threshold as the search route uses
    // for full profiles. Pool candidates have full text so the score is reliable;
    // an Azure architect scoring 8% on a Scrum Master JD is a real "no", not a
    // data-quality issue.
    const effectiveMinScore = isSpecialistRole
      ? Math.max(minScore, SCORE_CUTOFF_FULL_PROFILE)
      : minScore;
    if (matchScore !== null && matchScore < effectiveMinScore) {
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

  console.log(`[talent-pool] done — scored ${scored}, saved ${saved.length}, skipped ${skippedScore}`);
  void recordUsage(auth.orgId, auth.userId, "score_all", { jobId, scored: saved.length, source: "talent_pool" });

  const sorted = saved.sort((a, b) => (b.matchScore ?? -1) - (a.matchScore ?? -1));

  if (sorted.length === 0) {
    const reason = skippedScore > 0
      ? `Scored ${scored} pool candidates but none cleared ${minScore}% — try lowering the minimum score.`
      : "No pool candidates matched this role's location or requirements.";
    return NextResponse.json({ count: 0, candidates: [], message: reason });
  }

  return NextResponse.json({ count: sorted.length, candidates: sorted });
}
