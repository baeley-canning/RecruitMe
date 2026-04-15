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

    // Score candidates in order, save only those that pass minScore, stop at maxResults.
    // This means we never persist candidates the user didn't ask for and never burn
    // Claude tokens past the point where we have enough passing candidates.
    // We score at most maxResults * 8 raw candidates before giving up.
    const toScore = allNew.slice(0, maxResults * 8);

    type SavedCandidate = NonNullable<Awaited<ReturnType<typeof prisma.candidate.findFirst>>>;
    const saved: SavedCandidate[] = [];
    let scored = 0;
    let skippedScore = 0;

    for (let i = 0; i < toScore.length && saved.length < maxResults; i++) {
      const r = toScore[i];
      const name     = r.name;
      const headline = r.headline;
      const loc      = r.location || "";

      if (!looksLikePersonName(name)) {
        console.log(`[search] skip — bad name: "${name}"`);
        continue;
      }

      if (loc && !locationMatches(loc, locationKeywords)) {
        console.log(`[search] skip — location mismatch: "${loc}"`);
        continue;
      }

      const profileText = r.fullText ?? r.snippet ?? null;
      const textToScore = profileText ?? `${name}. ${headline}`.trim();

      scored++;
      console.log(`[search] [scored ${scored}, saved ${saved.length}/${maxResults}] "${name}" — ${textToScore.length}ch`);

      // ── Score first, save only if it passes ──────────────────────────────────
      // Overall score is deterministic — AI provides evidence, fns compute number.
      const scoreData: Record<string, unknown> = {};
      let matchScore: number | null = null;

      try {
        const breakdown = await scoreCandidateStructured(textToScore, parsedRole, salary);
        matchScore = breakdown.overall;
        Object.assign(scoreData, deriveUpdateData(breakdown));
      } catch (err) {
        console.error(`[search] score failed for "${name}":`, err);
        if (minScore > 0) { skippedScore++; continue; }
      }

      // Apply minScore filter before touching the DB
      if (minScore > 0 && matchScore !== null && matchScore < minScore) {
        console.log(`[search] skip — score ${matchScore} < threshold ${minScore}`);
        skippedScore++;
        continue;
      }

      try {
        const candidate = await prisma.candidate.create({
          data: {
            jobId: id,
            name,
            headline: headline || null,
            location: loc || location || null,
            linkedinUrl: r.linkedinUrl,
            profileText: profileText || null,
            source: r.source,
            status: "new",
            ...scoreData,
          },
        });
        saved.push(candidate as SavedCandidate);
      } catch (err) {
        console.error("[search] candidate save failed:", err);
      }
    }

    console.log(`[search] done — scored ${scored}, saved ${saved.length}, skipped ${skippedScore} below ${minScore}%`);

    const sorted = saved.sort((a, b) => (b.matchScore ?? -1) - (a.matchScore ?? -1));

    if (sorted.length === 0) {
      const reason = skippedScore > 0
        ? `Scored ${scored} candidates but none cleared ${minScore}% — try lowering the minimum score or broadening the search.`
        : "No matching candidates found. Try re-analysing the job description or adjusting the search area.";
      return NextResponse.json({ count: 0, candidates: [], message: reason });
    }

    return NextResponse.json({ count: sorted.length, candidates: sorted });
  } catch (err) {
    console.error("Search error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Search failed" },
      { status: 500 }
    );
  }
}
