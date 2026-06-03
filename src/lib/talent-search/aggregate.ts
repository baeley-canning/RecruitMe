/**
 * Multi-source result aggregator/deduper for the talent search feature
 * (Phase 2a). Pure function: takes the per-source result arrays from
 * `searchLibrary` and `searchLinkedIn`, runs them through the identity-merge
 * key (so the same person from both sources collapses to one row), and
 * returns a unified list the recruiter UI can render.
 *
 * Design notes:
 *
 *  • Dedup axis: identityMergeKey() from src/lib/identity-merge.ts. That's
 *    the same key the clustering script uses for auto-merge in PR 1, so a
 *    multi-source search row will collapse onto the same library row it
 *    would cluster to post-import — no surprises.
 *
 *  • Rows with NO usable merge key (synthetic library:<id> + no jobadder,
 *    or genuinely missing both) are treated as distinct. Their `id` falls
 *    back to candidateId / linkedinUrl. We don't try to "guess" a key from
 *    name + location — that's Tier 3 (manual only) per identity-merge.
 *
 *  • Source priority on shared fields: library wins. Library rows have been
 *    through the recruiter's hands (name may be edited, headline may come
 *    from a captured profile, location is reliable). LinkedIn snippet data
 *    is raw SerpAPI output and noisier. The one exception is `linkedinUrl`
 *    when the library row has a synthetic key — then the LinkedIn URL from
 *    the LinkedIn match fills in for display.
 *
 *  • Sort order: multi-source first (more sources = higher confidence),
 *    then library matchScore desc, then LinkedIn page asc, then id for
 *    deterministic ordering across test runs.
 *
 *  • No DB. No HTTP. The caller fetches both sources and hands us arrays.
 *    That keeps this module unit-testable without mocks and lets the
 *    multi-source route compose it freely.
 */

import { getCandidatePhotoUrl } from "../candidate-photo";
import {
  identityMergeKey,
  isSyntheticLibraryKey,
  mergeKeyToString,
} from "../identity-merge";
import type { LibrarySearchResult } from "./library";

/**
 * A LinkedIn discovery result. Relocated here from the deleted SerpAPI-backed
 * linkedin.ts (Phase K removed SerpAPI). The aggregator still accepts a
 * `linkedin: LinkedInSearchResult[]` slot so scraper-harvested rows can be
 * folded in later; the live LinkedIn path is now the durable SearchRun +
 * ScrapeJob pipeline, not a synchronous search call.
 */
export interface LinkedInSearchResult {
  linkedinUrl: string;
  name: string;
  headline: string | null;
  location: string | null;
  snippet: string;
  page: number;
}

export interface UnifiedResult {
  /** Stable ID for this aggregated result. Uses the identity merge key
   *  when available (preserved across re-runs of the same query),
   *  otherwise falls back to candidateId or linkedinUrl. */
  id: string;
  /** Display name. Library row's name takes priority. */
  name: string;
  headline: string | null;
  location: string | null;
  linkedinUrl: string | null;
  jobAdderUrl: string | null;
  photoUrl: string | null;
  /** Library matchScore, if present. LinkedIn results have null until
   *  AI scoring runs (which is post-import, not at search time). */
  matchScore: number | null;
  /** Sources this result appears in, deduped. Always at least one
   *  entry. Order: ["library", "linkedin"] when both. */
  sources: Array<"library" | "linkedin">;
  /** When sources includes "library", the underlying Candidate row id.
   *  Multi-source import uses this to attach existing library rows to
   *  the new job without re-creating a Candidate row. */
  candidateId: string | null;
  /** When sources includes "library", the existing CandidateIdentity id.
   *  Helps the import flow avoid re-clustering. */
  candidateIdentityId: string | null;
  /** Snippet text — library returns profileText slice, LinkedIn returns
   *  the SerpAPI snippet. Library takes priority when both present. */
  snippet: string | null;
  /** SerpAPI source page (1-indexed) when from LinkedIn. */
  linkedinPage: number | null;
  /** Keyword-relevance score from the library search (null for LinkedIn-only
   *  rows). Used as a sort tiebreaker so DB-first results keep their
   *  relevance order when matchScore is absent. */
  relevance: number | null;
}

export interface AggregateInput {
  library: LibrarySearchResult[];
  linkedin: LinkedInSearchResult[];
}

export interface AggregateOutput {
  results: UnifiedResult[];
  counts: {
    libraryRaw: number;
    linkedinRaw: number;
    deduped: number;
    total: number;
  };
}

/**
 * Aggregate per-source results into one deduplicated list.
 *
 * Algorithm:
 *  1. Walk library rows. For each, compute the merge-key string. If a row
 *     for that key already exists (defensive — SELECT should already dedup),
 *     pick the better one (higher matchScore, then newer createdAt).
 *     Rows with no merge key get a unique synthetic key based on candidateId.
 *  2. Walk LinkedIn rows. For each, compute the merge-key string. If a
 *     library row exists at that key, merge sources (library wins fields,
 *     LinkedIn fills in linkedinUrl/page). Otherwise track the LinkedIn-only
 *     row; on duplicate LinkedIn keys, the lower page wins.
 *  3. Sort and return with counts.
 */
export function aggregateSources(input: AggregateInput): AggregateOutput {
  const libraryRaw = input.library.length;
  const linkedinRaw = input.linkedin.length;

  // Keyed map of unified rows under construction. Key = mergeKeyToString()
  // when available, otherwise a synthetic "lib:<candidateId>" or
  // "li:<linkedinUrl>" string so distinct rows don't collide.
  const byKey = new Map<string, UnifiedResult>();

  // Track the underlying library row + LinkedIn row per key so the
  // dedup-within-source defensive picks can compare apples to apples
  // without leaking those fields onto UnifiedResult.
  const libraryByKey = new Map<string, LibrarySearchResult>();
  const linkedinByKey = new Map<string, LinkedInSearchResult>();

  // --- Pass 1: library rows ---------------------------------------------
  for (const row of input.library) {
    const mergeKey = identityMergeKey({
      linkedinUrl: row.linkedinUrl,
      jobAdderUrl: row.jobAdderUrl,
      // Include seekUrl so a SEEK row and a LinkedIn row for the same person
      // collapse to one result (Phase 0). LinkedIn > JobAdder > SEEK precedence
      // is handled inside identityMergeKey.
      seekUrl: row.seekUrl,
    });
    const keyString =
      mergeKeyToString(mergeKey) ?? `lib:${row.id}`;

    const existing = libraryByKey.get(keyString);
    if (existing) {
      // Defensive: same key appearing twice. Pick the better row.
      if (preferLibraryRow(row, existing)) {
        libraryByKey.set(keyString, row);
        byKey.set(keyString, libraryToUnified(row, keyString));
      }
      continue;
    }

    libraryByKey.set(keyString, row);
    byKey.set(keyString, libraryToUnified(row, keyString));
  }

  // --- Pass 2: LinkedIn rows --------------------------------------------
  for (const row of input.linkedin) {
    const mergeKey = identityMergeKey({
      linkedinUrl: row.linkedinUrl,
      jobAdderUrl: null,
      seekUrl: null,
    });
    const keyString = mergeKeyToString(mergeKey) ?? `li:${row.linkedinUrl}`;

    const existingLib = libraryByKey.get(keyString);
    if (existingLib) {
      // Merge: library row wins fields; LinkedIn adds source + page +
      // optionally a real linkedinUrl when the library row was synthetic.
      const current = byKey.get(keyString);
      if (!current) continue; // shouldn't happen — keep tsc happy
      byKey.set(keyString, mergeLibraryAndLinkedIn(current, existingLib, row));
      linkedinByKey.set(keyString, row);
      continue;
    }

    const existingLi = linkedinByKey.get(keyString);
    if (existingLi) {
      // Dedup within LinkedIn: lower page wins. Pages are 1-indexed; if
      // tied, keep the first encountered (sort-stable).
      if (row.page < existingLi.page) {
        linkedinByKey.set(keyString, row);
        byKey.set(keyString, linkedinToUnified(row, keyString));
      }
      continue;
    }

    linkedinByKey.set(keyString, row);
    byKey.set(keyString, linkedinToUnified(row, keyString));
  }

  // --- Sort -------------------------------------------------------------
  const results = Array.from(byKey.values()).sort(compareUnified);

  return {
    results,
    counts: {
      libraryRaw,
      linkedinRaw,
      deduped: libraryRaw + linkedinRaw - results.length,
      total: results.length,
    },
  };
}

/** Pick between two library rows for the same merge key. Returns true if
 *  `candidate` should replace `incumbent`. Higher matchScore wins; ties
 *  break to newer createdAt. */
function preferLibraryRow(
  candidate: LibrarySearchResult,
  incumbent: LibrarySearchResult,
): boolean {
  const candScore = candidate.matchScore ?? -Infinity;
  const incScore = incumbent.matchScore ?? -Infinity;
  if (candScore !== incScore) return candScore > incScore;
  return candidate.createdAt.getTime() > incumbent.createdAt.getTime();
}

function libraryToUnified(
  row: LibrarySearchResult,
  id: string,
): UnifiedResult {
  // Don't surface synthetic library:<id> placeholders to the UI. Treat
  // them as "no LinkedIn URL" for display purposes.
  const displayLinkedIn = isSyntheticLibraryKey(row.linkedinUrl)
    ? null
    : row.linkedinUrl;

  return {
    id,
    name: row.name,
    headline: row.headline,
    location: row.location,
    linkedinUrl: displayLinkedIn,
    jobAdderUrl: row.jobAdderUrl,
    photoUrl: getCandidatePhotoUrl({
      photoFileId: row.photoFileId,
      candidateId: row.id,
    }),
    matchScore: row.matchScore,
    sources: ["library"],
    candidateId: row.id,
    candidateIdentityId: row.candidateIdentityId,
    snippet: row.profileTextSnippet,
    linkedinPage: null,
    relevance: row.relevance,
  };
}

function linkedinToUnified(
  row: LinkedInSearchResult,
  id: string,
): UnifiedResult {
  return {
    id,
    name: row.name,
    headline: row.headline,
    location: row.location,
    linkedinUrl: row.linkedinUrl,
    jobAdderUrl: null,
    photoUrl: null,
    matchScore: null,
    sources: ["linkedin"],
    candidateId: null,
    candidateIdentityId: null,
    snippet: row.snippet.length > 0 ? row.snippet : null,
    linkedinPage: row.page,
    relevance: null,
  };
}

/** Compose a library-rooted unified row with a LinkedIn row's fill-in
 *  fields. Library wins on every shared display field; LinkedIn contributes
 *  the source tag, page number, and (when library was synthetic) the
 *  real linkedinUrl for display. */
function mergeLibraryAndLinkedIn(
  current: UnifiedResult,
  libRow: LibrarySearchResult,
  liRow: LinkedInSearchResult,
): UnifiedResult {
  // If library had a synthetic linkedinUrl, surface the LinkedIn match's
  // real URL so the UI can show / link to it.
  const linkedinUrl =
    current.linkedinUrl ?? liRow.linkedinUrl;

  // Library wins snippet when present; fall back to LinkedIn snippet only
  // if library had none (shouldn't usually happen — library rows always
  // have profileText — but stay defensive).
  const snippet = current.snippet ?? (liRow.snippet.length > 0 ? liRow.snippet : null);

  return {
    ...current,
    linkedinUrl,
    snippet,
    sources: ["library", "linkedin"],
    linkedinPage: liRow.page,
    // headline / location / name stay as the library row's values (already
    // on `current`). Reference libRow to keep eslint happy about the param.
    headline: current.headline ?? libRow.headline,
    location: current.location ?? libRow.location,
  };
}

/** Sort comparator for the unified result list:
 *  1. More sources first (multi-source = higher confidence).
 *  2. matchScore desc (library rows with scores rise; nulls sink).
 *  3. linkedinPage asc (page 1 > page 2; nulls — library-only — sink).
 *  4. id asc as deterministic tiebreaker. */
function compareUnified(a: UnifiedResult, b: UnifiedResult): number {
  if (a.sources.length !== b.sources.length) {
    return b.sources.length - a.sources.length;
  }
  const aScore = a.matchScore ?? -Infinity;
  const bScore = b.matchScore ?? -Infinity;
  if (aScore !== bScore) return bScore - aScore;

  // Relevance tiebreaker — keeps DB-first (library) results in their
  // keyword-relevance order when neither row has an AI matchScore yet.
  const aRel = a.relevance ?? -Infinity;
  const bRel = b.relevance ?? -Infinity;
  if (aRel !== bRel) return bRel - aRel;

  const aPage = a.linkedinPage ?? Number.POSITIVE_INFINITY;
  const bPage = b.linkedinPage ?? Number.POSITIVE_INFINITY;
  if (aPage !== bPage) return aPage - bPage;

  return a.id.localeCompare(b.id);
}
