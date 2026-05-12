/**
 * SearXNG provider. SearXNG is a free, self-hostable metasearch engine that
 * federates results from Google/Bing/etc and exposes them as JSON.
 *
 * API: GET {base}/search?q=...&format=json
 * Response shape (per SearXNG docs, JSON format):
 *   { results: [{ title, url, content, ... }, ...], number_of_results, ... }
 *
 * We defensively parse — different SearXNG versions emit slightly different
 * field names (some have `content`, some have `snippet`). All failures map
 * to an empty array; the manager catches throws so providers don't need
 * their own resilience layer.
 */

import type { ProviderSearchHit, SearchProvider, SearchProviderOptions } from "./types";
import { recordProviderFailure, recordProviderSuccess } from "../provider-health";
import { readSearchProvidersConfig } from "./config";

interface SearxngRawResult {
  title?: string;
  url?: string;
  content?: string;
  snippet?: string;
  [key: string]: unknown;
}

function buildSearxngUrl(base: string, opts: SearchProviderOptions): string {
  // SearXNG's google `site:` operator + the user's query. Location is folded
  // into the query string rather than a separate param — SearXNG's API
  // doesn't take a location filter, but Google parses "Wellington" in-query.
  const exclusion = opts.excludeContractTitles
    ? ` -intitle:"contract" -intitle:"freelancer" -intitle:"freelance"`
    : "";
  const q = `site:linkedin.com/in ${opts.query}${opts.location ? ` ${opts.location}` : ""}${exclusion}`;
  const url = new URL("/search", base);
  url.searchParams.set("q", q);
  url.searchParams.set("format", "json");
  url.searchParams.set("language", "en");
  return url.toString();
}

function parseSearxngResponse(body: unknown): ProviderSearchHit[] {
  if (!body || typeof body !== "object") return [];
  const root = body as { results?: unknown };
  if (!Array.isArray(root.results)) return [];
  return root.results
    .map((raw, index): ProviderSearchHit | null => {
      if (!raw || typeof raw !== "object") return null;
      const r = raw as SearxngRawResult;
      const title = typeof r.title === "string" ? r.title.trim() : "";
      const url = typeof r.url === "string" ? r.url.trim() : "";
      const snippet =
        (typeof r.content === "string" && r.content.trim()) ||
        (typeof r.snippet === "string" && r.snippet.trim()) ||
        "";
      if (!url) return null;
      return { title, url, snippet, provider: "searxng", rank: index, raw: r };
    })
    .filter((h): h is ProviderSearchHit => h !== null);
}

export class SearxngProvider implements SearchProvider {
  readonly name = "searxng" as const;

  constructor(private readonly baseUrl: string) {}

  static fromEnv(): SearxngProvider | null {
    const cfg = readSearchProvidersConfig();
    if (!cfg.enabled.includes("searxng") || !cfg.searxngBaseUrl) return null;
    return new SearxngProvider(cfg.searxngBaseUrl);
  }

  enabled(): boolean {
    return Boolean(this.baseUrl);
  }

  async search(opts: SearchProviderOptions): Promise<ProviderSearchHit[]> {
    const url = buildSearxngUrl(this.baseUrl, opts);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
      });
    } catch (err) {
      recordProviderFailure("searxng", err instanceof Error ? err.message : String(err));
      throw err;  // manager catches throws
    }
    if (!res.ok) {
      recordProviderFailure("searxng", `non-OK ${res.status}`);
      return [];
    }
    const body = await res.json().catch(() => null);
    recordProviderSuccess("searxng");
    return parseSearxngResponse(body);
  }
}

// Exported for unit tests — the route should construct via fromEnv().
export const _internal = { buildSearxngUrl, parseSearxngResponse };
