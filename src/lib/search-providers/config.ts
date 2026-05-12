/**
 * Single source of truth for the search-provider env config. Centralises
 * process.env reads so the rest of the module can be tested via injected
 * config rather than environment-mutation in tests.
 */

import type { SearchProviderName } from "./types";

export interface SearchProvidersConfig {
  /** Providers the recruiter has enabled via SEARCH_PROVIDERS env. When this
   *  list is empty, the route should fall back to its existing behaviour
   *  (SerpAPI / Bing / PDL) — no new code path activates. */
  enabled: SearchProviderName[];
  searxngBaseUrl: string | null;
  openserpBaseUrl: string | null;
  /** Hard per-provider timeout (ms). Defaults to 8s. */
  providerTimeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 8_000;

const ALL_PROVIDERS: SearchProviderName[] = ["searxng", "openserp", "serpapi"];

function parseProviderList(raw: string | undefined): SearchProviderName[] {
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is SearchProviderName => (ALL_PROVIDERS as string[]).includes(s));
}

/**
 * Read the env config. Exported as a function (not a top-level const) so
 * tests can mutate process.env and re-read. Defensively typed so a junk env
 * value can't crash the route.
 */
export function readSearchProvidersConfig(): SearchProvidersConfig {
  return {
    enabled: parseProviderList(process.env.SEARCH_PROVIDERS),
    searxngBaseUrl: process.env.SEARXNG_BASE_URL?.trim() || null,
    openserpBaseUrl: process.env.OPENSERP_BASE_URL?.trim() || null,
    providerTimeoutMs: Number(process.env.SEARCH_PROVIDER_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  };
}
