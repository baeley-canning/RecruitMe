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
import {
  buildScoreBreakdown,
  CATEGORY_WEIGHTS_V2,
  classifyDataQuality,
  type MustHaveStatus,
  type NiceToHaveStatus,
  type ScoreBreakdown,
} from "@/lib/scoring";
import { expandLocationKeywords, isNzLocation, locationMatches, normalizeLocationText } from "@/lib/location";
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

const REQUIREMENT_STOP_WORDS = new Set([
  "ability", "across", "and", "any", "based", "build", "building", "candidate",
  "comfortable", "commitment", "development", "driven", "experience", "good",
  "have", "including", "knowledge", "mindset", "must", "new", "principles",
  "professional", "proficiency", "required", "role", "solid", "strong",
  "understanding", "using", "with", "work", "working", "years",
]);

const TECH_ALIASES: Array<[RegExp, string[]]> = [
  [/\bwordpress\b|content management system|\bcms\b/i, ["wordpress", "cms", "content management system"]],
  [/\bux\b|user experience/i, ["ux", "user experience", "ui/ux"]],
  [/web design|design principle|digital design/i, ["web design", "designer", "digital designer", "ui/ux"]],
  [/front.?end/i, ["front-end", "frontend", "front end", "html", "css", "javascript", "react"]],
  [/back.?end/i, ["back-end", "backend", "back end", "php", "node", "ruby", "python", "rails", ".net"]],
  [/full.?stack|front.?end.*back.?end|back.?end.*front.?end/i, ["full-stack", "full stack", "frontend", "backend"]],
  [/react/i, ["react", "react.js", "reactjs"]],
  [/ruby|rails|ror/i, ["ruby", "rails", "ruby on rails", "ror"]],
  [/python/i, ["python"]],
  [/docker|container/i, ["docker", "container", "containerisation", "containerization"]],
  [/typescript/i, ["typescript", "type script"]],
  [/javascript/i, ["javascript", "js"]],
  [/shopify/i, ["shopify"]],
  [/squarespace/i, ["squarespace", "square space"]],
  [/portfolio/i, ["portfolio"]],
];

function normaliseText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9+#.]+/g, " ").replace(/\s+/g, " ").trim();
}

function requirementSignals(requirement: string): string[] {
  const signals = new Set<string>();
  for (const [pattern, aliases] of TECH_ALIASES) {
    if (pattern.test(requirement)) aliases.forEach((alias) => signals.add(alias));
  }

  const tokens = requirement
    .toLowerCase()
    .match(/[a-z][a-z0-9+#.]{2,}/g) ?? [];
  for (const token of tokens) {
    if (!REQUIREMENT_STOP_WORDS.has(token)) signals.add(token);
  }

  return [...signals].slice(0, 8);
}

function hasSignal(text: string, signal: string): boolean {
  const normalisedSignal = normaliseText(signal);
  return Boolean(normalisedSignal) && text.includes(normalisedSignal);
}

function buildProvisionalSearchScore(
  result: SearchResult,
  parsedRole: ParsedRole,
  candidateLocation: string | null | undefined,
  targetLocation: string,
  locationRules: string | null | undefined,
  isRemote: boolean,
): ScoreBreakdown {
  const baseMustHaves = parsedRole.must_haves?.length ? parsedRole.must_haves : parsedRole.skills_required;
  const knockouts = parsedRole.knockout_criteria ?? [];
  const mustHaves = [
    ...baseMustHaves,
    ...knockouts.filter((ko) => !baseMustHaves.some((mh) => mh.toLowerCase().includes(ko.toLowerCase().slice(0, 25)))),
  ].slice(0, 14);
  const niceToHaves = (parsedRole.nice_to_haves?.length ? parsedRole.nice_to_haves : parsedRole.skills_preferred).slice(0, 6);
  const profileText = [result.name, result.headline, candidateLocation, result.snippet].filter(Boolean).join("\n");
  const haystack = normaliseText(profileText);

  const mustHaveCoverage: MustHaveStatus[] = mustHaves.map((requirement) => {
    if (/right to work|work rights|nz citizen|nz resident|\bvisa\b|work in new zealand/i.test(requirement)) {
      const nzBased = Boolean(candidateLocation && isNzLocation(candidateLocation));
      return {
        requirement,
        status: nzBased ? "likely" : "unknown",
        evidence: nzBased
          ? `Candidate appears NZ-based from the search location (${candidateLocation}); work rights still need confirmation.`
          : "Search snippet does not verify work rights.",
      };
    }

    const signals = requirementSignals(requirement);
    const matched = signals.filter((signal) => hasSignal(haystack, signal));
    return {
      requirement,
      status: matched.length > 0 ? "likely" : "unknown",
      evidence: matched.length > 0
        ? `Snippet/headline mentions ${matched.slice(0, 3).join(", ")}.`
        : "Not verifiable from search snippet.",
    };
  });

  const niceToHaveCoverage: NiceToHaveStatus[] = niceToHaves.map((requirement) => {
    const signals = requirementSignals(requirement);
    const matched = signals.filter((signal) => hasSignal(haystack, signal));
    return {
      requirement,
      status: matched.length > 0 ? "likely" : "absent",
      evidence: matched.length > 0
        ? `Snippet/headline mentions ${matched.slice(0, 3).join(", ")}.`
        : "Not mentioned in search snippet.",
    };
  });

  const supported = mustHaveCoverage.filter((c) => c.status === "confirmed" || c.status === "equivalent" || c.status === "likely").length;
  const mustHaveRatio = mustHaveCoverage.length ? supported / mustHaveCoverage.length : 0.5;
  const titleSignals = requirementSignals(parsedRole.title);
  const titleMatches = titleSignals.filter((signal) => hasSignal(normaliseText(`${result.headline} ${result.name}`), signal)).length;
  const titleScore = Math.min(85, Math.max(35, 45 + titleMatches * 15));
  const skillScore = Math.min(75, Math.round(35 + mustHaveRatio * 45));
  const keywordScore = Math.min(80, Math.round(35 + mustHaveRatio * 50));
  const seniorityText = normaliseText(result.headline);
  const wantedSeniority = (parsedRole.seniority_band ?? "").toLowerCase();
  const seniorityScore =
    wantedSeniority.includes("junior") && /\b(senior|lead|principal|head|manager|director)\b/.test(seniorityText) ? 45 :
    wantedSeniority.includes("senior") && /\b(junior|graduate|intern)\b/.test(seniorityText) ? 45 :
    70;

  const breakdown = buildScoreBreakdown({
    categories: {
      skill_fit:         { score: skillScore,     weight: CATEGORY_WEIGHTS_V2.skill_fit,         evidence: "Provisional score from LinkedIn search snippet." },
      location_fit:      { score: candidateLocation ? 75 : 50, weight: CATEGORY_WEIGHTS_V2.location_fit, evidence: candidateLocation ? `Search result location: ${candidateLocation}.` : "Location not available in search snippet." },
      seniority_fit:     { score: seniorityScore, weight: CATEGORY_WEIGHTS_V2.seniority_fit,     evidence: "Seniority inferred from headline only." },
      title_fit:         { score: titleScore,     weight: CATEGORY_WEIGHTS_V2.title_fit,         evidence: "Title fit inferred from LinkedIn headline." },
      industry_fit:      { score: 50,             weight: CATEGORY_WEIGHTS_V2.industry_fit,      evidence: "Industry cannot be reliably assessed from a search snippet." },
      nice_to_have_fit:  { score: 45,             weight: CATEGORY_WEIGHTS_V2.nice_to_have_fit,  evidence: "Nice-to-haves are provisional until the full profile is captured." },
      keyword_alignment: { score: keywordScore,   weight: CATEGORY_WEIGHTS_V2.keyword_alignment, evidence: "Keyword alignment inferred from snippet and headline." },
    },
    must_have_coverage: mustHaveCoverage,
    nice_to_have_coverage: niceToHaveCoverage,
    reasons_for: [
      `${result.name} appears in LinkedIn search for this role.`,
      result.headline ? `Headline: ${result.headline}.` : "Search result includes a candidate profile.",
    ],
    reasons_against: ["Only a LinkedIn search snippet is available; fetch the full profile for reliable scoring."],
    missing_evidence: ["Full LinkedIn profile text", "Detailed experience history", "Confirmed work rights"],
    recruiter_summary: "Provisional search match from a LinkedIn snippet. Fetch the full profile before treating the score as reliable.",
    profileCharCount: profileText.length,
  });

  return applyLocationFitOverride(breakdown, candidateLocation, targetLocation, locationRules, isRemote);
}

const PAGE_SIZE = 10;
const MAX_PAGES = 30;
const MAX_PAGE_RETRIES = 3;
const EMPTY_ROUNDS_BEFORE_STOP = 2;
const MAX_QUERY_VARIANTS = 6;
const SERPAPI_CONCURRENCY = 1;
const BING_CONCURRENCY = 2;
const SERPAPI_DELAY_MS = 400;
const BING_DELAY_MS = 150;
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

function limitQueriesForAttempt(queries: string[], page: number, attempt: number): string[] {
  const pageBaseLimit = page === 0 ? MAX_QUERY_VARIANTS : Math.min(4, MAX_QUERY_VARIANTS);
  const attemptPenalty = attempt * 2;
  const limit = Math.max(1, pageBaseLimit - attemptPenalty);
  return queries.slice(0, limit);
}

async function executeSearchTaskQueue(
  tasks: Array<{ provider: SearchProvider; query: string; location: string; offset: number }>,
  options: { concurrency: number; delayMs: number },
): Promise<SearchTaskOutcome[]> {
  const outcomes: SearchTaskOutcome[] = [];

  for (let i = 0; i < tasks.length; i += options.concurrency) {
    const batch = tasks.slice(i, i + options.concurrency);
    const batchOutcomes = await Promise.all(
      batch.map((task) => executeSearchTask(task.provider, task.query, task.location, task.offset))
    );
    outcomes.push(...batchOutcomes);

    if (i + options.concurrency < tasks.length) {
      await sleep(options.delayMs);
    }
  }

  return outcomes;
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
    parsedRole.title,
    ...synonymQueries,
    ...parsedRole.search_queries,
    ...parsedRole.google_queries,
  ]
    .map(cleanQuery)
    .filter(Boolean)
    .filter((q, i, arr) => arr.indexOf(q) === i)
    .slice(0, MAX_QUERY_VARIANTS);
  const targetRaw = Math.min(Math.max(maxResults * 3, maxResults + 15), 120);

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
        getPage: async (page, attempt) => {
          const offset = page * PAGE_SIZE;
          const queriesForAttempt = limitQueriesForAttempt(searchQueries, page, attempt);

          const buildTasks = (provider: SearchProvider, taskLocation: string, queries = queriesForAttempt) => {
            return queries.map((q) => ({
              provider,
              query: q,
              location: taskLocation,
              offset,
            }));
          };

          const serpTasks = hasSerpApi ? buildTasks("serpapi", searchLocation) : [];
          const bingTasks = hasBing ? buildTasks("bing", searchLocation) : [];
          if (serpTasks.length === 0 && bingTasks.length === 0) return null;

          const serpOutcomes = await executeSearchTaskQueue(serpTasks, {
            concurrency: SERPAPI_CONCURRENCY,
            delayMs: SERPAPI_DELAY_MS,
          });
          const bingOutcomes = await executeSearchTaskQueue(bingTasks, {
            concurrency: BING_CONCURRENCY,
            delayMs: BING_DELAY_MS,
          });
          const primaryOutcomes = [...serpOutcomes, ...bingOutcomes];
          const primaryItems = primaryOutcomes.flatMap((outcome) => outcome.items);
          const primaryRetryable = primaryOutcomes.some((outcome) => outcome.retryable);
          const shouldTryNzFallback =
            page === 0 &&
            primaryItems.length === 0 &&
            !primaryRetryable &&
            normalizeLocationText(searchLocation) !== "new zealand";

          if (!shouldTryNzFallback) return primaryOutcomes;

          const fallbackQueries = queriesForAttempt.slice(0, Math.min(3, queriesForAttempt.length));
          const fallbackSerpTasks = hasSerpApi ? buildTasks("serpapi", "New Zealand", fallbackQueries) : [];
          const fallbackBingTasks = hasBing ? buildTasks("bing", "New Zealand", fallbackQueries) : [];
          const fallbackOutcomes = [
            ...(await executeSearchTaskQueue(fallbackSerpTasks, {
              concurrency: SERPAPI_CONCURRENCY,
              delayMs: SERPAPI_DELAY_MS,
            })),
            ...(await executeSearchTaskQueue(fallbackBingTasks, {
              concurrency: BING_CONCURRENCY,
              delayMs: BING_DELAY_MS,
            })),
          ];
          return [...primaryOutcomes, ...fallbackOutcomes];
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
      if (sawRetryableSearchFailure) {
        return NextResponse.json({
          count: 0,
          candidates: [],
          message: "Search API was rate-limited before it returned profiles. Wait a minute and search again.",
        });
      }

      return NextResponse.json({
        count: 0, candidates: [],
        message: "No LinkedIn profiles found for the exact search area. Try broadening the radius or adding broader title variants.",
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

    // Pre-filter name/location before scoring, then cap the scoring pool.
    const toScore = allNew
      .filter((r) => {
        if (!looksLikePersonName(r.name)) return false;
        const poolLoc = poolMap.get(r.linkedinUrl)?.location ?? "";
        const loc = poolLoc || r.location || "";
        if (loc && !locationMatches(loc, locationKeywords)) return false;
        return true;
      })
      .slice(0, Math.min(Math.max(maxResults * 3, maxResults + 15), 100));

    console.log(`[search] ${toScore.length} candidates to score`);

    // Full profiles get Claude scoring. Search snippets get a fast provisional score
    // and are rescored properly once the extension captures the full LinkedIn page.
    const BATCH = 10;
    for (let i = 0; i < toScore.length && saved.length < maxResults; i += BATCH) {
      const batch = toScore.slice(i, i + BATCH);

      const results = await Promise.all(
        batch.map(async (r) => {
          const normUrl     = normaliseLinkedInUrl(r.linkedinUrl);
          const poolEntry   = poolMap.get(normUrl);
          const candidateLocation = poolEntry?.location ?? r.location ?? null;
          const searchProfileText = [r.name, r.headline, candidateLocation, r.snippet].filter(Boolean).join("\n");
          const profileText = poolEntry?.profileText ?? r.fullText ?? searchProfileText;
          const textToScore = profileText ?? `${r.name}. ${r.headline}`.trim();
          const isFromPool  = !!poolEntry;
          scored++;

          const scoreData: Record<string, unknown> = {};
          let matchScore: number | null = null;
          let locationFitScore: number | null = null;
          try {
            const hasFullProfile = classifyDataQuality(profileText?.length ?? 0) === "full_profile";
            const breakdown = hasFullProfile
              ? applyLocationFitOverride(
                  await scoreCandidateStructured(textToScore, parsedRole, salary),
                  candidateLocation,
                  targetLocation,
                  parsedRole.location_rules,
                  job.isRemote,
                )
              : buildProvisionalSearchScore(
                  r,
                  parsedRole,
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
            const fallback = buildProvisionalSearchScore(
              r,
              parsedRole,
              candidateLocation,
              targetLocation,
              parsedRole.location_rules,
              job.isRemote,
            );
            matchScore = fallback.overall;
            locationFitScore = fallback.categories.location_fit.score;
            Object.assign(scoreData, deriveUpdateData(fallback));
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

        // Hard location cutoff: drop candidates we KNOW are far out-of-area.
        // Only applies when candidateLocation is set — if it's empty, the AI had no location
        // data and may have defaulted to 0 (overseas assumption). Dropping a snippet with no
        // location info would silently discard candidates we simply can't assess yet.
        if (!job.isRemote && candidateLocation && locationFitScore !== null && locationFitScore <= 20) {
          skippedScore++;
          continue;
        }

        // Snippet/minimal candidates are capped at 55% (or 45% with a critical unconfirmed
        // must-have like NZ residency). Applying the full minScore would filter all of them
        // out when it's set to 50%+. Use a 30% floor for provisional data so candidates
        // worth fetching actually surface — the score updates to full once profile is fetched.
        const SNIPPET_MIN_FLOOR = 30;
        const isSnippetData = classifyDataQuality(profileText?.length ?? 0) !== "full_profile";
        const effectiveMin = isSnippetData ? Math.min(minScore, SNIPPET_MIN_FLOOR) : minScore;

        if (effectiveMin > 0 && (matchScore === null || matchScore < effectiveMin)) {
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
        ? `Scored ${scored} candidates but none cleared the threshold. Snippet-level results are capped at 55% — try lowering the minimum score below 30% or fetching full profiles.`
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
