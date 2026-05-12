/**
 * OpenSERP provider. OpenSERP is a free, self-hostable Google/Bing/Yandex
 * search proxy. Inspecting the project (github.com/karust/openserp) shows
 * the public API shape is:
 *   GET {base}/google/search?text=...&lang=en&limit=10
 *   GET {base}/bing/search?text=...
 *
 * Response (per their swagger / examples):
 *   [{ rank: 1, url: "...", title: "...", description: "..." }, ...]
 *
 * Like the SearXNG provider, parsing is defensive: tolerate field renames
 * across versions, map all failures to []. The manager catches throws.
 */

import type { ProviderSearchHit, SearchProvider, SearchProviderOptions } from "./types";
import { recordProviderFailure, recordProviderSuccess } from "../provider-health";
import { readSearchProvidersConfig } from "./config";

interface OpenserpRawResult {
  title?: string;
  url?: string;
  link?: string;
  description?: string;
  snippet?: string;
  rank?: number;
  position?: number;
  [key: string]: unknown;
}

function buildOpenserpUrl(base: string, opts: SearchProviderOptions): string {
  const exclusion = opts.excludeContractTitles
    ? ` -intitle:"contract" -intitle:"freelancer" -intitle:"freelance"`
    : "";
  // site:linkedin.com/in plus user query + optional location keyword
  const text = `site:linkedin.com/in ${opts.query}${opts.location ? ` ${opts.location}` : ""}${exclusion}`;
  const url = new URL("/google/search", base);
  url.searchParams.set("text", text);
  url.searchParams.set("lang", "en");
  if (opts.maxResults) url.searchParams.set("limit", String(opts.maxResults));
  return url.toString();
}

function parseOpenserpResponse(body: unknown): ProviderSearchHit[] {
  // OpenSERP returns a bare array. Some forks wrap it in { results: [...] }.
  const arr = Array.isArray(body)
    ? body
    : (body && typeof body === "object" && Array.isArray((body as { results?: unknown }).results))
      ? (body as { results: unknown[] }).results
      : null;
  if (!arr) return [];
  return arr
    .map((raw, index): ProviderSearchHit | null => {
      if (!raw || typeof raw !== "object") return null;
      const r = raw as OpenserpRawResult;
      const url = (typeof r.url === "string" && r.url.trim()) || (typeof r.link === "string" && r.link.trim()) || "";
      const title = typeof r.title === "string" ? r.title.trim() : "";
      const snippet =
        (typeof r.description === "string" && r.description.trim()) ||
        (typeof r.snippet === "string" && r.snippet.trim()) ||
        "";
      if (!url) return null;
      // Prefer provider-reported rank when present; else use array index.
      const rank = typeof r.rank === "number" ? r.rank - 1
        : typeof r.position === "number" ? r.position - 1
        : index;
      return { title, url, snippet, provider: "openserp", rank: Math.max(0, rank), raw: r };
    })
    .filter((h): h is ProviderSearchHit => h !== null);
}

export class OpenserpProvider implements SearchProvider {
  readonly name = "openserp" as const;

  constructor(private readonly baseUrl: string) {}

  static fromEnv(): OpenserpProvider | null {
    const cfg = readSearchProvidersConfig();
    if (!cfg.enabled.includes("openserp") || !cfg.openserpBaseUrl) return null;
    return new OpenserpProvider(cfg.openserpBaseUrl);
  }

  enabled(): boolean {
    return Boolean(this.baseUrl);
  }

  async search(opts: SearchProviderOptions): Promise<ProviderSearchHit[]> {
    const url = buildOpenserpUrl(this.baseUrl, opts);
    try {
      const u = new URL(url);
      console.log(`[openserp] fetching ${u.protocol}//${u.host}${u.pathname}`);
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
      console.warn(`[openserp] fetch FAILED for baseUrl=${this.baseUrl} — ${msg}`);
      recordProviderFailure("openserp", msg);
      throw err;
    }
    if (!res.ok) {
      recordProviderFailure("openserp", `non-OK ${res.status}`);
      return [];
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      recordProviderFailure("openserp", "non-JSON response");
      return [];
    }
    const isArr = Array.isArray(body);
    const wrappedArr = !isArr && body && typeof body === "object" && Array.isArray((body as { results?: unknown }).results);
    if (!isArr && !wrappedArr) {
      recordProviderFailure("openserp", "response was neither an array nor { results: [] }");
      return [];
    }
    recordProviderSuccess("openserp");
    return parseOpenserpResponse(body);
  }
}

export const _internal = { buildOpenserpUrl, parseOpenserpResponse };
