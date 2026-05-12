/**
 * Merge + dedupe step. Takes provider hits keyed by provider, collapses
 * duplicate URLs via canonicalizeUrl, preserves provenance so the ranking
 * step (and any downstream logging) knows which providers surfaced each
 * candidate.
 *
 * Pure function. No env reads, no network, no side effects.
 */

import { canonicalizeUrl } from "./canonical-url";
import type { MergedResult, ProviderSearchHit, SearchProviderName } from "./types";

/** Merge provider hits into a deduped MergedResult[]. */
export function mergeProviderHits(
  byProvider: Partial<Record<SearchProviderName, ProviderSearchHit[]>>,
): MergedResult[] {
  const merged = new Map<string, MergedResult>();
  for (const [providerName, hits] of Object.entries(byProvider) as Array<[SearchProviderName, ProviderSearchHit[]]>) {
    if (!Array.isArray(hits)) continue;
    for (const hit of hits) {
      const key = canonicalizeUrl(hit.url);
      if (!key) continue;
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, {
          canonicalUrl: key,
          title: hit.title,
          snippet: hit.snippet,
          providers: { [providerName]: { rank: hit.rank } },
          rankScore: 0, // ranking.ts fills this in
        });
        continue;
      }
      // Keep the longer non-empty title / snippet — providers vary in what
      // they extract from a LinkedIn result page. The longer one tends to
      // carry more usable signal (headline + employer + location vs just a
      // truncated title).
      if (!existing.title && hit.title) existing.title = hit.title;
      else if (hit.title.length > existing.title.length) existing.title = hit.title;
      if (!existing.snippet && hit.snippet) existing.snippet = hit.snippet;
      else if (hit.snippet.length > existing.snippet.length) existing.snippet = hit.snippet;
      existing.providers[providerName] = { rank: hit.rank };
    }
  }
  return [...merged.values()];
}
