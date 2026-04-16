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
import { deriveUpdateData } from "@/lib/score-utils";
import { expandLocationKeywords, locationMatches } from "@/lib/location";
import { getCityCoords, getCityKeywordsWithinRadius } from "@/lib/nz-cities";
import { safeParseJson } from "@/lib/utils";
import { buildTalentPoolMap } from "@/lib/talent-pool";
import { normaliseLinkedInUrl } from "@/lib/linkedin-capture";

const SearchSchema = z.object({
  maxResults: z.number().int().min(1).max(100).default(20),
  minScore:   z.number().int().min(0).max(100).default(0),
  radiusKm:   z.number().min(1).max(200).default(25),
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

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const parsed = SearchSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 });
  }
  const { maxResults, minScore, radiusKm } = parsed.data;

  const hasSerpApi = Boolean(process.env.SERPAPI_API_KEY);
  const hasBing    = Boolean(process.env.BING_API_KEY);
  const hasPDL     = Boolean(process.env.PDL_API_KEY);

  if (!hasSerpApi && !hasBing && !hasPDL) {
    return NextResponse.json({ error: "No search API configured. Add SERPAPI_API_KEY to .env.local." }, { status: 400 });
  }

  const job = await prisma.job.findUnique({ where: { id } });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const parsedRole = safeParseJson<ParsedRole | null>(job.parsedRole, null);
  if (!parsedRole) {
    return NextResponse.json({ error: "Analyse the job description first before searching." }, { status: 400 });
  }

  const location = parsedRole.location ?? "";
  const salary = (job.salaryMin || job.salaryMax)
    ? { min: job.salaryMin ?? 0, max: job.salaryMax ?? 0 }
    : null;

  const baseKeywords     = expandLocationKeywords(location);
  const coords           = getCityCoords(location);
  const radiusKeywords   = coords ? getCityKeywordsWithinRadius(coords.lat, coords.lng, radiusKm) : [];
  const locationKeywords = [...new Set([...baseKeywords, ...radiusKeywords])];

  // Build query pool: explicit search queries + synonym titles as standalone title searches
  // Synonym titles are the key insight — recruiters search off real titles, not JD language
  const synonymQueries = (parsedRole.synonym_titles ?? []).map(cleanQuery);
  const queries = [
    ...parsedRole.search_queries,
    ...parsedRole.google_queries,
    ...synonymQueries,
  ]
    .map(cleanQuery)
    .filter(Boolean)
    .filter((q, i, arr) => arr.indexOf(q) === i) // deduplicate
    .slice(0, 8); // up from 5 — synonyms add genuine breadth

  // How many raw candidates to collect before scoring.
  // 4× buffer so name/location filtering still leaves maxResults after scoring.
  const targetRaw   = Math.min(maxResults * 4, 400);
  const pageSize    = 10;
  const maxPages    = 20; // per query depth cap (200 results per query max)

  try {
    const seenUrls = new Set<string>();
    const allRaw: SearchResult[] = [];

    // ── Phase 1a: PDL bulk fetch (not paginated — returns full profiles) ──────
    if (hasPDL) {
      try {
        const pdl = await searchPDLProfiles(parsedRole.title, location, Math.min(maxResults, 25));
        for (const r of pdl) {
          if (!seenUrls.has(r.linkedinUrl)) { seenUrls.add(r.linkedinUrl); allRaw.push(r); }
        }
        console.log(`[search] pdl: ${pdl.length} profiles`);
      } catch { /* ignore */ }
    }

    // ── Phase 1b: SerpAPI / Bing — paginate until we have enough raw results ──
    // Each round fires all queries for one page in parallel, then advances.
    // Stops when: (a) targetRaw reached, (b) a round returns zero new results,
    // or (c) maxPages exceeded.
    for (let page = 0; page < maxPages && allRaw.length < targetRaw; page++) {
      const offset = page * pageSize;
      const pageTasks: Promise<SearchResult[]>[] = [];

      if (hasSerpApi) {
        pageTasks.push(...queries.map((q) => searchLinkedInProfiles(q, location, offset).catch(() => [])));
      }
      if (hasBing) {
        pageTasks.push(...queries.map((q) => searchBingLinkedInProfiles(q, location, offset).catch(() => [])));
      }

      if (pageTasks.length === 0) break;

      const pageResults = (await Promise.all(pageTasks)).flat();
      let newThisPage = 0;
      for (const r of pageResults) {
        if (!seenUrls.has(r.linkedinUrl)) { seenUrls.add(r.linkedinUrl); allRaw.push(r); newThisPage++; }
      }

      console.log(`[search] page ${page + 1}: +${newThisPage} new (${allRaw.length} total raw, target ${targetRaw})`);

      // If the search engines returned nothing at all this page, they're exhausted
      if (pageResults.length === 0) break;
      // If dedup removed everything (all already seen) for several pages, keep going
      // but stop if we hit the page cap above
    }

    console.log(`[search] collected ${allRaw.length} raw profiles across ${Math.min(Math.ceil(allRaw.length / (queries.length * pageSize)), maxPages)} page(s)`);

    if (allRaw.length === 0) {
      return NextResponse.json({
        count: 0, candidates: [],
        message: "No LinkedIn profiles found. Try re-analysing the job description.",
      });
    }

    // ── Phase 2: Skip already-imported profiles ──────────────────────────────
    const existingUrls = new Set(
      (await prisma.candidate.findMany({
        where: { jobId: id, linkedinUrl: { in: allRaw.map((r) => r.linkedinUrl) } },
        select: { linkedinUrl: true },
      })).map((c) => c.linkedinUrl)
    );

    const allNew = allRaw.filter((r) => !existingUrls.has(r.linkedinUrl));
    console.log(`[search] ${allNew.length} new (${allRaw.length - allNew.length} already imported)`);

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
    const poolMap = await buildTalentPoolMap(allNew.map((r) => r.linkedinUrl));
    console.log(`[search] talent pool: ${poolMap.size} of ${allNew.length} have existing full profiles`);

    type SavedCandidate = NonNullable<Awaited<ReturnType<typeof prisma.candidate.findFirst>>>;
    const saved: SavedCandidate[] = [];
    let scored = 0;
    let skippedScore = 0;
    let fromPool = 0;

    // Minimum characters of profile text before we bother calling the AI scorer.
    // SerpAPI snippets are typically 120–200 chars and give noisy, unreliable scores.
    // Candidates below this threshold are saved immediately with no score — the user
    // can fetch their full LinkedIn profiles to get a proper AI score.
    const MIN_SCORE_TEXT = 300;

    // Separate rich-text candidates (PDL full profiles, talent pool) from snippets.
    const richCandidates: SearchResult[] = [];
    const snippetCandidates: SearchResult[] = [];

    for (const r of allNew) {
      const loc = r.location || "";
      if (!looksLikePersonName(r.name)) continue;
      if (loc && !locationMatches(loc, locationKeywords)) continue;

      const normUrl   = normaliseLinkedInUrl(r.linkedinUrl);
      const poolEntry = poolMap.get(normUrl);
      const text = poolEntry?.profileText ?? r.fullText ?? r.snippet ?? "";
      if (text.length >= MIN_SCORE_TEXT) {
        richCandidates.push(r);
      } else {
        snippetCandidates.push(r);
      }
    }

    console.log(`[search] ${richCandidates.length} rich profiles to score, ${snippetCandidates.length} snippets to save unscored`);

    // ── Score rich candidates in parallel batches ─────────────────────────────
    const BATCH = 5;
    const toScore = richCandidates.slice(0, maxResults * 8);

    for (let i = 0; i < toScore.length && saved.length < maxResults; i += BATCH) {
      const batch = toScore.slice(i, i + BATCH);

      const results = await Promise.all(
        batch.map(async (r) => {
          const normUrl   = normaliseLinkedInUrl(r.linkedinUrl);
          const poolEntry = poolMap.get(normUrl);
          const profileText = poolEntry?.profileText ?? r.fullText ?? r.snippet ?? null;
          const textToScore = profileText ?? `${r.name}. ${r.headline}`.trim();
          const isFromPool  = !!poolEntry;
          scored++;

          const scoreData: Record<string, unknown> = {};
          let matchScore: number | null = null;
          try {
            const breakdown = await scoreCandidateStructured(textToScore, parsedRole, salary);
            matchScore = breakdown.overall;
            Object.assign(scoreData, deriveUpdateData(breakdown));
          } catch (err) {
            console.error(`[search] score failed for "${r.name}":`, err);
          }
          return { r, normUrl, poolEntry, profileText, isFromPool, scoreData, matchScore };
        })
      );

      for (const item of results) {
        if (saved.length >= maxResults) break;
        const { r, normUrl, poolEntry, profileText, isFromPool, scoreData, matchScore } = item;
        const loc = r.location || "";

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
              location: poolEntry?.location ?? loc ?? location ?? null,
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

    // ── Save snippet candidates without scoring ───────────────────────────────
    // These have too little text for reliable AI scoring. They appear unscored
    // in the candidate list; use Fetch Profile to get a real score.
    const snippetSlots = Math.max(0, maxResults - saved.length);
    const snippetsToSave = snippetCandidates.slice(0, snippetSlots);
    for (const r of snippetsToSave) {
      const normUrl = normaliseLinkedInUrl(r.linkedinUrl);
      const loc = r.location || "";
      try {
        const candidate = await prisma.candidate.create({
          data: {
            jobId: id,
            name: r.name,
            headline: r.headline || null,
            location: loc || location || null,
            linkedinUrl: normUrl,
            profileText: r.snippet || null,
            source: r.source,
            status: "new",
          },
        });
        saved.push(candidate as SavedCandidate);
      } catch (err) {
        console.error("[search] snippet save failed:", err);
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
    return NextResponse.json({
      count: sorted.length,
      candidates: sorted,
      fromPool,
      message: sorted.length > 0 ? `Found ${sorted.length} candidates${poolNote}` : undefined,
    });
  } catch (err) {
    console.error("Search error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Search failed" },
      { status: 500 }
    );
  }
}
