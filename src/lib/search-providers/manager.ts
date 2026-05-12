/**
 * Provider manager. Dispatches a search across enabled providers in
 * parallel, applies a per-provider timeout, and returns hits keyed by
 * provider. Uses Promise.allSettled so a slow / down provider doesn't kill
 * the others — critical for graceful degradation when a self-hosted
 * SearXNG instance is offline.
 *
 * Caller is expected to feed the result into mergeProviderHits → rankMergedResults
 * → the existing internal SearchResult shape via adapter.ts.
 */

import { readSearchProvidersConfig } from "./config";
import { SearxngProvider } from "./searxng";
import { OpenserpProvider } from "./openserp";
import type { ProviderSearchHit, SearchProvider, SearchProviderName, SearchProviderOptions } from "./types";

interface ProviderRunOutcome {
  provider: SearchProviderName;
  hits: ProviderSearchHit[];
  error?: string;
  /** ms taken by the provider call — visible in logs for debugging slow
   *  self-hosted instances. */
  durationMs: number;
}

export interface ProviderSearchResult {
  /** Provider-keyed hits, ready for mergeProviderHits. */
  byProvider: Partial<Record<SearchProviderName, ProviderSearchHit[]>>;
  /** Detailed outcomes for logging — which providers succeeded, failed,
   *  timed out, with timings. */
  outcomes: ProviderRunOutcome[];
}

/**
 * Runs each provider with a hard timeout. Per-provider failure (network,
 * timeout, parse) maps to an empty hit list — never throws. Aggregated
 * outcomes are returned so the route can log degradation events.
 */
async function runProvider(
  provider: SearchProvider,
  opts: SearchProviderOptions,
  defaultTimeoutMs: number,
): Promise<ProviderRunOutcome> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs;
  try {
    const result = await Promise.race([
      provider.search({ ...opts, timeoutMs }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`${provider.name} timeout after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
    return {
      provider: provider.name,
      hits: result,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    return {
      provider: provider.name,
      hits: [],
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - started,
    };
  }
}

/**
 * Resolve providers from env config. Returns only providers whose env vars
 * are set and whose name appears in SEARCH_PROVIDERS. Pure — no network.
 *
 * NOTE: serpapi is NOT instantiated here. The existing SerpAPI code path
 * lives in src/lib/search.ts and remains independent. Mixing free providers
 * with paid SerpAPI is a route-level concern, not the manager's job.
 */
export function resolveEnabledProviders(): SearchProvider[] {
  const providers: SearchProvider[] = [];
  const searxng = SearxngProvider.fromEnv();
  if (searxng) providers.push(searxng);
  const openserp = OpenserpProvider.fromEnv();
  if (openserp) providers.push(openserp);
  return providers;
}

/**
 * Run a search across all configured providers in parallel. Returns hits
 * keyed by provider plus per-provider outcomes. Never throws — partial
 * results are returned even if every provider fails.
 */
export async function runProviderSearch(
  opts: SearchProviderOptions,
  providers?: SearchProvider[],
): Promise<ProviderSearchResult> {
  const cfg = readSearchProvidersConfig();
  const resolved = providers ?? resolveEnabledProviders();
  if (resolved.length === 0) {
    return { byProvider: {}, outcomes: [] };
  }

  const outcomes = await Promise.all(
    resolved.map((p) => runProvider(p, opts, cfg.providerTimeoutMs)),
  );

  const byProvider: Partial<Record<SearchProviderName, ProviderSearchHit[]>> = {};
  for (const o of outcomes) byProvider[o.provider] = o.hits;
  return { byProvider, outcomes };
}
