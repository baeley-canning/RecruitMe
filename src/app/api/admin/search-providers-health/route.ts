import { NextResponse } from "next/server";
import { getAuth, unauthorized } from "@/lib/session";
import { readSearchProvidersConfig } from "@/lib/search-providers/config";

/**
 * Live diagnostic for the free search providers — three-tier probe per
 * service to distinguish "service unreachable" from "service reachable
 * but search backend broken" from "everything fine".
 *
 *   1. ROOT          GET /                     (3s timeout)
 *      - confirms TCP reach + bind address
 *   2. ALT-ENDPOINT  GET /healthz or /swagger  (3s timeout)
 *      - confirms middleware chain not blocked (e.g. SearXNG limiter
 *        hanging on missing Valkey/Redis would hang here too — the
 *        limiter runs as a before_request hook)
 *   3. SEARCH        GET /search or similar    (configured timeout)
 *      - confirms actual search backend works
 *
 * Interpretation matrix:
 *   - All 3 hang   → service not bound to railway.internal interface
 *                    (likely 0.0.0.0 with IPv6-only DNS, or wrong port)
 *   - ROOT fast, ALT/SEARCH hang → SearXNG limiter blocked on Valkey,
 *                    or OpenSERP Chromium wedged
 *   - ROOT + ALT fast, SEARCH hang → engine-layer block (Google CAPTCHA)
 *   - All fast, SEARCH returns 0 results → settings.yml not applied
 *                    (JSON format disabled, engines list empty, etc.)
 *
 * Owner-only. No auth → 401.
 */
export async function GET(req: Request) {
  const auth = await getAuth();
  if (!auth?.isOwner) return unauthorized();

  const { searchParams } = new URL(req.url);
  const query     = (searchParams.get("q") ?? "site:linkedin.com/in lead developer wellington").slice(0, 200);
  const searchTimeoutMs = Number(searchParams.get("timeoutMs")) || 8000;

  const cfg = readSearchProvidersConfig();

  const linkedinAnchors = /<a\b[^>]*\bhref="(https?:\/\/[a-z]{2,5}\.linkedin\.com\/in\/[^"#?]+)"/gi;

  async function probe(url: string, timeoutMs: number): Promise<Record<string, unknown>> {
    const start = Date.now();
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { Accept: "*/*" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const rawText = await res.text();
      const head = rawText.slice(0, 400);
      let parseError: string | null = null;
      let json: unknown = null;
      try { json = JSON.parse(rawText); } catch (err) {
        parseError = err instanceof Error ? err.message : String(err);
      }
      return {
        ok: res.ok,
        status: res.status,
        contentType: res.headers.get("content-type"),
        durationMs: Date.now() - start,
        bodyLength: rawText.length,
        bodyHead: head,
        parsedAs: parseError ? "html-or-other" : "json",
        parseError,
        jsonShape: json && typeof json === "object" ? Object.keys(json).slice(0, 10) : null,
        linkedinAnchorsInBody: (rawText.match(linkedinAnchors) ?? []).length,
      };
    } catch (err) {
      return {
        ok: false,
        durationMs: Date.now() - start,
        fetchError: err instanceof Error ? err.message : String(err),
        bodyHead: null,
        bodyLength: 0,
        parsedAs: null,
        linkedinAnchorsInBody: 0,
      };
    }
  }

  const probes: Record<string, unknown> = {};

  if (cfg.searxngBaseUrl) {
    const base = cfg.searxngBaseUrl.replace(/\/+$/, "");
    const search = new URL("/search", base);
    search.searchParams.set("q", `site:linkedin.com/in ${query}`);
    search.searchParams.set("format", "json");
    search.searchParams.set("language", "en");
    probes.searxng = {
      root:        await probe(`${base}/`,         3000),
      healthCheck: await probe(`${base}/healthz`,  3000),
      search:      await probe(search.toString(),  searchTimeoutMs),
    };
  } else {
    probes.searxng = { enabled: false, reason: "SEARXNG_BASE_URL not set" };
  }

  if (cfg.openserpBaseUrl) {
    const base = cfg.openserpBaseUrl.replace(/\/+$/, "");
    const search = new URL("/google/search", base);
    search.searchParams.set("text", `site:linkedin.com/in ${query}`);
    search.searchParams.set("lang", "en");
    search.searchParams.set("limit", "5");
    probes.openserp = {
      root:        await probe(`${base}/`,             3000),
      healthCheck: await probe(`${base}/swagger/`,     3000),
      search:      await probe(search.toString(),      searchTimeoutMs),
    };
  } else {
    probes.openserp = { enabled: false, reason: "OPENSERP_BASE_URL not set" };
  }

  return NextResponse.json({
    config: {
      enabledProviders:  cfg.enabled,
      searxngBaseUrl:    cfg.searxngBaseUrl,
      openserpBaseUrl:   cfg.openserpBaseUrl,
      providerTimeoutMs: cfg.providerTimeoutMs,
      probeTimeoutMs:    3000,
      searchTimeoutMs,
    },
    probes,
    queryUsed: query,
    interpretation: {
      "all three probes hang":
        "Service not bound to the interface railway.internal routes to. Likely the service listens on 0.0.0.0 but Railway's private DNS resolves IPv6-only (AAAA) — bind to :: instead. Or wrong port — confirm the service's actual PORT env var.",
      "root fast, healthCheck + search hang":
        "Middleware blocking. For SearXNG: server.limiter is true and there is no Valkey/Redis — set server.limiter: false in settings.yml. For OpenSERP: it's running in browser mode and Chromium is wedged on Railway's tiny /dev/shm — pass --raw or set OPENSERP_SERVER_RAW_REQUESTS=true.",
      "root + healthCheck fast, search hangs":
        "Service is healthy but the search backend hangs. SearXNG: every engine is being blocked by Google CAPTCHA (set engines to bing, brave, duckduckgo, etc.). OpenSERP: same — Google blocks the IP, switch to Bing or Yandex.",
      "root + healthCheck + search all 200 but linkedinAnchorsInBody = 0":
        "Search runs but returns no LinkedIn results. SearXNG: confirm `formats: [json]` in settings.yml AND that `engines:` is configured. OpenSERP: tighten the query and check the configured engine.",
    },
  });
}
