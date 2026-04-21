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
import { safeParseJson } from "@/lib/utils";
import { normaliseLinkedInUrl } from "@/lib/linkedin";
import { locationMatches, expandLocationKeywords } from "@/lib/location";
import { getCityCoords, getCityKeywordsWithinRadius, getNearestCity } from "@/lib/nz-cities";
import { getAuth, requireJobAccess, unauthorized } from "@/lib/session";

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

  // 2. Pull all candidates from OTHER jobs in the same org that have a full profile.
  const poolRows = await prisma.candidate.findMany({
    where: {
      jobId: { not: jobId },
      profileText: { not: null },
      // Owners can see across all orgs; regular users are scoped to their own.
      ...(auth.isOwner ? {} : { job: { orgId: auth.orgId } }),
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
    if (!row.linkedinUrl || !row.profileText || row.profileText.length < 500) continue;
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

  for (let i = 0; i < candidates.length && saved.length < maxResults; i++) {
    const row = candidates[i];
    const loc = row.location ?? "";

    // Location filter (non-fatal if location unknown)
    if (loc && locationKeywords.length > 0 && !locationMatches(loc, locationKeywords)) {
      continue;
    }

    const profileText = row.profileText!;
    scored++;
    console.log(`[talent-pool] scoring "${row.name}" — ${profileText.length}ch`);

    const scoreData: Record<string, unknown> = {};
    let matchScore: number | null = null;
    let locationFitScore: number | null = null;

    try {
      const rawBreakdown = await scoreCandidateStructured(profileText, parsedRole, salary);
      const breakdown = applyLocationFitOverride(
        rawBreakdown,
        row.location,
        targetLocation,
        parsedRole.location_rules,
        job.isRemote,
      );
      matchScore = breakdown.overall;
      locationFitScore = breakdown.categories.location_fit.score;
      Object.assign(scoreData, deriveUpdateData(breakdown));
    } catch (err) {
      console.error(`[talent-pool] score failed for "${row.name}":`, err);
      if (minScore > 0) { skippedScore++; continue; }
    }

    // Hard location cutoff: don't import talent-pool candidates who are clearly
    // out of area for non-remote roles (score ≤20 means >150 km away).
    if (!job.isRemote && locationFitScore !== null && locationFitScore <= 20) {
      skippedScore++;
      continue;
    }

    if (minScore > 0 && matchScore !== null && matchScore < minScore) {
      skippedScore++;
      continue;
    }

    try {
      const normUrl = normaliseLinkedInUrl(row.linkedinUrl!);
      const candidate = await prisma.candidate.create({
        data: {
          jobId,
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
      });
      saved.push(candidate as SavedCandidate);
    } catch (err) {
      console.error("[talent-pool] candidate save failed:", err);
    }
  }

  console.log(`[talent-pool] done — scored ${scored}, saved ${saved.length}, skipped ${skippedScore}`);

  const sorted = saved.sort((a, b) => (b.matchScore ?? -1) - (a.matchScore ?? -1));

  if (sorted.length === 0) {
    const reason = skippedScore > 0
      ? `Scored ${scored} pool candidates but none cleared ${minScore}% — try lowering the minimum score.`
      : "No pool candidates matched this role's location or requirements.";
    return NextResponse.json({ count: 0, candidates: [], message: reason });
  }

  return NextResponse.json({ count: sorted.length, candidates: sorted });
}
