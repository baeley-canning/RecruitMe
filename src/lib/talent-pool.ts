/**
 * Talent Pool utilities
 *
 * The talent pool is the cross-job store of LinkedIn profiles already captured
 * in the local SQLite database. When a new search finds a LinkedIn URL we
 * already have a full profile for, we reuse it rather than fetching again —
 * saving LinkedIn requests and (most) AI token spend.
 *
 * Freshness: we store a profileCapturedAt timestamp. If the stored profile is
 * under FRESH_DAYS old we skip all AI calls. If it's older we still reuse the
 * stored text but re-score so staleness doesn't hurt match quality.
 *
 * Similarity: when the extension captures a new version of a profile we
 * compare it to the stored text. If ≥85% similar we skip extractCandidateInfo
 * and predictAcceptance (the two most expensive calls) and just re-score.
 */

import { prisma } from "./db";
import { hasFullCandidateProfile } from "./candidate-profile";
import { normaliseLinkedInUrl } from "./linkedin";
import {
  extractRoleAwareDistinctiveAnchors,
  extractSignalsFromRequirement,
  signalMatchesText,
} from "./requirement-signals";
import type { ParsedRole } from "./ai";
import { scoreCandidateStructured } from "./ai";
import { applyLocationFitOverride } from "./score-utils";
import { isExplicitlyOverseasLocation, isOverseasForNzRole, inferCandidateLocation } from "./location";
import type { ScoringWeights } from "./scoring-config";
import type { ScoreBreakdown } from "./scoring";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Days before a stored full profile is considered stale. */
export const FRESH_DAYS = 30;
/** Similarity threshold above which we treat a re-captured profile as unchanged. */
export const SIMILARITY_THRESHOLD = 0.85;

// ---------------------------------------------------------------------------
// Profile similarity
// ---------------------------------------------------------------------------

/**
 * Fast character-level similarity between two strings.
 * Uses length ratio + sampled character comparison to stay O(n) not O(n²).
 * Returns a value in [0, 1].
 */
export function profileSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;

  const shorter = a.length < b.length ? a : b;
  const longer  = a.length < b.length ? b : a;

  // Length ratio — if lengths are wildly different, profiles are different.
  const lengthRatio = shorter.length / longer.length;
  if (lengthRatio < 0.5) return lengthRatio; // Fast path: too different

  // Sample characters at evenly-spaced positions across the shorter string.
  const samples = Math.min(shorter.length, 400);
  const step = Math.max(1, Math.floor(shorter.length / samples));
  let matches = 0;
  let checked = 0;
  for (let i = 0; i < shorter.length; i += step) {
    checked++;
    if (shorter[i] === longer[i]) matches++;
  }
  const charSimilarity = checked > 0 ? matches / checked : 0;

  // Combined score: weight length ratio 30%, char similarity 70%.
  return lengthRatio * 0.3 + charSimilarity * 0.7;
}

/**
 * Returns true when the new profile text is similar enough to the stored one
 * that we can skip the expensive extractCandidateInfo + predictAcceptance calls.
 */
export function isProfileUnchanged(stored: string, incoming: string): boolean {
  return profileSimilarity(stored, incoming) >= SIMILARITY_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Talent pool types
// ---------------------------------------------------------------------------

export interface TalentPoolEntry {
  /** The Candidate row with the best / most-recent full profile for this URL. */
  candidateId: string;
  name: string;
  headline: string | null;
  location: string | null;
  profileText: string;
  profileCapturedAt: Date | null;
  /** Whether the stored profile is still within FRESH_DAYS. */
  isFresh: boolean;
}

// ---------------------------------------------------------------------------
// Pool lookup
// ---------------------------------------------------------------------------

/**
 * Given a list of LinkedIn URLs (from a fresh search), return a Map from
 * normalised URL → TalentPoolEntry for every URL that already has a full
 * profile stored in our DB.
 *
 * orgScope:
 *   - string         → single org (enforces strict isolation)
 *   - string[]       → multiple orgs (caller's own + cross-org grants)
 *   - null/undefined → all orgs (owner / no filtering)
 *
 * "Full profile" = enough captured text to be reusable for another job.
 * When multiple Candidate rows exist for the same URL, we prefer the one
 * with the most recent profileCapturedAt (or createdAt as fallback).
 */
export async function buildTalentPoolMap(
  linkedinUrls: string[],
  orgScope?: string | string[] | null,
): Promise<Map<string, TalentPoolEntry>> {
  if (linkedinUrls.length === 0) return new Map();

  // Normalise every URL to a canonical form before querying.
  const normMap = new Map<string, string>(); // normUrl → original url
  for (const url of linkedinUrls) {
    try {
      normMap.set(normaliseLinkedInUrl(url), url);
    } catch {
      // skip malformed URLs
    }
  }

  if (normMap.size === 0) return new Map();

  // Translate orgScope into a Prisma filter. The same candidate row could
  // sit on a job (job.orgId) or be a library-only row (jobId=null, orgId on
  // the candidate itself), so we OR both shapes when scoping by org.
  const orgFilter = (() => {
    if (orgScope == null) return {};
    const ids = Array.isArray(orgScope) ? orgScope : [orgScope];
    if (ids.length === 0) return { id: "__none__" };
    return {
      OR: [
        { job: { orgId: { in: ids } } },
        { jobId: null, orgId: { in: ids } },
      ],
    };
  })();

  // Fetch all candidates with a full profile whose URL is in our set.
  // We pull all matching rows and pick the best one per URL in JS because
  // SQLite doesn't support window functions in the version Prisma targets.
  const rows = await prisma.candidate.findMany({
    where: {
      linkedinUrl: { in: [...normMap.keys()] },
      profileText: { not: null },
      ...orgFilter,
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
    // id-desc secondary sort prevents bulk-insert timestamp-tie bias.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });

  const now = Date.now();
  const freshMs = FRESH_DAYS * 24 * 60 * 60 * 1000;
  const result = new Map<string, TalentPoolEntry>();

  for (const row of rows) {
    const profileText = row.profileText;
    if (!row.linkedinUrl || !profileText || !hasFullCandidateProfile(row)) continue;

    const normUrl = normaliseLinkedInUrl(row.linkedinUrl);
    if (!normMap.has(normUrl)) continue; // Not in the requested set

    const existing = result.get(normUrl);
    // Prefer the entry with the freshest capture timestamp.
    const rowAge = row.profileCapturedAt ?? row.createdAt;
    if (existing) {
      const existAge = existing.profileCapturedAt ?? new Date(0);
      if (rowAge <= existAge) continue; // Existing is newer
    }

    const capturedAt = row.profileCapturedAt;
    const ageMs = capturedAt ? now - capturedAt.getTime() : Infinity;

    result.set(normUrl, {
      candidateId: row.id,
      name: row.name,
      headline: row.headline,
      location: row.location,
      profileText,
      profileCapturedAt: capturedAt,
      isFresh: ageMs <= freshMs,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Pool-first criteria search
// ---------------------------------------------------------------------------
//
// `searchTalentPoolForRole` searches the candidate pool BY JOB CRITERIA
// (not by URL like `buildTalentPoolMap` does). The recruiter clicks "Find
// Candidates" → we look for matching people we already have profiles for
// before spending LinkedIn credits.
//
// Pre-ranking strategy:
//   1. Query org-scoped candidates with a usable full profile (single Prisma call).
//   2. Dedupe by normalised LinkedIn URL (most-recently-captured wins).
//   3. Drop candidates already on this job (excludeLinkedInUrls).
//   4. Drop candidates whose location is explicitly overseas (unless role
//      is remote) — same gate the LinkedIn flow uses.
//   5. Drop obvious senior/junior mismatches via headline regex.
//   6. For SPECIALIST roles (≥1 distinctive anchor), require at least one
//      role anchor in the candidate haystack — otherwise drop.
//   7. Rank remaining candidates by signal density (number of role anchors
//      matched in their haystack) and freshness, take top `shortlistLimit`.
//   8. Score the shortlist via `scoreCandidateStructured` (Claude full-profile).
//   9. Apply location-fit override and return top `maxResults` by overall.
//
// The shortlist limit caps Claude calls per pool search to a known maximum.
// Default is 30 — matches expected pool sizes (~200-500 unique candidates
// per org per audit) and gives Claude the top-decile of pre-rank candidates
// without burning the API budget.

export const POOL_SEARCH_DEFAULT_SHORTLIST = 30;

export interface TalentPoolSearchHit {
  candidateId: string;
  name: string;
  headline: string | null;
  location: string | null;
  /** Normalised LinkedIn URL — empty string if the row has no URL (manual import). */
  linkedinUrl: string;
  profileText: string;
  profileCapturedAt: Date | null;
  isFresh: boolean;
  /** Role-anchors matched in the candidate's haystack (for diagnostics). */
  matchedAnchors: string[];
  /** Pre-rank signal density: count of role anchors found in the haystack. */
  signalDensity: number;
}

export interface TalentPoolSearchResult {
  hit: TalentPoolSearchHit;
  scoreBreakdown: ScoreBreakdown;
  /** The location used for the score (after inference). */
  candidateLocation: string | null;
}

export interface TalentPoolSearchSummary {
  results: TalentPoolSearchResult[];
  /** All candidate rows the query returned BEFORE any filtering. */
  examined: number;
  /** After dedupe + gates, before pre-rank shortlist. */
  preRankPool: number;
  /** After pre-rank, sent to Claude. */
  shortlisted: number;
  /** Successfully scored by Claude (excludes Claude failures). */
  scored: number;
  /** Final results returned to the caller (after location override + maxResults clamp). */
  returned: number;
}

function buildPoolHaystack(row: {
  name: string;
  headline: string | null;
  location: string | null;
  profileText: string;
}): string {
  return [row.name, row.headline, row.location, row.profileText]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

function looksJuniorOnSeniorRole(headline: string | null, parsedRole: ParsedRole): boolean {
  const wantedSeniority = (parsedRole.seniority_band ?? "").toLowerCase();
  if (!/(mid|senior|lead|principal|manager|director|executive)/.test(wantedSeniority)) return false;
  const titleOnly = (headline ?? "").toLowerCase();
  return /^(junior|graduate|intern|internship|trainee|student|entry.?level|bootcamp|in training|seeking entry)/i.test(titleOnly);
}

export async function searchTalentPoolForRole(args: {
  parsedRole: ParsedRole;
  job: { isRemote: boolean };
  orgScope: string | string[] | null;
  /** URLs already attached to this job — those are excluded from the pool pass. */
  excludeLinkedInUrls: Set<string>;
  /** Final result count cap. */
  maxResults: number;
  /** Optional minimum overall score to include. */
  minScore?: number;
  weights?: ScoringWeights;
  /** Max candidates Claude-scores per pool search. Default 30. */
  shortlistLimit?: number;
  /** "Wellington, New Zealand" — used by location override. */
  targetLocation: string;
  /** Org id stamped on the score (for AI usage telemetry). null is fine for owners. */
  scoringOrgId: string | null;
  /** Salary band passed through to scoreCandidateStructured. */
  salary: { min: number; max: number } | null;
}): Promise<TalentPoolSearchSummary> {
  const {
    parsedRole, job, orgScope, excludeLinkedInUrls, maxResults,
    minScore = 0, weights, shortlistLimit = POOL_SEARCH_DEFAULT_SHORTLIST,
    targetLocation, scoringOrgId, salary,
  } = args;

  if (maxResults <= 0) {
    return { results: [], examined: 0, preRankPool: 0, shortlisted: 0, scored: 0, returned: 0 };
  }

  // Org-scope filter — same shape as buildTalentPoolMap. The candidate may
  // be attached to a job (job.orgId) OR sit as a library-only row (jobId
  // null with orgId on the candidate).
  const orgFilter = (() => {
    if (orgScope == null) return {};
    const ids = Array.isArray(orgScope) ? orgScope : [orgScope];
    if (ids.length === 0) return { id: "__none__" };
    return {
      OR: [
        { job: { orgId: { in: ids } } },
        { jobId: null, orgId: { in: ids } },
      ],
    };
  })();

  // Single broad query. We rely on (a) the orgId/linkedinUrl indexes and
  // (b) the realistic per-org pool size (~200-500 unique candidates per
  // the data-model audit) to keep this cheap. If a tenant outgrows that,
  // add a candidate full-text search index and refactor the pre-rank step.
  const rows = await prisma.candidate.findMany({
    where: {
      profileText: { not: null },
      ...orgFilter,
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
    // id-desc tiebreaker: a bulk insert (13.5k JobAdder rows sharing one
    // createdAt) was making the head of this query deterministically
    // name-sorted Z's, dominating the 2000-row slice. The secondary sort
    // gives a stable id-based head when timestamps collide.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    // Hard ceiling matches the candidates library cap. Pools larger than
    // this need a different strategy (full-text index / vector search).
    take: 2000,
  });

  const examined = rows.length;

  // Dedupe by normalised URL — same person across N jobs collapses to one
  // row, with the most-recently-captured profile preferred. Manual rows
  // without a URL are kept as-is and keyed by candidateId.
  const now = Date.now();
  const freshMs = FRESH_DAYS * 24 * 60 * 60 * 1000;
  const byUrl = new Map<string, TalentPoolSearchHit>();
  for (const row of rows) {
    const profileText = row.profileText;
    if (!profileText || !hasFullCandidateProfile(row)) continue;

    const normUrl = row.linkedinUrl ? normaliseLinkedInUrl(row.linkedinUrl) : "";
    const key = normUrl || `__manual__${row.id}`;
    if (excludeLinkedInUrls.has(normUrl)) continue;

    const capturedAt = row.profileCapturedAt;
    const ageMs = capturedAt ? now - capturedAt.getTime() : Infinity;
    const candidate: TalentPoolSearchHit = {
      candidateId: row.id,
      name: row.name,
      headline: row.headline,
      location: row.location,
      linkedinUrl: normUrl,
      profileText,
      profileCapturedAt: capturedAt,
      isFresh: ageMs <= freshMs,
      matchedAnchors: [],
      signalDensity: 0,
    };
    const prior = byUrl.get(key);
    if (!prior) { byUrl.set(key, candidate); continue; }
    const priorAge = prior.profileCapturedAt ?? new Date(0);
    const newAge   = capturedAt ?? new Date(0);
    if (newAge > priorAge) byUrl.set(key, candidate);
  }

  // Build the role anchor set ONCE (role-aware: hybrid IT-ops roles strip
  // ISMS / ISO 27001 from the gate; SCADA-only roles benefit from
  // domain-group expansion to substation/HV/metering).
  const roleAnchors = extractRoleAwareDistinctiveAnchors({
    title: parsedRole.title,
    requirements: [
      ...(parsedRole.must_haves ?? []),
      ...(parsedRole.skills_required ?? []),
      ...(parsedRole.knockout_criteria ?? []),
    ],
  }).map((a) => a.toLowerCase());
  const isSpecialistRole = roleAnchors.length > 0;

  // Build the must-have signal set for non-specialist signal density.
  const mustHaveSignals = new Set<string>();
  for (const r of [...(parsedRole.must_haves ?? []), ...(parsedRole.skills_required ?? [])]) {
    extractSignalsFromRequirement(r).forEach((s) => mustHaveSignals.add(s.toLowerCase()));
  }

  // Filter + pre-rank. This is local (no AI calls) so we can throw the whole
  // pool through it cheaply and only Claude-score the top shortlist.
  const preRanked: TalentPoolSearchHit[] = [];
  for (const candidate of byUrl.values()) {
    // Country gate. If the candidate's recorded location is explicitly
    // overseas (Sydney, Brisbane, etc.) and the role is NZ onsite, drop —
    // this matches the LinkedIn flow's gate at the equivalent point.
    if (
      candidate.location &&
      isExplicitlyOverseasLocation(candidate.location) &&
      !job.isRemote
    ) {
      continue;
    }

    // Junior-on-senior-role mismatch.
    if (looksJuniorOnSeniorRole(candidate.headline, parsedRole)) continue;

    const haystack = buildPoolHaystack(candidate);
    const matchedAnchors: string[] = [];
    let signalDensity = 0;
    for (const anchor of roleAnchors) {
      if (signalMatchesText(haystack, anchor)) {
        matchedAnchors.push(anchor);
        signalDensity++;
      }
    }

    if (isSpecialistRole && matchedAnchors.length === 0) continue;

    if (!isSpecialistRole) {
      // Non-specialist roles: rank by must-have signal density so the
      // pre-rank still favours profiles whose text overlaps the JD.
      for (const sig of mustHaveSignals) {
        if (signalMatchesText(haystack, sig)) signalDensity++;
      }
    }

    preRanked.push({ ...candidate, matchedAnchors, signalDensity });
  }

  // Sort by signal density desc, then freshness (fresh first), then capture
  // recency. This puts the strongest pool candidates in front of Claude.
  preRanked.sort((a, b) => {
    if (b.signalDensity !== a.signalDensity) return b.signalDensity - a.signalDensity;
    if (a.isFresh !== b.isFresh) return a.isFresh ? -1 : 1;
    const aTs = a.profileCapturedAt?.getTime() ?? 0;
    const bTs = b.profileCapturedAt?.getTime() ?? 0;
    return bTs - aTs;
  });

  const shortlist = preRanked.slice(0, shortlistLimit);

  // Claude full-profile scoring on the shortlist.
  const scored: TalentPoolSearchResult[] = [];
  for (const hit of shortlist) {
    try {
      const candidateLocation = inferCandidateLocation(
        hit.location,
        hit.profileText,
        null,
      );

      const rawBreakdown = await scoreCandidateStructured(
        hit.profileText,
        parsedRole,
        salary,
        weights,
        scoringOrgId,
      );
      const breakdown = applyLocationFitOverride(
        rawBreakdown,
        candidateLocation,
        targetLocation,
        parsedRole.location_rules,
        job.isRemote,
        weights,
      );

      // Country gate — the score breakdown's location_fit override is
      // advisory; if the candidate is genuinely NZ-incompatible (e.g.
      // Sydney explicitly + non-remote role) skip them entirely.
      if (
        candidateLocation &&
        isOverseasForNzRole(candidateLocation, job.isRemote)
      ) {
        continue;
      }

      // Stub captures from the new deterministic gate carry overall=0 + a
      // profile_capture_warning. Drop them from the pool import — recruiter
      // would just see them as "Unscored" and they'd pollute the result list.
      if (breakdown.profile_capture_warning) continue;
      if (breakdown.overall < minScore) continue;

      scored.push({
        hit,
        scoreBreakdown: breakdown,
        candidateLocation,
      });
    } catch (err) {
      console.warn(`[talent-pool-search] scoring failed for candidate ${hit.candidateId}`, err);
      // Continue — one Claude failure shouldn't kill the whole pool pass.
    }
  }

  // Final ordering by Claude overall, then take maxResults.
  scored.sort((a, b) => b.scoreBreakdown.overall - a.scoreBreakdown.overall);
  const results = scored.slice(0, maxResults);

  return {
    results,
    examined,
    preRankPool: preRanked.length,
    shortlisted: shortlist.length,
    scored: scored.length,
    returned: results.length,
  };
}
