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
import { isExplicitlyOverseasLocation, isNzLocation, normalizeLocationText } from "@/lib/location";
import { getCityCoords } from "@/lib/nz-cities";
import { buildScoreCacheKey, safeParseJson } from "@/lib/utils";
import { buildTalentPoolMap } from "@/lib/talent-pool";
import { normaliseLinkedInUrl } from "@/lib/linkedin";
import { collectPagedSearchResults, type SearchPageTaskResult } from "@/lib/search-collection";
import { getAuth, requireJobAccess, unauthorized } from "@/lib/session";
import { getServerSetting } from "@/lib/settings";
import { checkRateLimit, recordUsage } from "@/lib/usage";

const SearchSchema = z.object({
  maxResults: z.number().int().min(1).max(100).default(20),
  locationOverride: z.string().max(100).optional(),
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
  return words.length >= 2 && words.length <= 6;
}

function hasFullProfile(profileText: string | null | undefined, profileCapturedAt?: Date | null) {
  return Boolean(profileCapturedAt || (profileText && profileText.trim().length >= 500));
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
const MAX_PAGES = 8;
const MAX_PAGE_RETRIES = 2;
const EMPTY_ROUNDS_BEFORE_STOP = 2;
const MAX_QUERY_VARIANTS = 4;
const SERPAPI_CONCURRENCY = 1;
const BING_CONCURRENCY = 2;
const SERPAPI_DELAY_MS = 600;
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
  tasks: Array<{ provider: SearchProvider; query: string; location: string; offset: number; resolvedKey?: string }>,
  options: { concurrency: number; delayMs: number },
): Promise<SearchTaskOutcome[]> {
  const outcomes: SearchTaskOutcome[] = [];

  for (let i = 0; i < tasks.length; i += options.concurrency) {
    const batch = tasks.slice(i, i + options.concurrency);
    const batchOutcomes = await Promise.all(
      batch.map((task) => executeSearchTask(task.provider, task.query, task.location, task.offset, task.resolvedKey))
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
  resolvedKey?: string,
): Promise<SearchTaskOutcome> {
  try {
    const items = provider === "serpapi"
      ? await searchLinkedInProfiles(query, location, offset, resolvedKey)
      : await searchBingLinkedInProfiles(query, location, offset, resolvedKey);
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
  const { maxResults, locationOverride } = parsed.data;

  // Resolve API keys: env var wins, then DB-stored (keys entered via settings UI).
  // We do NOT mutate process.env so changing a key in settings takes effect immediately
  // without requiring a server restart.
  const [dbSerpApi, dbBing, dbPdl] = await Promise.all([
    process.env.SERPAPI_API_KEY ? null : getServerSetting("SERPAPI_API_KEY"),
    process.env.BING_API_KEY    ? null : getServerSetting("BING_API_KEY"),
    process.env.PDL_API_KEY     ? null : getServerSetting("PDL_API_KEY"),
  ]);
  const serpApiKey = process.env.SERPAPI_API_KEY || dbSerpApi || "";
  const bingKey    = process.env.BING_API_KEY    || dbBing    || "";
  const pdlKey     = process.env.PDL_API_KEY     || dbPdl     || "";

  const hasSerpApi = Boolean(serpApiKey);
  const hasBing    = Boolean(bingKey);
  const hasPDL     = Boolean(pdlKey);

  if (!hasSerpApi && !hasBing && !hasPDL) {
    return NextResponse.json({ error: "No search API configured. Add SERPAPI_API_KEY to .env.local." }, { status: 400 });
  }

  const { job, error } = await requireJobAccess(id, auth);
  if (error || !job) return error;

  const rateCheck = await checkRateLimit(auth.orgId, "search");
  if (!rateCheck.allowed) {
    const waitMin = Math.ceil((rateCheck.retryAfterMs ?? 60000) / 60000);
    return NextResponse.json({ error: `Search rate limit reached. Try again in ~${waitMin} minute${waitMin !== 1 ? "s" : ""}.` }, { status: 429 });
  }

  const parsedRole = safeParseJson<ParsedRole | null>(job.parsedRole, null);
  if (!parsedRole) {
    return NextResponse.json({ error: "Analyse the job description first before searching." }, { status: 400 });
  }

  const location = parsedRole.location ?? "";
  const locationSource = location || parsedRole.location_rules || "";
  const salary = (job.salaryMin || job.salaryMax)
    ? { min: job.salaryMin ?? 0, max: job.salaryMax ?? 0 }
    : null;

  const canonicalJobCity = getCityCoords(locationSource)?.name ?? "";
  const parsedSearchLocation = canonicalJobCity || locationSource;
  const searchLocation = locationOverride?.trim() || parsedSearchLocation;
  const targetLocation = locationOverride?.trim() || location || canonicalJobCity || locationSource;

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

  const session = await prisma.searchSession.create({
    data: {
      jobId:    id,
      status:   "running",
      queries:  JSON.stringify(searchQueries),
      location: searchLocation,
      target:   maxResults,
      orgId:    auth.orgId,
    },
  });

  // Fire-and-forget: run search in background so the response returns immediately.
  // On Railway (persistent server) the Node.js event loop keeps running after the
  // response is sent, so the background promise completes normally.
  runSearchBackground({
    sessionId: session.id,
    jobId: id,
    job,
    parsedRole,
    salary,
    maxResults,
    targetRaw,
    searchQueries,
    searchLocation,
    targetLocation,
    hasSerpApi,
    hasBing,
    hasPDL,
    serpApiKey,
    bingKey,
    pdlKey,
    isOwner: auth.isOwner,
    orgId: auth.orgId,
  }).catch((err) => {
    console.error("[search] background task crashed:", err);
    prisma.searchSession.update({
      where: { id: session.id },
      data: { status: "rate_limited", message: err instanceof Error ? err.message : "Search crashed" },
    }).catch(() => {});
  });

  void recordUsage(auth.orgId, auth.userId, "search", { jobId: id, maxResults });

  return NextResponse.json({ sessionId: session.id, status: "running" });
}

// ── GET — poll a running or completed search session ──────────────────────────

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;

  // Verify job access before returning any session data.
  const { error: jobErr } = await requireJobAccess(id, auth);
  if (jobErr) return jobErr;

  const sessionId = new URL(req.url).searchParams.get("sessionId");
  if (!sessionId) return NextResponse.json({ error: "sessionId required" }, { status: 400 });

  let session = await prisma.searchSession.findUnique({ where: { id: sessionId } });
  if (!session || session.jobId !== id) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  // Mark stale sessions (running > 10 min) as failed — handles Railway restarts
  // that kill the background promise mid-search.
  if (session.status === "running") {
    const ageMs = Date.now() - session.createdAt.getTime();
    if (ageMs > 10 * 60 * 1000) {
      session = await prisma.searchSession.update({
        where: { id: sessionId },
        data: { status: "rate_limited", message: "Search timed out — try again." },
      });
    }
  }

  const importedIds: string[] = JSON.parse(session.importedIds || "[]");
  const candidates = importedIds.length > 0
    ? await prisma.candidate.findMany({
        where: { id: { in: importedIds } },
        orderBy: { matchScore: "desc" },
      })
    : [];

  return NextResponse.json({
    status: session.status,
    collected: session.collected,
    message: session.message,
    count: candidates.length,
    fromPool: candidates.filter((candidate) => candidate.source === "talent_pool").length,
    candidates,
  });
}

// ── Background search processor ───────────────────────────────────────────────

async function runSearchBackground(args: {
  sessionId: string;
  jobId: string;
  job: { parsedRole: string | null; salaryMin: number | null; salaryMax: number | null; isRemote: boolean; location: string | null };
  parsedRole: ParsedRole;
  salary: { min: number; max: number } | null;
  maxResults: number;
  targetRaw: number;
  searchQueries: string[];
  searchLocation: string;
  targetLocation: string;
  hasSerpApi: boolean;
  hasBing: boolean;
  hasPDL: boolean;
  serpApiKey: string;
  bingKey: string;
  pdlKey: string;
  isOwner: boolean;
  orgId: string | null;
}) {
  const { sessionId, jobId, job, parsedRole, salary, maxResults, targetRaw,
    searchQueries, searchLocation, targetLocation, hasSerpApi, hasBing, hasPDL,
    serpApiKey, bingKey, pdlKey, isOwner, orgId } = args;

  try {
    const seenUrls = new Set<string>();
    const allRaw: SearchResult[] = [];

    // ── Phase 1a: PDL bulk fetch (not paginated — returns full profiles) ──────
    if (hasPDL) {
      try {
        const pdl = await searchPDLProfiles(parsedRole.title, searchLocation, Math.min(maxResults, 25), pdlKey);
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
            const key = provider === "serpapi" ? serpApiKey : bingKey;
            return queries.map((q) => ({
              provider,
              query: q,
              location: taskLocation,
              offset,
              resolvedKey: key,
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
        await prisma.searchSession.update({ where: { id: sessionId }, data: { status: "rate_limited", message: "Rate-limited before any results were returned." } }).catch(() => {});
        return;
      }
      await prisma.searchSession.update({ where: { id: sessionId }, data: { status: "complete", message: "No profiles found." } }).catch(() => {});
      return;
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

    const existingCandidates = await prisma.candidate.findMany({
      where: { jobId: jobId, linkedinUrl: { in: allNormed.map((r) => r.linkedinUrl) } },
      select: {
        id: true,
        name: true,
        headline: true,
        location: true,
        linkedinUrl: true,
        profileText: true,
        profileCapturedAt: true,
      },
    });
    const existingByUrl = new Map<string, typeof existingCandidates[number]>();
    for (const candidate of existingCandidates) {
      if (!candidate.linkedinUrl) continue;
      existingByUrl.set(normaliseLinkedInUrl(candidate.linkedinUrl), candidate);
    }

    // ── Phase 2b: Talent pool lookup ─────────────────────────────────────────
    // For any search result whose LinkedIn URL already has a full profile in our
    // DB (usually from a different job), reuse that profile instead of fetching
    // again. Existing snippet rows in this job are upgraded in-place.
    const poolMap = await buildTalentPoolMap(
      allNormed.map((r) => r.linkedinUrl),
      isOwner ? null : orgId,
    );
    const allNew = allNormed.filter((r) => !existingByUrl.has(r.linkedinUrl));
    const upgradeExisting = allNormed.filter((r) => {
      const existing = existingByUrl.get(r.linkedinUrl);
      return Boolean(existing && poolMap.has(r.linkedinUrl) && !hasFullProfile(existing.profileText, existing.profileCapturedAt));
    });
    type SearchWorkItem = { result: SearchResult; existingCandidate?: typeof existingCandidates[number] };
    const workItems: SearchWorkItem[] = [
      ...upgradeExisting.map((result) => ({
        result,
        existingCandidate: existingByUrl.get(result.linkedinUrl),
      })),
      ...allNew.map((result) => ({ result })),
    ];
    console.log(`[search] ${allNew.length} new, ${upgradeExisting.length} existing snippets to upgrade (${allNormed.length - allNew.length - upgradeExisting.length} already imported)`);
    console.log(`[search] talent pool: ${poolMap.size} of ${allNormed.length} found URLs have existing full profiles`);

    if (workItems.length === 0) {
      await prisma.searchSession.update({ where: { id: sessionId }, data: { status: "complete", message: "All found profiles already imported." } }).catch(() => {});
      return;
    }

    type SavedCandidate = NonNullable<Awaited<ReturnType<typeof prisma.candidate.findFirst>>>;
    const saved: SavedCandidate[] = [];
    let scored = 0;
    let skippedScore = 0;
    let fromPool = 0;

    // Pre-filter: drop confirmed overseas candidates and non-person names before scoring.
    // NZ candidates with any location (including generic "New Zealand") pass through —
    // applyLocationFitOverride handles fine-grained location scoring after fetch.
    const toScore = workItems
      .filter(({ result: r }) => {
        if (!looksLikePersonName(r.name)) return false;
        const poolLoc = poolMap.get(r.linkedinUrl)?.location ?? "";
        const loc = poolLoc || r.location || "";
        if (loc && isExplicitlyOverseasLocation(loc)) return false;
        return true;
      })
      .slice(0, Math.min(Math.max(maxResults * 3, maxResults + 15), 100));

    console.log(`[search] ${toScore.length} candidates to score`);

    // Full profiles get Claude scoring; snippets get fast provisional scoring.
    // Batch size 3 to avoid concurrent Claude bursts when talent-pool/PDL full
    // profiles are in the result set (matches score-all concurrency).
    const BATCH = 3;
    for (let i = 0; i < toScore.length && saved.length < maxResults; i += BATCH) {
      const batch = toScore.slice(i, i + BATCH);

      const results = await Promise.all(
        batch.map(async (workItem) => {
          const r = workItem.result;
          const existingCandidate = workItem.existingCandidate;
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
            if (hasFullProfile) {
              scoreData.profileTextHash = buildScoreCacheKey({
                profileText,
                parsedRole,
                salary,
                jobLocation: job.location,
                isRemote: job.isRemote,
              });
            }
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
          return { r, normUrl, poolEntry, existingCandidate, candidateLocation, profileText, isFromPool, scoreData, matchScore, locationFitScore };
        })
      );

      console.log(`[search] batch done — running total scored=${scored}, saved=${saved.length}`);

      for (const item of results) {
        if (saved.length >= maxResults) break;
        const { r, normUrl, poolEntry, existingCandidate, candidateLocation, profileText, isFromPool, scoreData, locationFitScore } = item;

        // Hard location cutoff: drop candidates we KNOW are far out-of-area.
        // Only applies when candidateLocation is set — if it's empty, the AI had no location
        // data and may have defaulted to 0 (overseas assumption). Dropping a snippet with no
        // location info would silently discard candidates we simply can't assess yet.
        if (!job.isRemote && candidateLocation && locationFitScore !== null && locationFitScore <= 20) {
          skippedScore++;
          continue;
        }

        // Score filter is not applied during search — all snippet results surface
        // so the recruiter can fetch profiles and get proper scores before filtering.

        try {
          if (existingCandidate) {
            const candidate = await prisma.candidate.update({
              where: { id: existingCandidate.id },
              data: {
                name: poolEntry?.name ?? existingCandidate.name,
                headline: poolEntry?.headline ?? r.headline ?? existingCandidate.headline ?? null,
                location: candidateLocation,
                linkedinUrl: normUrl,
                profileText: profileText || null,
                profileTextHash: null,
                source: isFromPool ? "talent_pool" : r.source,
                ...(isFromPool && poolEntry?.profileCapturedAt
                  ? { profileCapturedAt: poolEntry.profileCapturedAt }
                  : {}),
                ...scoreData,
              },
            });
            saved.push(candidate as SavedCandidate);
            if (isFromPool) fromPool++;
            continue;
          }

          // upsert guards against the race where two concurrent searches
          // import the same LinkedIn URL into the same job simultaneously.
          const candidate = await prisma.candidate.upsert({
            where: { jobId_linkedinUrl: { jobId: jobId, linkedinUrl: normUrl } },
            create: {
              jobId: jobId,
              name: poolEntry?.name ?? r.name,
              headline: poolEntry?.headline ?? r.headline ?? null,
              location: candidateLocation,
              linkedinUrl: normUrl,
              profileText: profileText || null,
              profileTextHash: null,
              source: isFromPool ? "talent_pool" : r.source,
              status: "new",
              ...(isFromPool && poolEntry?.profileCapturedAt
                ? { profileCapturedAt: poolEntry.profileCapturedAt }
                : {}),
              ...scoreData,
            },
            update: scoreData, // refresh score if already exists
          });
          saved.push(candidate as SavedCandidate);
          if (isFromPool) fromPool++;
        } catch (err) {
          console.error("[search] candidate save failed:", err);
        }
      }
    }

    console.log(`[search] done — scored ${scored}, saved ${saved.length} (${fromPool} from pool), skipped ${skippedScore} below location threshold`);

    const sorted = saved.sort((a, b) => (b.matchScore ?? -1) - (a.matchScore ?? -1));

    const finalStatus = sawRetryableSearchFailure ? "rate_limited" : "complete";
    const importedIds = sorted.map((c) => c.id);

    await prisma.searchSession.update({
      where: { id: sessionId },
      data: {
        status:      finalStatus,
        collected:   sorted.length,
        importedIds: JSON.stringify(importedIds),
        message:     sorted.length === 0
          ? "No matching candidates found."
          : `Found ${sorted.length} candidate${sorted.length !== 1 ? "s" : ""}${sawRetryableSearchFailure ? " (partial — rate limited)" : ""}.`,
      },
    });

    if (sorted.length === 0) {
      const reason = sawRetryableSearchFailure
        ? "Search was rate-limited before returning results. Run search again — already-imported candidates won't be duplicated."
        : "No matching candidates found. Try re-analysing the job description.";
      await prisma.searchSession.update({
        where: { id: sessionId },
        data: { status: sawRetryableSearchFailure ? "rate_limited" : "complete", message: reason },
      }).catch(() => {});
      return;
    }

    const poolNote = fromPool > 0 ? ` (${fromPool} from talent pool, ${saved.length - fromPool} from LinkedIn)` : "";
    const limitNote = sawRetryableSearchFailure
      ? " Partially rate-limited — run again to find more."
      : "";
    await prisma.searchSession.update({
      where: { id: sessionId },
      data: {
        status: sawRetryableSearchFailure ? "rate_limited" : "complete",
        collected: sorted.length,
        importedIds: JSON.stringify(sorted.map((c) => c.id)),
        message: `Found ${sorted.length} candidates${poolNote}.${limitNote}`.trim(),
      },
    }).catch(() => {});
  } catch (err) {
    console.error("[search] background error:", err);
    await prisma.searchSession.update({
      where: { id: sessionId },
      data: { status: "rate_limited", message: err instanceof Error ? err.message : "Search failed" },
    }).catch(() => {});
  }
}
