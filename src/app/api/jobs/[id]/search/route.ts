import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import {
  searchLinkedInProfiles,
  searchBingLinkedInProfiles,
  searchPDLProfiles,
  type SearchResult,
} from "@/lib/search";
import { scoreCandidateStructured } from "@/lib/ai";
import type { ParsedRole } from "@/lib/ai";
import { applyLocationFitOverride, deriveUpdateData } from "@/lib/score-utils";
import { expandLocationKeywords, locationMatches } from "@/lib/location";
import { getCityCoords, getCityKeywordsWithinRadius, getNearestCity } from "@/lib/nz-cities";
import { safeParseJson } from "@/lib/utils";
import { buildTalentPoolMap } from "@/lib/talent-pool";
import { normaliseLinkedInUrl } from "@/lib/linkedin";
import { collectPagedSearchResults, type SearchPageTaskResult } from "@/lib/search-collection";
import { getAuth, requireJobAccess, unauthorized } from "@/lib/session";

const SearchSchema = z.object({
  maxResults: z.number().int().min(1).max(100).default(20),
  minScore:   z.number().int().min(0).max(100).default(0),
  radiusKm:   z.number().min(1).max(200).default(25),
  centerLat:  z.number().min(-90).max(90).optional(),
  centerLng:  z.number().min(-180).max(180).optional(),
});

const PLACEHOLDERS = new Set([
  "full name", "job title at company", "city, country", "unknown",
  "n/a", "not specified", "see profile", "na",
]);

const ORG_PATTERNS = [
  /\b(ministry|department|government|council|authority|commission)\b/i,
  /\b(university|college|institute|polytechnic|school|academy)\b/i,
  /\b(ltd|limited|inc|corp|corporation|llc|pty|plc)\b/i,
  /\b(recruitment|staffing|consulting|solutions|services|group|agency)\b/i,
  /\b(foundation|trust|society|association|hospital|health board)\b/i,
];

function looksReal(s: string) {
  return s.length > 2 && s.length < 100 && !/^\[.*\]$/.test(s) && !PLACEHOLDERS.has(s.trim().toLowerCase());
}

function looksLikePersonName(s: string): boolean {
  if (!looksReal(s)) return false;
  if (ORG_PATTERNS.some((p) => p.test(s))) return false;
  const words = s.trim().split(/\s+/).filter(Boolean);
  return words.length >= 2 && words.length <= 5;
}

function cleanQuery(q: string): string {
  return q
    .replace(/^site:linkedin\.com\/in\s*/i, "")
    .replace(/\b\d+\+?\s*years?\b/gi, "")
    .replace(/\blocation\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const PAGE_SIZE = 10;
const MAX_PAGES = 30;
const MAX_PAGE_RETRIES = 3;
const EMPTY_ROUNDS_BEFORE_STOP = 2;
const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

type SearchProvider = "serpapi" | "bing";

interface SearchTaskOutcome extends SearchPageTaskResult<SearchResult> {
  provider: SearchProvider;
  query: string;
  error?: string;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function isRetryableSearchError(message: string): boolean {
  const status = message.match(/\b(\d{3})\b/)?.[1];
  if (status && RETRYABLE_STATUS_CODES.has(Number(status))) return true;

  const lower = message.toLowerCase();
  return (
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("network") ||
    lower.includes("fetch failed") ||
    lower.includes("temporarily unavailable") ||
    lower.includes("too many requests") ||
    lower.includes("rate limit")
  );
}

async function executeSearchTask(
  provider: SearchProvider,
  query: string,
  location: string,
  offset: number,
): Promise<SearchTaskOutcome> {
  try {
    const items = provider === "serpapi"
      ? await searchLinkedInProfiles(query, location, offset)
      : await searchBingLinkedInProfiles(query, location, offset);
    return { provider, query, items, retryable: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      provider,
      query,
      items: [],
      error: message,
      retryable: isRetryableSearchError(message),
    };
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;

  const parsed = SearchSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 });
  }
  const { maxResults, minScore, radiusKm, centerLat, centerLng } = parsed.data;

  const hasSerpApi = Boolean(process.env.SERPAPI_API_KEY);
  const hasBing    = Boolean(process.env.BING_API_KEY);
  const hasPDL     = Boolean(process.env.PDL_API_KEY);

  if (!hasSerpApi && !hasBing && !hasPDL) {
    return NextResponse.json({ error: "No search API configured. Add SERPAPI_API_KEY to .env.local." }, { status: 400 });
  }

  const { job, error } = await requireJobAccess(id, auth);
  if (error || !job) return error;

  const parsedRole = safeParseJson<ParsedRole | null>(job.parsedRole, null);
  if (!parsedRole) {
    return NextResponse.json({ error: "Analyse the job description first before searching." }, { status: 400 });
  }

  const location = parsedRole.location ?? "";
  const locationSource = location || parsedRole.location_rules || "";
  const salary = (job.salaryMin || job.salaryMax)
    ? { min: job.salaryMin ?? 0, max: job.salaryMax ?? 0 }
    : null;

  const customCenterCity = centerLat != null && centerLng != null ? getNearestCity(centerLat, centerLng) : null;
  const canonicalJobCity = getCityCoords(locationSource)?.name ?? "";
  const searchLocation = customCenterCity?.name ?? (canonicalJobCity || locationSource);
  const targetLocation = customCenterCity?.name ?? (location || canonicalJobCity || locationSource);
  const baseKeywords     = customCenterCity?.keywords ?? expandLocationKeywords(targetLocation);
  const jobCoords        = getCityCoords(locationSource);
  const searchCenter     = centerLat != null && centerLng != null
    ? { lat: centerLat, lng: centerLng }
    : (jobCoords ? { lat: jobCoords.lat, lng: jobCoords.lng } : null);
  const radiusKeywords   = searchCenter ? getCityKeywordsWithinRadius(searchCenter.lat, searchCenter.lng, radiusKm) : [];
  const locationKeywords = [...new Set([...baseKeywords, ...radiusKeywords])];

  // Build query pool: explicit search queries + synonym titles as standalone title searches
  // Synonym titles are the key insight — recruiters search off real titles, not JD language
  const synonymQueries = (parsedRole.synonym_titles ?? []).map(cleanQuery);
  const searchQueries = [
    ...synonymQueries,
    ...parsedRole.search_queries,
    ...parsedRole.google_queries,
    parsedRole.title,
  ]
    .map(cleanQuery)
    .filter(Boolean)
    .filter((q, i, arr) => arr.indexOf(q) === i)
    .slice(0, 12);
  const targetRaw = Math.min(Math.max(maxResults * 8, maxResults + 20), 400);

  try {
    const seenUrls = new Set<string>();
    const allRaw: SearchResult[] = [];

    // ── Phase 1a: PDL bulk fetch (not paginated — returns full profiles) ──────
    if (hasPDL) {
      try {
        const pdl = await searchPDLProfiles(parsedRole.title, searchLocation, Math.min(maxResults, 25));
        for (const r of pdl) {
          if (!seenUrls.has(r.linkedinUrl)) { seenUrls.add(r.linkedinUrl); allRaw.push(r); }
        }
        console.log(`[search] pdl: ${pdl.length} profiles`);
      } catch { /* ignore */ }
    }

    // ── Phase 1b: SerpAPI / Bing — paginate until we have enough raw results ──
    // Each round fires all queries for one page in parallel.
    // Retryable failures (rate limits / transient timeouts) back off and retry
    // the same page instead of ending the search early.
    const { items: collectedRaw, sawRetryableFailure: sawRetryableSearchFailure } =
      await collectPagedSearchResults<SearchResult>({
        targetCount: targetRaw,
        maxPages: MAX_PAGES,
        maxPageRetries: MAX_PAGE_RETRIES,
        emptyRoundsBeforeStop: EMPTY_ROUNDS_BEFORE_STOP,
        keyFn: (candidate) => candidate.linkedinUrl,
        getPage: async (page) => {
          const offset = page * PAGE_SIZE;
          const pageTasks: Promise<SearchTaskOutcome>[] = [];

          if (hasSerpApi) {
            pageTasks.push(...searchQueries.map((q) => executeSearchTask("serpapi", q, searchLocation, offset)));
          }
          if (hasBing) {
            pageTasks.push(...searchQueries.map((q) => executeSearchTask("bing", q, searchLocation, offset)));
          }

          if (pageTasks.length === 0) return null;
          return Promise.all(pageTasks);
        },
        sleep,
        onPage: ({ page, attempt, added, total, retryableFailures, hardFailures }) => {
          console.log(
            `[search] page ${page + 1}.${attempt + 1}: +${added} new (${total} total raw, target ${targetRaw}, retryable=${retryableFailures}, hard=${hardFailures})`
          );
          if (retryableFailures > 0 && added === 0) {
            const waitMs = Math.min(1500 * 2 ** attempt, 8000);
            console.warn(`[search] page ${page + 1}: retryable throttling detected, waiting ${waitMs}ms before retry`);
          }
        },
      });

    allRaw.push(...collectedRaw);
    for (const candidate of collectedRaw) {
      seenUrls.add(candidate.linkedinUrl);
    }

    console.log(`[search] collected ${allRaw.length} raw profiles (target ${targetRaw}, retryableFailures=${sawRetryableSearchFailure})`);

    if (allRaw.length === 0) {
      return NextResponse.json({
        count: 0, candidates: [],
        message: "No LinkedIn profiles found. Try re-analysing the job description.",
      });
    }

    // ── Phase 2: Skip already-imported profiles ──────────────────────────────
    // Normalise every URL before the DB lookup — search results arrive with
    // regional subdomains (nz.linkedin.com), tracking params (?trk=…), and
    // trailing slashes that won't match the canonical form we store.
    // Also deduplicate: two queries can return the same person under different raw URLs.
    const normSeen = new Set<string>();
    const allNormed = allRaw
      .map((r) => ({ ...r, linkedinUrl: normaliseLinkedInUrl(r.linkedinUrl) }))
      .filter((r) => {
        if (normSeen.has(r.linkedinUrl)) return false;
        normSeen.add(r.linkedinUrl);
        return true;
      });

    const existingUrls = new Set(
      (await prisma.candidate.findMany({
        where: { jobId: id, linkedinUrl: { in: allNormed.map((r) => r.linkedinUrl) } },
        select: { linkedinUrl: true },
      })).map((c) => c.linkedinUrl)
    );

    const allNew = allNormed.filter((r) => !existingUrls.has(r.linkedinUrl));
    console.log(`[search] ${allNew.length} new (${allNormed.length - allNew.length} already imported)`);

    if (allNew.length === 0) {
      return NextResponse.json({
        count: 0, candidates: [],
        message: "All found profiles are already in this job's candidate list.",
      });
    }

    // ── Phase 2b: Talent pool lookup ─────────────────────────────────────────
    // For any new result whose LinkedIn URL already has a full profile in our
    // DB (from a different job), reuse that profile instead of fetching again.
    // We still score them fresh against this job's requirements.
    const poolMap = await buildTalentPoolMap(
      allNew.map((r) => r.linkedinUrl),
      auth.isOwner ? null : auth.orgId,
    );
    console.log(`[search] talent pool: ${poolMap.size} of ${allNew.length} have existing full profiles`);

    type SavedCandidate = NonNullable<Awaited<ReturnType<typeof prisma.candidate.findFirst>>>;
    const saved: SavedCandidate[] = [];
    let scored = 0;
    let skippedScore = 0;
    let fromPool = 0;

    // Pre-filter name/location without touching AI, then cap at maxResults * 8.
    const toScore = allNew
      .filter((r) => {
        if (!looksLikePersonName(r.name)) return false;
        const poolLoc = poolMap.get(r.linkedinUrl)?.location ?? "";
        const loc = poolLoc || r.location || "";
        if (loc && !locationMatches(loc, locationKeywords)) return false;
        return true;
      })
      .slice(0, Math.max(maxResults * 12, maxResults + 20));

    console.log(`[search] ${toScore.length} candidates to score`);

    // Score every candidate with AI — same as original, but 10 at a time in parallel.
    const BATCH = 10;
    for (let i = 0; i < toScore.length && saved.length < maxResults; i += BATCH) {
      const batch = toScore.slice(i, i + BATCH);

      const results = await Promise.all(
        batch.map(async (r) => {
          const normUrl     = normaliseLinkedInUrl(r.linkedinUrl);
          const poolEntry   = poolMap.get(normUrl);
          const candidateLocation = poolEntry?.location ?? r.location ?? null;
          const profileText = poolEntry?.profileText ?? r.fullText ?? r.snippet ?? null;
          const textToScore = profileText ?? `${r.name}. ${r.headline}`.trim();
          const isFromPool  = !!poolEntry;
          scored++;

          const scoreData: Record<string, unknown> = {};
          let matchScore: number | null = null;
          let locationFitScore: number | null = null;
          try {
            const rawBreakdown = await scoreCandidateStructured(textToScore, parsedRole, salary);
            const breakdown = applyLocationFitOverride(
              rawBreakdown,
              candidateLocation,
              targetLocation,
              parsedRole.location_rules,
              job.isRemote,
            );
            matchScore = breakdown.overall;
            locationFitScore = breakdown.categories.location_fit.score;
            Object.assign(scoreData, deriveUpdateData(breakdown));
          } catch (err) {
            console.error(`[search] score failed for "${r.name}":`, err);
          }
          return { r, normUrl, poolEntry, candidateLocation, profileText, isFromPool, scoreData, matchScore, locationFitScore };
        })
      );

      console.log(`[search] batch done — running total scored=${scored}, saved=${saved.length}`);

      for (const item of results) {
        if (saved.length >= maxResults) break;
        const { r, normUrl, poolEntry, candidateLocation, profileText, isFromPool, scoreData, matchScore, locationFitScore } = item;

        if (candidateLocation && locationKeywords.length > 0 && !locationMatches(candidateLocation, locationKeywords)) {
          continue;
        }

        // Hard location cutoff: drop clearly out-of-area candidates for non-remote roles.
        // Score ≤20 means >150 km away; these slip through when SerpAPI reports the
        // company location instead of where the candidate actually lives.
        if (!job.isRemote && locationFitScore !== null && locationFitScore <= 20) {
          skippedScore++;
          continue;
        }

        if (minScore > 0 && (matchScore === null || matchScore < minScore)) {
          skippedScore++;
          continue;
        }

        try {
          const candidate = await prisma.candidate.create({
            data: {
              jobId: id,
              name: poolEntry?.name ?? r.name,
              headline: poolEntry?.headline ?? r.headline ?? null,
              location: candidateLocation,
              linkedinUrl: normUrl,
              profileText: profileText || null,
              source: isFromPool ? "talent_pool" : r.source,
              status: "new",
              ...(isFromPool && poolEntry?.profileCapturedAt
                ? { profileCapturedAt: poolEntry.profileCapturedAt }
                : {}),
              ...scoreData,
            },
          });
          saved.push(candidate as SavedCandidate);
          if (isFromPool) fromPool++;
        } catch (err) {
          console.error("[search] candidate save failed:", err);
        }
      }
    }

    console.log(`[search] done — scored ${scored}, saved ${saved.length} (${fromPool} from pool), skipped ${skippedScore} below ${minScore}%`);

    const sorted = saved.sort((a, b) => (b.matchScore ?? -1) - (a.matchScore ?? -1));

    if (sorted.length === 0) {
      const reason = skippedScore > 0
        ? `Scored ${scored} candidates but none cleared ${minScore}% — try lowering the minimum score or broadening the search.`
        : "No matching candidates found. Try re-analysing the job description or adjusting the search area.";
      return NextResponse.json({ count: 0, candidates: [], message: reason });
    }

    const poolNote = fromPool > 0 ? ` (${fromPool} from talent pool, ${saved.length - fromPool} from LinkedIn)` : "";
    const limitNote =
      saved.length < maxResults && sawRetryableSearchFailure
        ? " Search APIs throttled during collection, so RecruitMe retried and kept going, but results may still be partial."
        : "";
    return NextResponse.json({
      count: sorted.length,
      candidates: sorted,
      fromPool,
      message: sorted.length > 0 ? `Found ${sorted.length} candidates${poolNote}.${limitNote}`.trim() : undefined,
    });
  } catch (err) {
    console.error("Search error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Search failed" },
      { status: 500 }
    );
  }
}
