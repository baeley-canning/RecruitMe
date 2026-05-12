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

/**
 * Fallback parser for when SearXNG's `formats: [json]` isn't enabled in
 * settings.yml and the server returns the HTML search-results page. SearXNG
 * themes vary, so we sidestep theme-specific markup and just regex out
 * `<a href="…linkedin.com/in/…">…</a>` anchors. Snippets aren't available
 * via this path; downstream code tolerates an empty string.
 */
function parseSearxngHtml(html: string): ProviderSearchHit[] {
  const linkPattern = /<a\b[^>]*\bhref="(https?:\/\/[a-z]{2,5}\.linkedin\.com\/in\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const hits: ProviderSearchHit[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  let rank = 0;
  while ((match = linkPattern.exec(html)) !== null) {
    const url = match[1].trim();
    if (seen.has(url)) continue;
    seen.add(url);
    const title = match[2].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
    hits.push({ title, url, snippet: "", provider: "searxng", rank: rank++, raw: { fromHtml: true } });
  }
  return hits;
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
    // Log the actual URL we're about to hit (host:port + path only — query
    // omitted so the line stays one short row in Railway logs). This is the
    // signal you need when the env-var value is wrong: the log shows the
    // exact hostname your container is trying to resolve, so misconfigured
    // SEARXNG_BASE_URL fails loudly instead of silently timing out.
    try {
      const u = new URL(url);
      console.log(`[searxng] fetching ${u.protocol}//${u.host}${u.pathname}`);
    } catch { /* malformed URL — fetch below will throw and we'll record it */ }
    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[searxng] fetch FAILED for baseUrl=${this.baseUrl} — ${msg}`);
      recordProviderFailure("searxng", msg);
      throw err;  // manager catches throws
    }
    if (!res.ok) {
      recordProviderFailure("searxng", `non-OK ${res.status}`);
      return [];
    }
    // Read once as text so we can fall back to HTML parsing when JSON
    // format isn't enabled in settings.yml. The HTML parser is a pragmatic
    // safety net — if the user's SearXNG instance is misconfigured we'd
    // rather extract LinkedIn URLs from the rendered HTML than return [].
    const rawText = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(rawText);
    } catch {
      const htmlHits = parseSearxngHtml(rawText);
      if (htmlHits.length > 0) {
        recordProviderSuccess("searxng");
        return htmlHits;
      }
      recordProviderFailure(
        "searxng",
        "non-JSON response and HTML had no LinkedIn links — enable `formats: [json]` in settings.yml or check the limiter/botdetection settings",
      );
      return [];
    }
    if (!body || typeof body !== "object" || !Array.isArray((body as { results?: unknown }).results)) {
      recordProviderFailure("searxng", "response had no `results` array");
      return [];
    }
    // SearXNG reports per-engine errors (Captcha, rate limit) in
    // `unresponsive_engines`. When results is empty AND every engine errored,
    // that's a deployment problem, not a genuine zero-match.
    const root = body as { results: unknown[]; unresponsive_engines?: unknown };
    if (root.results.length === 0 && Array.isArray(root.unresponsive_engines) && root.unresponsive_engines.length > 0) {
      const summary = root.unresponsive_engines
        .slice(0, 3)
        .map((e) => (Array.isArray(e) ? e.join(":") : String(e)))
        .join(", ");
      recordProviderFailure("searxng", `all engines unresponsive: ${summary}`);
      return [];
    }
    recordProviderSuccess("searxng");
    return parseSearxngResponse(body);
  }
}

// Exported for unit tests — the route should construct via fromEnv().
export const _internal = { buildSearxngUrl, parseSearxngResponse, parseSearxngHtml };
