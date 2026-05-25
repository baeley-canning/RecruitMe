/**
 * LinkedIn search via SerpAPI for the multi-source talent search feature
 * (Phase 2a). Wraps the existing SerpAPI client (`searchLinkedInProfiles`)
 * with a ParsedQuery-driven query builder + light pagination + dedup, and
 * returns a normalised shape the caller persists / displays.
 *
 * Why a separate helper:
 *  • The job-import route at src/app/api/jobs/[id]/search/route.ts does
 *    SerpAPI fetching + scoring + persistence in one orchestrator. Phase 2a
 *    needs *just* the SerpAPI fetching for callers that want raw results
 *    (manual library import, scrape-trigger flows). This module extracts
 *    that slice without dragging in scoring or DB writes.
 *  • The helper does NOT read process.env — the caller supplies the
 *    SerpAPI key. That keeps unit tests deterministic and lets the caller
 *    fall back to the DB-stored key the same way the import route does.
 *
 * Cost discipline:
 *  • Each SerpAPI page request costs ~$0.005. We fetch at most
 *    Math.ceil(limit / 10) pages, capped at 3 (= ~$0.015 per call) so a
 *    misconfigured caller can't blow the per-search budget.
 *  • Empty parsedQuery short-circuits before the first SerpAPI call.
 */

import type { ParsedQuery } from "../boolean-query";
import { searchLinkedInProfiles } from "../search";

const SERPAPI_PAGE_SIZE = 10;
const MAX_PAGES = 3;
const DEFAULT_LIMIT = 30;

export interface LinkedInSearchOptions {
  parsedQuery: ParsedQuery;
  location?: string | null;
  /** Hard upper bound. Default 30 — single SerpAPI page returns 10,
   *  so 30 = 3 pages max. Keeps cost per search predictable. */
  limit?: number;
  /** SerpAPI key. Caller must supply (route reads from env / settings
   *  table). Helper doesn't read env so it stays testable. */
  serpApiKey: string;
}

export interface LinkedInSearchResult {
  /** Canonical normalised LinkedIn URL (https://www.linkedin.com/in/slug). */
  linkedinUrl: string;
  /** Display name from SerpAPI snippet (may be "Unknown" or empty
   *  when SerpAPI couldn't extract a clean title). */
  name: string;
  /** Headline / title from the SerpAPI result. */
  headline: string | null;
  /** Location string (often inferred from snippet content). */
  location: string | null;
  /** Raw snippet text from SerpAPI — used for relevance filtering and
   *  shown to the recruiter in the search results UI. */
  snippet: string;
  /** Whichever Google result page this came from (1-indexed). Useful
   *  for de-prioritising deep-page results. */
  page: number;
}

/**
 * Build the Google-style boolean query string from a ParsedQuery.
 *
 * Output shape (concatenated with single spaces, trimmed):
 *   <mustHave...> (<anyOf1a> OR <anyOf1b>) -"mustNot1" +"location" site:linkedin.com/in/
 *
 * Notes:
 *  • Multi-word phrases are wrapped in quotes so Google treats them as
 *    a single phrase, matching how the recruiter likely typed them.
 *  • OR groups are wrapped in parens so the OR doesn't bind to the
 *    surrounding AND chain.
 *  • mustNot terms use `-"term"` — Google's negative-term syntax.
 *  • The trailing `site:linkedin.com/in/` is the scope filter so we
 *    only get profile URLs (not company pages, articles, jobs).
 *
 * Exported for testability — `searchLinkedIn` is the public surface but
 * tests want to assert on this string directly.
 */
export function buildLinkedInQueryString(
  parsedQuery: ParsedQuery,
  location?: string | null,
): string {
  const parts: string[] = [];

  // mustHave: quote phrases so Google treats multi-word terms as one.
  for (const term of parsedQuery.mustHave) {
    parts.push(quoteIfNeeded(term));
  }

  // anyOf: wrap each group as (A OR B). Each member quoted same way.
  for (const group of parsedQuery.anyOf) {
    if (group.length === 0) continue;
    if (group.length === 1) {
      parts.push(quoteIfNeeded(group[0]));
      continue;
    }
    const inner = group.map(quoteIfNeeded).join(" OR ");
    parts.push(`(${inner})`);
  }

  // mustNot: -"term" — always quote so the negation doesn't split on spaces.
  for (const term of parsedQuery.mustNot) {
    parts.push(`-"${term}"`);
  }

  // Location: +"<location>" forces it into the match (Google's +operator).
  if (location && location.trim().length > 0) {
    parts.push(`+"${location.trim()}"`);
  }

  // Scope to profile URLs only — drops company pages / articles / jobs.
  parts.push("site:linkedin.com/in/");

  return parts.join(" ").trim();
}

function quoteIfNeeded(term: string): string {
  // Already quoted? leave it.
  if (term.startsWith('"') && term.endsWith('"')) return term;
  // Wrap multi-word terms in quotes so Google reads them as a phrase.
  // Single-word terms are left bare — quoting them unnecessarily can
  // suppress Google's stemming (e.g. "developer" wouldn't match
  // "developers" / "development").
  if (/\s/.test(term)) return `"${term}"`;
  return term;
}

/**
 * Run a LinkedIn search via SerpAPI.
 *
 * Returns up to `limit` deduplicated profile results. Stops early when a
 * page returns fewer than SERPAPI_PAGE_SIZE results (Google has nothing
 * more to offer) or when we hit the per-call page cap.
 */
export async function searchLinkedIn(
  opts: LinkedInSearchOptions,
): Promise<LinkedInSearchResult[]> {
  const { parsedQuery, location = null, serpApiKey } = opts;
  const limit = Math.max(1, opts.limit ?? DEFAULT_LIMIT);

  // Empty query → bail before the first SerpAPI call. No point paying for
  // a search that has no terms to match.
  const hasTerms =
    parsedQuery.mustHave.length > 0 ||
    parsedQuery.anyOf.length > 0 ||
    parsedQuery.mustNot.length > 0;
  if (!hasTerms) return [];

  // Pagination plan: fetch Math.ceil(limit/10) pages, capped at MAX_PAGES.
  const pagesToFetch = Math.min(
    MAX_PAGES,
    Math.max(1, Math.ceil(limit / SERPAPI_PAGE_SIZE)),
  );

  // Build the query string once — same query, different page offsets.
  // We pass it to searchLinkedInProfiles as the `query` arg with an empty
  // location so the underlying client's `buildLinkedInSearchQuery` doesn't
  // double-prefix `site:linkedin.com/in` (our string already includes the
  // scope filter at the tail).
  const queryString = buildLinkedInQueryString(parsedQuery, location);

  const results: LinkedInSearchResult[] = [];
  const seenUrls = new Set<string>();

  for (let page = 0; page < pagesToFetch; page++) {
    if (results.length >= limit) break;

    const offset = page * SERPAPI_PAGE_SIZE;
    // searchLinkedInProfiles handles SerpAPI fetch, response parsing,
    // URL normalisation, and person-name filtering. We pass the
    // already-built query as the search term and "" as the location so
    // the client doesn't reshape our query further.
    const pageResults = await searchLinkedInProfiles(
      queryString,
      "",
      offset,
      serpApiKey,
    );

    // Empty page = Google has no more results for this query. Stop here
    // so we don't pay for empty page fetches.
    if (pageResults.length === 0) break;

    for (const item of pageResults) {
      if (results.length >= limit) break;
      // Dedup across pages — SerpAPI occasionally returns the same URL
      // on adjacent pages, especially when the query is broad.
      if (seenUrls.has(item.linkedinUrl)) continue;
      seenUrls.add(item.linkedinUrl);

      results.push({
        linkedinUrl: item.linkedinUrl,
        name: item.name,
        // SerpAPI client returns "" when a field is missing — normalise
        // to null so the caller can branch cleanly.
        headline: item.headline.length > 0 ? item.headline : null,
        location: item.location.length > 0 ? item.location : null,
        snippet: item.snippet,
        page: page + 1,
      });
    }

    // Short page → no more results upstream. Bail to save the next page's cost.
    if (pageResults.length < SERPAPI_PAGE_SIZE) break;
  }

  return results;
}
