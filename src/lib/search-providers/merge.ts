/**
 * Merge + dedupe step. Takes provider hits keyed by provider, collapses
 * duplicate URLs via canonicalizeUrl, preserves provenance so the ranking
 * step (and any downstream logging) knows which providers surfaced each
 * candidate.
 *
 * Pure function. No env reads, no network, no side effects.
 */

import { canonicalizeUrl } from "./canonical-url";
import { linkedInSlugAliasKey } from "../linkedin";
import type { MergedResult, ProviderSearchHit, SearchProviderName } from "./types";

const LINKEDIN_PROFILE_RE = /linkedin\.com\/in\//i;

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
  return collapseLinkedInSlugAliases([...merged.values()]);
}

/**
 * Second-pass dedupe: when two MergedResults are different canonical URLs
 * but share a LinkedIn slug alias key (e.g. `jane-smith` and
 * `jane-smith-1a2b3c4d`), they're the same person — collapse them.
 *
 * Only runs for LinkedIn profile URLs and only when the alias key is at
 * least 6 chars (matches the threshold in linkedInProfileMatches) to
 * avoid collisions on short names. Inputs that don't qualify pass through
 * unchanged.
 */
function collapseLinkedInSlugAliases(results: MergedResult[]): MergedResult[] {
  const groups = new Map<string, MergedResult[]>();
  const passthrough: MergedResult[] = [];
  for (const entry of results) {
    if (!LINKEDIN_PROFILE_RE.test(entry.canonicalUrl)) {
      passthrough.push(entry);
      continue;
    }
    const aliasKey = linkedInSlugAliasKey(entry.canonicalUrl);
    if (aliasKey.length < 6) {
      passthrough.push(entry);
      continue;
    }
    const bucket = groups.get(aliasKey) ?? [];
    bucket.push(entry);
    groups.set(aliasKey, bucket);
  }
  const out: MergedResult[] = [...passthrough];
  for (const group of groups.values()) {
    out.push(group.length === 1 ? group[0] : collapseAliasBucket(group));
  }
  return out;
}

function collapseAliasBucket(bucket: MergedResult[]): MergedResult {
  // Pick the primary: most providers wins, ties broken by shortest
  // canonicalUrl (the un-suffixed slug is the cleaner identity).
  const primary = bucket.reduce((best, cur) => {
    const bestCount = Object.keys(best.providers).length;
    const curCount = Object.keys(cur.providers).length;
    if (curCount > bestCount) return cur;
    if (curCount === bestCount && cur.canonicalUrl.length < best.canonicalUrl.length) return cur;
    return best;
  }, bucket[0]);
  // Fold every other entry's signal into the primary.
  for (const entry of bucket) {
    if (entry === primary) continue;
    if (!primary.title && entry.title) primary.title = entry.title;
    else if (entry.title.length > primary.title.length) primary.title = entry.title;
    if (!primary.snippet && entry.snippet) primary.snippet = entry.snippet;
    else if (entry.snippet.length > primary.snippet.length) primary.snippet = entry.snippet;
    for (const [name, rec] of Object.entries(entry.providers) as Array<[SearchProviderName, { rank: number }]>) {
      const existing = primary.providers[name];
      if (!existing || rec.rank < existing.rank) primary.providers[name] = rec;
    }
  }
  return primary;
}
