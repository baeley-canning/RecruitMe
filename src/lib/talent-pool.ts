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
 * orgId — when provided, only considers candidates whose job belongs to that
 * org (enforces org isolation). Pass null to search across all orgs (owner).
 *
 * "Full profile" = enough captured text to be reusable for another job.
 * When multiple Candidate rows exist for the same URL, we prefer the one
 * with the most recent profileCapturedAt (or createdAt as fallback).
 */
export async function buildTalentPoolMap(
  linkedinUrls: string[],
  orgId?: string | null,
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

  // Fetch all candidates with a full profile whose URL is in our set.
  // We pull all matching rows and pick the best one per URL in JS because
  // SQLite doesn't support window functions in the version Prisma targets.
  const rows = await prisma.candidate.findMany({
    where: {
      linkedinUrl: { in: [...normMap.keys()] },
      profileText: { not: null },
      // Scope to the caller's org when one is set; owners see all profiles.
      ...(orgId != null ? { job: { orgId } } : {}),
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
