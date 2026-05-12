/**
 * Adapter: convert MergedResult[] from the provider abstraction into the
 * EXISTING internal SearchResult shape (defined in src/lib/search.ts) that
 * the job-search route + downstream scoring already consume.
 *
 * Critic flagged: don't refactor downstream consumers — too broad, too
 * risky. Keep the boundary narrow. The new providers feed the existing
 * pipeline by emitting the same {name, headline, location, linkedinUrl,
 * snippet, source} shape, just from a different upstream.
 *
 * Strategy: reuse the existing `parseLinkedInResults` helper. It already
 * knows how to parse LinkedIn titles (split on " - " / " | "), extract
 * headline, infer location from snippet via inferLocationFromSearchText,
 * and filter out non-person names. Re-using it guarantees parity with the
 * SerpAPI / Bing path.
 *
 * "source" is set to the FIRST provider in the merge — for a multi-
 * provider hit we report it as whichever found it first (lowest rank).
 * This is informational only; downstream doesn't switch behaviour on these
 * values.
 */

import { parseLinkedInResults, type SearchResult } from "../search";
import type { MergedResult, SearchProviderName } from "./types";

/** Pick the provider with the lowest rank for source attribution. */
function pickPrimaryProvider(providers: MergedResult["providers"]): "searxng" | "openserp" {
  let bestRank = Infinity;
  let pick: SearchProviderName = "searxng";
  for (const [name, p] of Object.entries(providers) as Array<[SearchProviderName, { rank: number } | undefined]>) {
    if (!p) continue;
    if (p.rank < bestRank) {
      bestRank = p.rank;
      pick = name;
    }
  }
  // Constrain to free providers — serpapi would never appear here because
  // the manager doesn't instantiate a serpapi provider (existing SerpAPI
  // code remains independent), but TypeScript needs the narrowing.
  return pick === "openserp" ? "openserp" : "searxng";
}

/**
 * Map MergedResult[] to the existing internal SearchResult[]. Filters out
 * non-LinkedIn URLs and rows where the title doesn't look like a person —
 * the existing parseLinkedInResults handles both checks, so we delegate.
 */
export function mergedResultsToSearchResults(merged: MergedResult[]): SearchResult[] {
  // First group by source so parseLinkedInResults sees a homogeneous batch
  // per call — this preserves the existing function's contract.
  const bySource: Record<"searxng" | "openserp", Array<{ title?: string; url?: string; snippet?: string }>> = {
    searxng: [],
    openserp: [],
  };
  // Track which canonical URL came from which source so we can map back.
  for (const m of merged) {
    const src = pickPrimaryProvider(m.providers);
    bySource[src].push({ title: m.title, url: m.canonicalUrl, snippet: m.snippet });
  }
  const out: SearchResult[] = [];
  for (const src of ["searxng", "openserp"] as const) {
    out.push(...parseLinkedInResults(bySource[src], src));
  }
  return out;
}
