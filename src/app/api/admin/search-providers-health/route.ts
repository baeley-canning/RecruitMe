import { NextResponse } from "next/server";
import { getAuth, unauthorized } from "@/lib/session";
import { readSearchProvidersConfig } from "@/lib/search-providers/config";

/**
 * Live diagnostic for the free search providers.
 *
 * Hits SearXNG and OpenSERP directly with a one-off probe query and
 * returns:
 *   - the env-var configuration the running process sees (URL + enabled
 *     providers, timeout)
 *   - HTTP status code each service returned
 *   - whether the response body parsed as JSON or HTML
 *   - the head of the raw body (first 400 chars) — enough to see if
 *     SearXNG sent JSON, an HTML CAPTCHA page, or a rate-limit notice
 *   - count of LinkedIn profile URLs extracted from the response
 *   - the per-provider error reason if one was hit
 *
 * Owner-only. No auth → 401. Existence of this endpoint is acknowledged
 * in the failure-message text so the recruiter knows where to look.
 */
export async function GET(req: Request) {
  const auth = await getAuth();
  if (!auth?.isOwner) return unauthorized();

  const { searchParams } = new URL(req.url);
  const query    = (searchParams.get("q")        ?? "site:linkedin.com/in lead developer wellington").slice(0, 200);
  const timeoutMs = Number(searchParams.get("timeoutMs")) || 8000;

  const cfg = readSearchProvidersConfig();

  const linkedinAnchors = /<a\b[^>]*\bhref="(https?:\/\/[a-z]{2,5}\.linkedin\.com\/in\/[^"#?]+)"/gi;

  async function probe(label: string, url: string): Promise<Record<string, unknown>> {
    const start = Date.now();
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const rawText = await res.text();
      const head = rawText.slice(0, 400);
      let json: unknown = null;
      let parseError: string | null = null;
      try {
        json = JSON.parse(rawText);
      } catch (err) {
        parseError = err instanceof Error ? err.message : String(err);
      }
      const linkedinUrlCount =
        (rawText.match(linkedinAnchors) ?? []).length;
      return {
        ok: res.ok,
        status: res.status,
        contentType: res.headers.get("content-type"),
        durationMs: Date.now() - start,
        bodyHead: head,
        bodyLength: rawText.length,
        parsedAs: parseError ? "html-or-other" : "json",
        parseError,
        jsonShape: json && typeof json === "object" ? Object.keys(json).slice(0, 10) : null,
        linkedinAnchorsInBody: linkedinUrlCount,
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
    const url = new URL("/search", cfg.searxngBaseUrl);
    url.searchParams.set("q", `site:linkedin.com/in ${query}`);
    url.searchParams.set("format", "json");
    url.searchParams.set("language", "en");
    probes.searxng = await probe("searxng", url.toString());
  } else {
    probes.searxng = { enabled: false, reason: "SEARXNG_BASE_URL not set" };
  }

  if (cfg.openserpBaseUrl) {
    const url = new URL("/google/search", cfg.openserpBaseUrl);
    url.searchParams.set("text", `site:linkedin.com/in ${query}`);
    url.searchParams.set("lang", "en");
    url.searchParams.set("limit", "10");
    probes.openserp = await probe("openserp", url.toString());
  } else {
    probes.openserp = { enabled: false, reason: "OPENSERP_BASE_URL not set" };
  }

  return NextResponse.json({
    config: {
      enabledProviders: cfg.enabled,
      searxngBaseUrl: cfg.searxngBaseUrl,
      openserpBaseUrl: cfg.openserpBaseUrl,
      providerTimeoutMs: cfg.providerTimeoutMs,
    },
    probes,
    queryUsed: query,
    hint: "If searxng.parsedAs is 'html-or-other', the SearXNG instance is returning HTML — enable `formats: [json]` in settings.yml. If linkedinAnchorsInBody is 0 on both, the underlying engines (Google/Bing) are blocked from your Railway IP.",
  });
}
