/**
 * Internal types for the free-first search-provider abstraction.
 *
 * IMPORTANT: these types are INTERNAL to src/lib/search-providers/. They do
 * not replace the existing `SearchResult` type in src/lib/search.ts that the
 * job-search route consumes. The adapter module (adapter.ts) converts
 * MergedResult → the existing internal SearchResult shape so downstream
 * scoring and import flows stay untouched.
 *
 * Spec source: user request for "free-first search + model architecture"
 * (commit f9d7e20 of /Users/baeley/RecruitMe). Scope locked to "search
 * enrichment only — no candidate scoring changes".
 */

export type SearchProviderName = "searxng" | "openserp" | "serpapi";

/**
 * Per-provider result, AS SHAPED BY THE PROVIDER ABSTRACTION (the spec's flat
 * shape). Internal only — downstream code never sees this directly. The
 * existing internal `SearchResult` (in src/lib/search.ts) is what flows into
 * scoring / import.
 */
export interface ProviderSearchHit {
  /** Person name or page title, as the provider surfaced it. */
  title: string;
  /** Canonical URL — the provider's URL, NOT yet run through
   *  normaliseLinkedInUrl. Canonicalisation happens at the merge step. */
  url: string;
  /** Snippet / content preview the provider returned. May be empty. */
  snippet: string;
  /** Which provider produced this hit. */
  provider: SearchProviderName;
  /** 0-indexed position in the provider's response list. Used by the
   *  ranking module to credit providers that surface a candidate early. */
  rank: number;
  /** Raw provider response — for debugging only. NEVER persist this; strip
   *  before any database write or response payload. */
  raw?: unknown;
}

export interface SearchProviderOptions {
  query: string;
  /** Location hint to fold into the provider's query (e.g. "Wellington"). */
  location?: string;
  /** Cap on hits returned per provider. Providers should honour this where
   *  possible — most return 10 per page by default. */
  maxResults?: number;
  /** Hard timeout. When unset, the manager applies its own default. */
  timeoutMs?: number;
  /** Forwarded from the route — when true, append -intitle:"contract" style
   *  negative clauses to exclude contractor / freelance titles. */
  excludeContractTitles?: boolean;
}

export interface SearchProvider {
  name: SearchProviderName;
  /** Configuration check only — returns false when env vars / base URL are
   *  missing. Never makes a network call. */
  enabled(): boolean;
  /** Returns hits or throws. The manager wraps every call in a timeout +
   *  per-provider catch so providers don't need their own resilience layer
   *  beyond defensive parsing. */
  search(opts: SearchProviderOptions): Promise<ProviderSearchHit[]>;
}

/**
 * The output of the merge step. Preserves provenance so the ranking module
 * can credit multi-provider hits and the route can log which providers
 * surfaced which candidate.
 */
export interface MergedResult {
  /** Canonical URL produced by canonicalize() — the dedupe key. */
  canonicalUrl: string;
  /** First non-empty title across providers. */
  title: string;
  /** First non-empty snippet across providers. */
  snippet: string;
  /** Which providers produced this URL, with the rank each gave it. */
  providers: Partial<Record<SearchProviderName, { rank: number }>>;
  /** Computed rank score (higher = better) — set by ranking.ts. Ascending
   *  order maps to descending preference (lower index = better candidate). */
  rankScore: number;
}
