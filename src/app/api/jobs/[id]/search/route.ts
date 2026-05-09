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
import {
  buildTargetLocationLabel,
  extractKnownLocationTargets,
  inferCandidateLocation,
  isExplicitlyOverseasLocation,
  isOverseasForNzRole,
  isNzLocation,
  normalizeLocationText,
} from "@/lib/location";
import { getCityCoords } from "@/lib/nz-cities";
import { buildScoreCacheKey, safeParseJson } from "@/lib/utils";
import { buildTalentPoolMap, type TalentPoolEntry } from "@/lib/talent-pool";
import { getAccessibleOrgIds } from "@/lib/org-access";
import { normaliseLinkedInUrl } from "@/lib/linkedin";
import { collectPagedSearchResults, type SearchPageTaskResult } from "@/lib/search-collection";
import { buildSearchEvaluation } from "@/lib/search-evaluation";
import { getAuth, requireJobAccess, unauthorized } from "@/lib/session";
import { getServerSetting } from "@/lib/settings";
import { getJobScoringWeights, type ScoringWeights } from "@/lib/scoring-config";
import { checkRateLimit, recordUsage } from "@/lib/usage";
import { reportError } from "@/lib/error-reporting";
import { hasFullCandidateProfile } from "@/lib/candidate-profile";
import { computeFetchPriority, serialiseFetchPriority } from "@/lib/fetch-priority";
import {
  buildProvisionalSearchScore as buildProvisionalSearchScoreLib,
  SCORE_CUTOFF_FULL_PROFILE,
  SCORE_CUTOFF_SNIPPET,
} from "@/lib/provisional-scoring";
import {
  extractRoleAwareDistinctiveAnchors,
  extractSignalsFromRequirement,
  normalizeSignalText,
  signalMatchesText,
  extractLegacyAnchorTerms,
  buildScarceSkillFallbackQueries,
} from "@/lib/requirement-signals";

// Allow up to 5 minutes for large search runs. Without this, Vercel and some
// proxy configurations cut the connection at ~30s leaving partial results.
// The route returns immediately with a sessionId; the background work uses this
// budget. Same value as score-all/route.ts for consistency.
export const maxDuration = 300;

const SearchSchema = z.object({
  maxResults: z.number().int().min(1).max(100).default(20),
  locationOverride: z.string().max(100).optional(),
  // When set, overrides parsedRole.search_queries — used by saved-search re-runs.
  queriesOverride: z.array(z.string()).max(20).optional(),
  // When set, the saved-search's lastRunAt is stamped at start and lastResultCount
  // is updated when the background run completes.
  savedSearchId: z.string().optional(),
  // When true, security clearance and NZ work-rights requirements are removed from
  // scoring for this search run so technically-qualified candidates aren't penalised
  // for missing clearance data that never appears on LinkedIn profiles.
  relaxClearance: z.boolean().optional().default(false),
});

// Regex matching requirements that should be excluded when relaxClearance is set.
const CLEARANCE_WORK_RIGHTS_RE = /security clearance|secret vetting|confidential vetting|nzsis|nz clearance|clearance eligib|work rights|right to work|nz citizen|nz resident|\bvisa\b|work in new zealand/i;

import { looksReal, looksLikePersonName, cleanQuery, dedupeQueries } from "@/lib/search-query-helpers";

function normaliseText(value: string): string {
  return normalizeSignalText(value);
}

function requirementSignals(requirement: string): string[] {
  return extractSignalsFromRequirement(requirement);
}

function hasSignal(text: string, signal: string): boolean {
  return signalMatchesText(text, signal);
}

function textHasTerm(value: string, term: string): boolean {
  return signalMatchesText(value, term);
}

function candidateSearchText(result: SearchResult, profileText?: string | null, candidateLocation?: string | null) {
  return [
    result.name,
    result.headline,
    candidateLocation ?? result.location,
    result.snippet,
    profileText ?? result.fullText,
  ].filter(Boolean).join("\n");
}

function looksUnderqualifiedForRole(result: SearchResult, parsedRole: ParsedRole): boolean {
  const wantedSeniority = (parsedRole.seniority_band ?? "").toLowerCase();
  if (!/(mid|senior|lead|principal|manager|director|executive)/.test(wantedSeniority)) return false;

  // Only check the job title / headline — not the whole snippet. Checking full snippet
  // text caused false positives: "I mentor junior engineers" or "Dev Academy graduate
  // from 2019" on a mid-career candidate's snippet would incorrectly drop them.
  // The headline is the current role title; snippet context is too broad.
  const titleOnly = normaliseText(result.headline ?? "");
  return /^(junior|graduate|intern|internship|trainee|student|entry.?level|bootcamp|in training|seeking entry)/i.test(titleOnly);
}

function hasSpecialistSourceSignal(result: SearchResult, parsedRole: ParsedRole, profileText?: string | null, candidateLocation?: string | null) {
  const terms = extractDistinctiveRequirementTerms(parsedRole);
  if (terms.length === 0) return true;

  const text = candidateSearchText(result, profileText, candidateLocation);
  const anchorTerms = extractAnchorRequirementTerms(parsedRole);

  // Re-audit found this gate was using anchorTerms EXCLUSIVELY when any were
  // present, ignoring the distinctive set entirely. Effect: a POWER role's
  // legacy anchors are only [SCADA, RTU] (RARE_ANCHOR_PATTERNS is narrow) so
  // a real Mercury / Vector field-service engineer with substation +
  // commissioning + HV + metering experience would fail the gate because
  // none of those terms are in the legacy list. Now we UNION the two sets
  // so any legitimate domain anchor — legacy OR distinctive — passes.
  // Also expand each anchor through requirement-signals so candidates
  // writing the long form ("programmable logic controller", "remote
  // terminal unit", "information security management system") are
  // recognised even when the short token isn't in their text.
  const combinedAnchors = new Set<string>([...anchorTerms, ...terms]);
  const candidateSignals = new Set(
    extractSignalsFromRequirement(text).map((s) => s.toLowerCase()),
  );
  return [...combinedAnchors].some((anchor) => {
    const lower = anchor.toLowerCase();
    if (candidateSignals.has(lower)) return true;
    // Fall back to the original direct-match for any anchor that isn't an
    // alias-table entry (e.g. AI-generated anchor_terms).
    return textHasTerm(text, anchor);
  });
}

// Thin wrapper that binds the local signal helpers to the extracted library
// function. Keeps all callers in this file unchanged.
function buildProvisionalSearchScore(
  result: SearchResult,
  parsedRole: ParsedRole,
  candidateLocation: string | null | undefined,
  targetLocation: string,
  locationRules: string | null | undefined,
  isRemote: boolean,
  weights?: ScoringWeights,
): ScoreBreakdown {
  return buildProvisionalSearchScoreLib(
    result, parsedRole, candidateLocation, targetLocation, locationRules, isRemote, weights,
    { requirementSignals, hasSignal, normaliseText },
  );
}


const PAGE_SIZE = 10;
const MAX_PAGES = 8;
const MAX_PAGE_RETRIES = 2;
const EMPTY_ROUNDS_BEFORE_STOP = 2;
const MAX_QUERY_VARIANTS = 6;
const MAX_SPECIALIST_QUERY_VARIANTS = 8;
const SERPAPI_CONCURRENCY = 1;
const BING_CONCURRENCY = 2;
const SERPAPI_DELAY_MS = 600;
const BING_DELAY_MS = 150;
const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

function extractDistinctiveRequirementTerms(parsedRole: ParsedRole): string[] {
  // Only must-haves and knockout criteria — nice-to-haves must not widen the
  // source gate, or a "nice to have React" on a Salesforce role would let any
  // React developer through regardless of Salesforce absence.
  //
  // Role-aware: for hybrid IT-ops roles ("Technology Support Manager", "IT
  // Operations Manager"), ISMS / ISO 27001 are stripped from the distinctive
  // set so they don't act as hard source-gate filters. They still inform the
  // SCORE through TECH alias matching and the importance multiplier — they
  // just don't gate. Pure compliance roles ("ISMS Lead", "CISO") keep the
  // full distinctive set including ISMS / ISO 27001.
  return extractRoleAwareDistinctiveAnchors({
    title: parsedRole.title,
    requirements: [
      ...(parsedRole.must_haves ?? []),
      ...(parsedRole.skills_required ?? []),
      ...(parsedRole.knockout_criteria ?? []),
    ],
  });
}

function extractAnchorRequirementTerms(parsedRole: ParsedRole): string[] {
  // Prefer AI-generated anchors from the parse step — these work for ANY technology.
  if (parsedRole.anchor_terms?.length) {
    return parsedRole.anchor_terms.slice(0, 5);
  }

  // Fallback for roles parsed before anchor_terms was added.
  // Uses a narrow rare-tech list so common tools (Azure, SQL, .NET) don't
  // become anchors and over-restrict the search.
  const hardRequirements = [
    ...(parsedRole.must_haves ?? []),
    ...(parsedRole.skills_required ?? []),
    ...(parsedRole.knockout_criteria ?? []),
  ];
  return extractLegacyAnchorTerms(hardRequirements);
}

const DB_ANCHOR_RE = /\b(sql|sybase|oracle|postgres|mysql|db2|database|rdbms|snowflake|dynamo)\b/i;

function buildSearchQueries(parsedRole: ParsedRole): string[] {
  const baseTitle = cleanQuery(parsedRole.title);
  const synonymQueries = (parsedRole.synonym_titles ?? []).map(cleanQuery);
  const aiQueries = [...parsedRole.search_queries, ...parsedRole.google_queries];
  const distinctiveTerms = extractDistinctiveRequirementTerms(parsedRole);
  const anchorTerms = extractAnchorRequirementTerms(parsedRole);

  const skillQueries: string[] = [];
  if (anchorTerms.length > 0) {
    // All anchors together — catches people who list multiple rare skills
    skillQueries.push(anchorTerms.join(" "));
    // Reversed order — "Sybase C++ developer" catches profiles that lead with the DB
    if (anchorTerms.length > 1) skillQueries.push([...anchorTerms].reverse().join(" "));
    // Title + all anchors
    skillQueries.push(`${baseTitle || "Software Developer"} ${anchorTerms.join(" ")}`);
    for (const term of anchorTerms) {
      skillQueries.push(`${term} developer`);
      // "dba" only makes sense for database anchors, not for React, JMeter, etc.
      if (DB_ANCHOR_RE.test(term)) skillQueries.push(`${term} dba`);
    }
  }
  if (distinctiveTerms.length > 0) {
    skillQueries.push(`${baseTitle || "Software Developer"} ${distinctiveTerms.slice(0, 2).join(" ")}`);
  }
  if (distinctiveTerms.length > 2) {
    skillQueries.push(distinctiveTerms.slice(0, 4).join(" "));
  }

  // Ordering: specialist skill queries first, then ALL AI-generated queries (most
  // semantically rich — written by Claude for this specific role), then title/synonyms.
  // AI queries were previously interleaved with synonyms and got sliced off for specialist
  // roles; they should take precedence over mechanical synonym expansion.
  return dedupeQueries([
    ...skillQueries,
    ...aiQueries,          // all AI queries before synonyms
    baseTitle,
    ...synonymQueries,
  ].filter(Boolean) as string[]).slice(0, anchorTerms.length > 0 ? MAX_SPECIALIST_QUERY_VARIANTS : MAX_QUERY_VARIANTS);
}

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

function isAuthFailure(message: string): boolean {
  const status = message.match(/\b(\d{3})\b/)?.[1];
  if (status && (status === "401" || status === "403")) return true;
  const lower = message.toLowerCase();
  return lower.includes("unauthorized") || lower.includes("invalid api key") || lower.includes("forbidden");
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
    return { provider, query, items: items.map((item) => ({ ...item, matchedQuery: query })), retryable: false };
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
  const { maxResults, locationOverride, queriesOverride, savedSearchId, relaxClearance } = parsed.data;

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
  const locationSource = [job.location, location, parsedRole.location_rules].filter(Boolean).join(" ");
  const salary = (job.salaryMin || job.salaryMax)
    ? { min: job.salaryMin ?? 0, max: job.salaryMax ?? 0 }
    : null;
  const weights = await getJobScoringWeights(job.scoringWeights, auth.orgId);

  const knownTargets = extractKnownLocationTargets(job.location, location, parsedRole.location_rules);
  const canonicalJobCity = knownTargets[0] ?? getCityCoords(locationSource)?.name ?? "";
  const parsedSearchLocation = canonicalJobCity || locationSource;
  // For remote NZ roles, if no city is resolved, default to "New Zealand" so queries
  // are NZ-scoped rather than global. Without this, "remote" roles get an empty location
  // which produces a worldwide search and floods results with offshore candidates.
  const effectiveParsedLocation = parsedSearchLocation || (job.isRemote ? "New Zealand" : "");
  const searchLocation = locationOverride?.trim() || effectiveParsedLocation;
  const targetLocation = locationOverride?.trim() || buildTargetLocationLabel(job.location, location, parsedRole.location_rules) || location || canonicalJobCity || locationSource;

  // Build query pool with reserved slots for rare hard-skill terms. For niche
  // roles, terms like Sybase/C++ matter more than burning every slot on titles.
  // queriesOverride wins when present so saved-search re-runs use exactly the
  // queries the recruiter pinned, regardless of any later parsedRole changes.
  const cleanedOverride = queriesOverride
    ?.map((q) => (typeof q === "string" ? q.trim() : ""))
    .filter(Boolean);
  const searchQueries = cleanedOverride && cleanedOverride.length > 0
    ? cleanedOverride
    : buildSearchQueries(parsedRole);
  const targetRaw = Math.min(Math.max(maxResults * 3, maxResults + 15), 120);

  // Stamp saved-search lastRunAt at start so the UI updates immediately. The
  // result count is filled in once the background run completes.
  if (savedSearchId) {
    // Scope by jobId AND orgId so a caller cannot accidentally (or deliberately)
    // stamp another org's saved search even if jobId routing were misconfigured.
    await prisma.savedSearch.updateMany({
      where: { id: savedSearchId, jobId: id, orgId: auth.orgId },
      data: { lastRunAt: new Date() },
    }).catch(() => {});
  }

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
    weights,
    maxResults,
    targetRaw,
    searchQueries,
    searchLocation,
    targetLocation,
    knownTargets,
    hasSerpApi,
    hasBing,
    hasPDL,
    serpApiKey,
    bingKey,
    pdlKey,
    isOwner: auth.isOwner,
    orgId: auth.orgId,
    savedSearchId,
    relaxClearance: relaxClearance ?? false,
  }).catch((err) => {
    reportError(err, { route: "search:background", jobId: id, orgId: auth.orgId });
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

  const importedIds = safeParseJson<string[]>(session.importedIds, []);
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
  job: { orgId: string | null; parsedRole: string | null; salaryMin: number | null; salaryMax: number | null; isRemote: boolean; location: string | null };
  parsedRole: ParsedRole;
  salary: { min: number; max: number } | null;
  weights: ScoringWeights;
  maxResults: number;
  targetRaw: number;
  searchQueries: string[];
  searchLocation: string;
  targetLocation: string;
  knownTargets: string[];  // all accepted cities from the parsed location (e.g. ["Wellington","Christchurch"])
  hasSerpApi: boolean;
  hasBing: boolean;
  hasPDL: boolean;
  serpApiKey: string;
  bingKey: string;
  pdlKey: string;
  isOwner: boolean;
  orgId: string | null;
  savedSearchId?: string;
  relaxClearance: boolean;
}) {
  const { sessionId, jobId, job, parsedRole, salary, weights, maxResults, targetRaw,
    searchQueries, searchLocation, targetLocation, knownTargets, hasSerpApi, hasBing, hasPDL,
    serpApiKey, bingKey, pdlKey, isOwner, orgId, savedSearchId, relaxClearance } = args;

  // When relaxClearance=true, remove clearance/work-rights requirements from scoring
  // for this search run. Candidates aren't penalised for not listing clearance on
  // LinkedIn — the recruiter handles eligibility verification separately.
  const parsedRoleForScoring: ParsedRole = relaxClearance
    ? {
        ...parsedRole,
        must_haves: parsedRole.must_haves.filter((r) => !CLEARANCE_WORK_RIGHTS_RE.test(r)),
        skills_required: parsedRole.skills_required.filter((r) => !CLEARANCE_WORK_RIGHTS_RE.test(r)),
        knockout_criteria: (parsedRole.knockout_criteria ?? []).filter((r) => !CLEARANCE_WORK_RIGHTS_RE.test(r)),
      }
    : parsedRole;

  // Compute once at the top so we can use anchor terms in the fallback pass below.
  const anchorTermsForFallback = extractAnchorRequirementTerms(parsedRole);

  try {
    const seenUrls = new Set<string>();
    const allRaw: SearchResult[] = [];
    // URLs found via the scarce-skill adjacent-skill fallback (e.g. SQL Server DBA
    // found when searching for a Sybase role). These candidates do not carry the
    // rare original term, so they must bypass the specialist source gate — they were
    // explicitly retrieved because of the skill substitution, not by accident.
    const scarceSkillFallbackUrls = new Set<string>();

    // ── Phase 1a: PDL bulk fetch (not paginated — returns full profiles) ──────
    if (hasPDL) {
      try {
        const pdl = await searchPDLProfiles(parsedRole.title, searchLocation, Math.min(maxResults, 50), pdlKey);
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
        // Dedupe by linkedinUrl ONLY. Including matchedQuery here means the
        // same person surfaced by two query variants counts twice toward the
        // raw target, ending the search before we've found enough unique
        // people. The first occurrence's matchedQuery is retained on the
        // SearchResult itself.
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

          // When the JD explicitly accepts candidates from multiple cities (e.g.
          // "Wellington, Christchurch"), search secondary cities in the same pass
          // so their candidates surface alongside the primary city results.
          // Only run on page 0 / attempt 0 to avoid runaway API usage.
          const secondaryCities = page === 0 && attempt === 0
            ? knownTargets.slice(1).filter(
                (city) => normalizeLocationText(city) !== normalizeLocationText(searchLocation)
              )
            : [];
          const secondarySerpTasks = hasSerpApi
            ? secondaryCities.flatMap((city) => buildTasks("serpapi", city, queriesForAttempt.slice(0, 2)))
            : [];
          const secondaryBingTasks = hasBing
            ? secondaryCities.flatMap((city) => buildTasks("bing", city, queriesForAttempt.slice(0, 2)))
            : [];

          if (serpTasks.length === 0 && bingTasks.length === 0 && secondarySerpTasks.length === 0 && secondaryBingTasks.length === 0) return null;

          const [serpOutcomes, bingOutcomes, secondarySerpOutcomes, secondaryBingOutcomes] = await Promise.all([
            executeSearchTaskQueue(serpTasks, { concurrency: SERPAPI_CONCURRENCY, delayMs: SERPAPI_DELAY_MS }),
            executeSearchTaskQueue(bingTasks, { concurrency: BING_CONCURRENCY, delayMs: BING_DELAY_MS }),
            executeSearchTaskQueue(secondarySerpTasks, { concurrency: SERPAPI_CONCURRENCY, delayMs: SERPAPI_DELAY_MS }),
            executeSearchTaskQueue(secondaryBingTasks, { concurrency: BING_CONCURRENCY, delayMs: BING_DELAY_MS }),
          ]);
          const primaryOutcomes = [...serpOutcomes, ...bingOutcomes, ...secondarySerpOutcomes, ...secondaryBingOutcomes];
          const anchorTerms = extractAnchorRequirementTerms(parsedRole);
          const shouldRunSpecialistNzSweep =
            page === 0 &&
            attempt === 0 &&
            anchorTerms.length > 0 &&
            normalizeLocationText(searchLocation) !== "new zealand";

          // "dba" only makes sense for database anchors — same rule as the per-city queries above
          const nzSweepQueries = dedupeQueries([
            anchorTerms.join(" "),
            `${parsedRole.title || "Software Developer"} ${anchorTerms.join(" ")}`,
            ...anchorTerms.flatMap((term) => [
              `${term} developer`,
              ...(DB_ANCHOR_RE.test(term) ? [`${term} dba`] : []),
            ]),
          ]).slice(0, 4);

          const specialistNzOutcomes = shouldRunSpecialistNzSweep
            ? [
                ...(await executeSearchTaskQueue(
                  hasSerpApi ? buildTasks("serpapi", "New Zealand", nzSweepQueries) : [],
                  { concurrency: SERPAPI_CONCURRENCY, delayMs: SERPAPI_DELAY_MS },
                )),
                ...(await executeSearchTaskQueue(
                  hasBing ? buildTasks("bing", "New Zealand", nzSweepQueries) : [],
                  { concurrency: BING_CONCURRENCY, delayMs: BING_DELAY_MS },
                )),
              ]
            : [];
          const primaryItems = [...primaryOutcomes, ...specialistNzOutcomes].flatMap((outcome) => outcome.items);
          const primaryRetryable = primaryOutcomes.some((outcome) => outcome.retryable);
          const normalizedSearch = normalizeLocationText(searchLocation);
          const shouldTryNzFallback =
            page === 0 &&
            primaryItems.length === 0 &&
            !primaryRetryable &&
            normalizedSearch !== "new zealand";

          if (!shouldTryNzFallback) return [...primaryOutcomes, ...specialistNzOutcomes];

          // Step 1: try Auckland specifically before going all-NZ — it's the largest NZ
          // talent pool and is worth a targeted pass for roles with scarce skills.
          const isAucklandAlready = normalizedSearch === "auckland";
          let aucklandOutcomes: typeof primaryOutcomes = [];
          if (!isAucklandAlready) {
            void prisma.searchSession.update({
              where: { id: sessionId },
              data: { message: `No results in ${searchLocation} — trying Auckland` },
            }).catch(() => {});
            const akQueries = queriesForAttempt.slice(0, Math.min(3, queriesForAttempt.length));
            aucklandOutcomes = [
              ...(await executeSearchTaskQueue(
                hasSerpApi ? buildTasks("serpapi", "Auckland", akQueries) : [],
                { concurrency: SERPAPI_CONCURRENCY, delayMs: SERPAPI_DELAY_MS },
              )),
              ...(await executeSearchTaskQueue(
                hasBing ? buildTasks("bing", "Auckland", akQueries) : [],
                { concurrency: BING_CONCURRENCY, delayMs: BING_DELAY_MS },
              )),
            ];
          }
          const aucklandItems = aucklandOutcomes.flatMap((o) => o.items);

          // Step 2: broaden to all of New Zealand if Auckland also returned nothing
          void prisma.searchSession.update({
            where: { id: sessionId },
            data: {
              message: aucklandItems.length > 0
                ? `No results in ${searchLocation} — found ${aucklandItems.length} in Auckland`
                : `No results in ${searchLocation} or Auckland — broadening to all of New Zealand`,
            },
          }).catch(() => {});

          if (aucklandItems.length > 0) {
            return [...primaryOutcomes, ...specialistNzOutcomes, ...aucklandOutcomes];
          }

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
          return [...primaryOutcomes, ...specialistNzOutcomes, ...aucklandOutcomes, ...fallbackOutcomes];
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
        await prisma.searchSession.update({
          where: { id: sessionId },
          data: {
            status: "rate_limited",
            message: "Rate-limited before any results were returned.",
            evaluation: "FAIL — Search APIs rate-limited. Wait a few minutes then Search Again — any candidates already imported won't duplicate.",
          },
        }).catch(() => {});
        return;
      }

      // ── Scarce-skill fallback: if anchors include rare tech (Sybase, COBOL, …)
      // build substitute queries using adjacent-skill alternatives and try once
      // before giving up. Sybase → SQL Server, COBOL → Java, etc.
      const fallbackQueries = buildScarceSkillFallbackQueries(anchorTermsForFallback);
      if (fallbackQueries.length > 0) {
        void prisma.searchSession.update({
          where: { id: sessionId },
          data: { message: `No exact matches — trying adjacent skills (${anchorTermsForFallback.join(", ")} substitutes)` },
        }).catch(() => {});

        const mkFallbackTasks = (provider: SearchProvider) =>
          fallbackQueries.map((q) => ({
            provider,
            query: q,
            location: "New Zealand",
            offset: 0,
            resolvedKey: provider === "serpapi" ? serpApiKey : bingKey,
          }));
        const fallbackSerpTasks = hasSerpApi ? mkFallbackTasks("serpapi") : [];
        const fallbackBingTasks = hasBing   ? mkFallbackTasks("bing")    : [];
        const fallbackOutcomes = [
          ...(await executeSearchTaskQueue(fallbackSerpTasks, { concurrency: SERPAPI_CONCURRENCY, delayMs: SERPAPI_DELAY_MS })),
          ...(await executeSearchTaskQueue(fallbackBingTasks, { concurrency: BING_CONCURRENCY,   delayMs: BING_DELAY_MS   })),
        ];

        // Surface auth failures immediately — invalid keys look like "no results" otherwise
        const authFailed = fallbackOutcomes.some((o) => o.error && isAuthFailure(o.error));
        if (authFailed) {
          const failedProvider = fallbackOutcomes.find((o) => o.error && isAuthFailure(o.error))?.provider ?? "search";
          await prisma.searchSession.update({
            where: { id: sessionId },
            data: {
              status: "complete",
              message: `${failedProvider} API key is invalid or expired.`,
              evaluation: `FAIL — ${failedProvider === "serpapi" ? "SerpAPI" : "Bing"} key rejected (401). Check Settings → API Keys and replace the key.`,
            },
          }).catch(() => {});
          return;
        }

        const fallbackResults = fallbackOutcomes.flatMap((o) => o.items);

        for (const r of fallbackResults) {
          if (!seenUrls.has(r.linkedinUrl)) {
            seenUrls.add(r.linkedinUrl);
            scarceSkillFallbackUrls.add(r.linkedinUrl);
            allRaw.push(r);
          }
        }

        if (allRaw.length > 0) {
          void prisma.searchSession.update({
            where: { id: sessionId },
            data: { message: `No exact ${anchorTermsForFallback.join("/")} matches — showing ${allRaw.length} adjacent-skill candidates` },
          }).catch(() => {});
          // Fall through to Phase 2 with the adjacent-skill results
        }
      }

      if (allRaw.length === 0) {
        await prisma.searchSession.update({
          where: { id: sessionId },
          data: {
            status: "complete",
            message: "No profiles found.",
            evaluation: "FAIL — No candidates found. Try: set Location to 'New Zealand', click Re-analyse to refresh search terms, or broaden requirements in the JD.",
          },
        }).catch(() => {});
        return;
      }
    }

    // ── Phase 2: Skip already-imported profiles ──────────────────────────────
    // Normalise every URL before the DB lookup — search results arrive with
    // regional subdomains (nz.linkedin.com), tracking params (?trk=…), and
    // trailing slashes that won't match the canonical form we store.
    // Also deduplicate: two queries can return the same person under different raw URLs.
    const byUrl = new Map<string, SearchResult>();
    for (const raw of allRaw) {
      const result = { ...raw, linkedinUrl: normaliseLinkedInUrl(raw.linkedinUrl) };
      const existing = byUrl.get(result.linkedinUrl);
      if (!existing) {
        byUrl.set(result.linkedinUrl, result);
        continue;
      }

      const matchedQueries = new Set(
        [existing.matchedQuery, result.matchedQuery].filter(Boolean) as string[]
      );
      byUrl.set(result.linkedinUrl, {
        ...existing,
        headline: existing.headline || result.headline,
        location: existing.location || result.location,
        snippet: [existing.snippet, result.snippet].filter(Boolean).join("\n"),
        fullText: existing.fullText || result.fullText,
        matchedQuery: [...matchedQueries].join("\n"),
      });
    }
    const allNormed = [...byUrl.values()];

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
    // Reuse profiles from any org the caller has library access to (own org +
    // cross-org library_read grants). Owner bypasses the filter. The synthetic
    // AuthResult only sets fields getAccessibleOrgIds reads (it keys on orgId
    // and short-circuits owners; userId is unused by that helper).
    const poolScope: string | string[] | null = isOwner
      ? null
      : (await getAccessibleOrgIds({ userId: "", orgId, isOwner: false })) ?? [];
    // Pool reuse is a credit-saving optimisation, not a correctness
    // requirement. If the lookup fails (DB timeout, transient pool error)
    // proceed with an empty pool map rather than aborting the whole search —
    // we can still score candidates against LinkedIn snippets and full PDL
    // fetches. Reported via reportError so the failure is visible.
    let poolMap = new Map<string, TalentPoolEntry>();
    try {
      poolMap = await buildTalentPoolMap(
        allNormed.map((r) => r.linkedinUrl),
        poolScope,
      );
    } catch (err) {
      console.warn("[search] talent pool lookup failed — continuing without pool reuse", err);
      reportError(err instanceof Error ? err : new Error(String(err)), {
        scope: "search.talentPoolLookup",
        jobId,
        urlCount: allNormed.length,
      });
    }
    const allNew = allNormed.filter((r) => !existingByUrl.has(r.linkedinUrl));
    const upgradeExisting = allNormed.filter((r) => {
      const existing = existingByUrl.get(r.linkedinUrl);
      return Boolean(existing && poolMap.has(r.linkedinUrl) && !hasFullCandidateProfile(existing));
    });
    type SearchWorkItem = { result: SearchResult; existingCandidate?: typeof existingCandidates[number] };
    type PrioritisedSearchWorkItem = SearchWorkItem & {
      fetchPriorityScore: number;
      fetchPriorityReason: string;
    };
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
    let skippedSourceGate = 0;
    let skippedSeniorityGate = 0;
    let skippedOverseas = 0;
    let skippedNameCheck = 0;
    let fromPool = 0;

    // Pre-filter: drop confirmed overseas candidates, non-person names, obvious
    // junior mismatches, and broad-search results with no specialist stack signal.
    // NZ candidates with any location (including generic "New Zealand") pass through —
    // applyLocationFitOverride handles fine-grained location scoring after fetch.
    const toScore: PrioritisedSearchWorkItem[] = workItems
      .map((workItem) => {
        const r = workItem.result;
        const normUrl = normaliseLinkedInUrl(r.linkedinUrl);
        const poolEntry = poolMap.get(normUrl);
        const profileText = poolEntry?.profileText ?? r.fullText ?? null;
        // When the structured location field is empty but the snippet/full
        // profile clearly mentions an NZ city (e.g. an Auckland-based
        // candidate whose LinkedIn metadata didn't populate `location`),
        // attribute the city from the text. Prevents Wellington searches
        // from leaking obviously-Auckland candidates through the gate.
        const candidateLocation = inferCandidateLocation(
          poolEntry?.location ?? r.location ?? null,
          profileText,
          r.snippet,
        );
        const priority = computeFetchPriority({
          result: r,
          parsedRole,
          candidateLocation,
          profileText,
          isFromTalentPool: Boolean(poolEntry),
          isRemote: job.isRemote,
        });
        return {
          ...workItem,
          fetchPriorityScore: priority.score,
          fetchPriorityReason: serialiseFetchPriority(priority.reason),
        };
      })
      .filter(({ result: r, fetchPriorityScore }) => {
        if (!looksLikePersonName(r.name)) { skippedNameCheck++; return false; }
        const normUrl = normaliseLinkedInUrl(r.linkedinUrl);
        const poolEntry = poolMap.get(normUrl);
        const poolLoc = poolMap.get(normUrl)?.location ?? "";
        const loc = poolLoc || poolEntry?.location || r.location || "";
        // Country gate: bare-city snippets ("Sydney" with no state/country)
        // used to slip through because OVERSEAS_MARKERS only listed
        // countries — OVERSEAS_CITIES (in lib/location.ts) now closes that
        // hole. NOT scanning headline because headlines often mention past
        // employer cities ("worked with London teams" → false positive).
        // Post-fetch, structured location takes over via stage-2 enrichment.
        if (loc && isExplicitlyOverseasLocation(loc)) { skippedOverseas++; return false; }
        if (looksUnderqualifiedForRole(r, parsedRole)) {
          skippedSeniorityGate++;
          return false;
        }
        const profileText = poolEntry?.profileText ?? r.fullText ?? null;
        const isFallbackCandidate = scarceSkillFallbackUrls.has(normaliseLinkedInUrl(r.linkedinUrl));
        if (!isFallbackCandidate && !hasSpecialistSourceSignal(r, parsedRole, profileText, loc || null)) {
          skippedSourceGate++;
          return false;
        }
        if (!isFallbackCandidate && !poolEntry && !r.fullText && fetchPriorityScore < 44) {
          skippedSourceGate++;
          return false;
        }
        return true;
      })
      .sort((a, b) => b.fetchPriorityScore - a.fetchPriorityScore)
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
          const fetchPriorityScore = workItem.fetchPriorityScore;
          const fetchPriorityReason = workItem.fetchPriorityReason;
          const normUrl     = normaliseLinkedInUrl(r.linkedinUrl);
          const poolEntry   = poolMap.get(normUrl);
          const candidateLocation = inferCandidateLocation(
            poolEntry?.location ?? r.location ?? null,
            poolEntry?.profileText ?? r.fullText ?? null,
            r.snippet,
          );
          const searchProfileText = [r.name, r.headline, candidateLocation, r.snippet].filter(Boolean).join("\n");
          const profileText = poolEntry?.profileText ?? r.fullText ?? searchProfileText;
          const textToScore = profileText ?? `${r.name}. ${r.headline}`.trim();
          const isFromPool  = !!poolEntry;
          scored++;

          const scoreData: Record<string, unknown> = {};
          let matchScore: number | null = null;
          const hasFullProfile = classifyDataQuality(profileText?.length ?? 0) === "full_profile";
          try {
            const breakdown = hasFullProfile
              ? applyLocationFitOverride(
                  await scoreCandidateStructured(textToScore, parsedRoleForScoring, salary, weights, orgId),
                  candidateLocation,
                  targetLocation,
                  parsedRoleForScoring.location_rules,
                  job.isRemote,
                  weights,
                )
              : buildProvisionalSearchScore(
                  r,
                  parsedRoleForScoring,
                  candidateLocation,
                  targetLocation,
                  parsedRoleForScoring.location_rules,
                  job.isRemote,
                  weights,
            );
            matchScore = breakdown.overall;
            Object.assign(scoreData, deriveUpdateData(breakdown));
            if (hasFullProfile) {
              scoreData.profileTextHash = buildScoreCacheKey({
                profileText,
                parsedRole,
                salary,
                jobLocation: job.location,
                isRemote: job.isRemote,
                weights,
              });
            }
          } catch (err) {
            reportError(err, { route: "search:score", jobId, orgId, candidateUrl: r.linkedinUrl ?? "unknown" });
            const fallback = buildProvisionalSearchScore(
              r,
              parsedRoleForScoring,
              candidateLocation,
              targetLocation,
              parsedRoleForScoring.location_rules,
              job.isRemote,
              weights,
            );
            matchScore = fallback.overall;
            Object.assign(scoreData, deriveUpdateData(fallback));
          }
          return { r, normUrl, poolEntry, existingCandidate, candidateLocation, profileText, isFromPool, scoreData, matchScore, fetchPriorityScore, fetchPriorityReason, hasFullProfile };
        })
      );

      console.log(`[search] batch done — running total scored=${scored}, saved=${saved.length}`);

      // ── Import-decision gate ─────────────────────────────────────────────
      // Three filters applied in order; any failure increments skippedScore
      // and skips to the next item. Keeping them together here makes the
      // rejection logic easy to audit in one place.
      const specialistRole = extractDistinctiveRequirementTerms(parsedRole).length > 0;
      for (const item of results) {
        if (saved.length >= maxResults) break;
        const { r, normUrl, poolEntry, existingCandidate, candidateLocation, profileText, isFromPool, scoreData, matchScore, fetchPriorityScore, fetchPriorityReason, hasFullProfile } = item;

        // Gate 1 — country. The pre-score filter already drops candidates
        // whose primary location string is explicitly overseas. After
        // scoring, `candidateLocation` may have been refined by inference
        // (e.g. profile text revealed "Sydney") — so we re-check at the
        // country level here. We deliberately DON'T re-apply the city-
        // distance reject (Auckland-vs-Wellington); city distance affects
        // ranking via location_fit, but NZ-wide candidates are kept.
        if (candidateLocation && isOverseasForNzRole(candidateLocation, job.isRemote)) {
          skippedScore++;
          continue;
        }

        // Gate 2 — score threshold for specialist roles.
        //   Full-profile: 45 (Claude has all the info; low score is a real "no")
        //   Snippet:      30 (provisional scores are conservative; same as floor)
        // Fallback candidates bypass this gate — they were retrieved as adjacent-skill
        // substitutes and their provisional score will naturally be lower because they
        // don't carry the exact rare term. Claude scoring after fetch will provide the
        // real signal.
        const isFallback = scarceSkillFallbackUrls.has(normUrl);
        const scoreCutoff = hasFullProfile ? SCORE_CUTOFF_FULL_PROFILE : SCORE_CUTOFF_SNIPPET;
        if (!isFallback && specialistRole && matchScore !== null && matchScore < scoreCutoff) {
          skippedScore++;
          continue;
        }

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
                fetchPriorityScore,
                fetchPriorityReason,
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
              orgId: job.orgId ?? null,
              name: poolEntry?.name ?? r.name,
              headline: poolEntry?.headline ?? r.headline ?? null,
              location: candidateLocation,
              linkedinUrl: normUrl,
              profileText: profileText || null,
              profileTextHash: null,
              fetchPriorityScore,
              fetchPriorityReason,
              source: isFromPool ? "talent_pool" : r.source,
              status: "new",
              // Snapshot the provisional score so we can show the delta after full-profile scoring.
              // Only set for snippet imports — pool entries with full profiles start calibrated.
              ...(!hasFullProfile && matchScore !== null ? { provisionalScore: matchScore } : {}),
              ...(isFromPool && poolEntry?.profileCapturedAt
                ? { profileCapturedAt: poolEntry.profileCapturedAt }
                : {}),
              ...scoreData,
            },
            update: {
              ...scoreData,
              fetchPriorityScore,
              fetchPriorityReason,
              // Never overwrite provisionalScore — it's a permanent snapshot of the import score
            }, // refresh score if already exists
          });
          saved.push(candidate as SavedCandidate);
          if (isFromPool) fromPool++;
        } catch (err) {
          console.error("[search] candidate save failed:", err);
        }
      }
    }

    console.log(`[search] done — scored ${scored}, saved ${saved.length} (${fromPool} from pool), skipped ${skippedScore} below score/location threshold, ${skippedSourceGate} source-gated, ${skippedSeniorityGate} seniority-gated`);

    const sorted = saved.sort((a, b) => (b.matchScore ?? -1) - (a.matchScore ?? -1));

    // Compute self-evaluation before writing the final session row.
    const totalExamined  = allNormed.length;
    const totalFiltered  = skippedNameCheck + skippedOverseas + skippedSeniorityGate + skippedSourceGate;
    const avgScore = sorted.length > 0
      ? Math.round(sorted.reduce((s, c) => s + (c.matchScore ?? 0), 0) / sorted.length)
      : null;
    const evaluation = buildSearchEvaluation({
      collected: sorted.length,
      avgScore,
      totalExamined,
      candidatesRejected: skippedSourceGate,
      totalFiltered,
      sawRetryableSearchFailure,
      // Pass the distinctive terms so the warning names the missing
      // anchors — the recruiter can decide whether to relax the JD or
      // accept the narrow pool.
      distinctiveAnchors: extractDistinctiveRequirementTerms(parsedRole),
    });

    const finalStatus = sawRetryableSearchFailure ? "rate_limited" : "complete";
    const importedIds = sorted.map((c) => c.id);

    await prisma.searchSession.update({
      where: { id: sessionId },
      data: {
        status:             finalStatus,
        collected:          sorted.length,
        importedIds:        JSON.stringify(importedIds),
        avgScore,
        candidatesRejected: skippedSourceGate,
        totalExamined,
        evaluation,
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
        status:      sawRetryableSearchFailure ? "rate_limited" : "complete",
        collected:   sorted.length,
        importedIds: JSON.stringify(sorted.map((c) => c.id)),
        message:     `Found ${sorted.length} candidates${poolNote}.${limitNote}`.trim(),
      },
    }).catch(() => {});

    if (savedSearchId) {
      await prisma.savedSearch.updateMany({
        where: { id: savedSearchId, jobId, orgId },
        data: { lastResultCount: sorted.length },
      }).catch(() => {});
    }
  } catch (err) {
    reportError(err, { route: "search:runBackground", jobId, orgId });
    await prisma.searchSession.update({
      where: { id: sessionId },
      data: { status: "rate_limited", message: err instanceof Error ? err.message : "Search failed" },
    }).catch(() => {});
  }
}
