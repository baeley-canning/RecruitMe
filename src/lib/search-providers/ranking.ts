/**
 * Deterministic ranking of merged search results.
 *
 * Per critic feedback: ship MINIMAL. Multi-provider boost + provider-rank
 * average only. The 7-signal weighted scheme (LinkedIn URL boost, anchor
 * terms, NZ location, snippet quality, etc.) was deliberately cut from
 * this pass — those signals overlap with downstream scoring and need
 * real-data tuning before they earn their weights. Once we have prod data
 * showing this minimal rank produces sensible orderings, we tune.
 *
 * Higher rankScore = better. Sort descending to surface best first.
 */

import type { MergedResult } from "./types";

const MULTI_PROVIDER_BOOST = 15;

/** Compute rankScore for each MergedResult, in place. Returns the same
 *  array (sorted descending by rankScore) for caller convenience. */
export function rankMergedResults(results: MergedResult[]): MergedResult[] {
  for (const r of results) {
    const providerCount = Object.keys(r.providers).length;
    // Lower provider-rank = better. Average across providers, invert so
    // higher = better, scale to roughly the same magnitude as the boost.
    // Rank 0 → 10, rank 5 → 5, rank 10 → 0.
    const avgRank = Object.values(r.providers).reduce((sum, p) => sum + (p?.rank ?? 0), 0) / Math.max(providerCount, 1);
    const invertedRank = Math.max(0, 10 - avgRank);
    const multiBoost = providerCount >= 2 ? MULTI_PROVIDER_BOOST : 0;
    r.rankScore = invertedRank + multiBoost;
  }
  return [...results].sort((a, b) => b.rankScore - a.rankScore);
}
