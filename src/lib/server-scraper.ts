/**
 * LEGACY: client for the separate RecruitMe scraper service.
 *
 * The supported capture path is now the browser extension
 * (recruitme-opera-linkedin-capture). The server-side scraper kept losing
 * to LinkedIn's bot detection (HTTP 999) even with proxy rotation, so it is
 * disabled by default. Leave SCRAPER_URL unset and the extension flow
 * handles everything via /api/extension/fetch-session/complete.
 *
 * This file is kept as inert fallback in case someone wants to experiment
 * with a paid LinkedIn API later — wire that up to /scrape-async via this
 * client and the rest of the pipeline (session lifecycle, polling, scoring)
 * works unchanged.
 */

export interface ScraperResult {
  profileText: string;
  capturedAt: string;
  profileUrl: string;
}

function getScraperUrl(): string | null {
  return process.env.SCRAPER_URL?.trim() || null;
}

function getScraperApiKey(): string {
  return process.env.SCRAPER_API_KEY?.trim() ?? "";
}

export function isScraperConfigured(): boolean {
  return Boolean(getScraperUrl() && getScraperApiKey());
}

/** Fire-and-forget async scrape. Returns immediately; result posted back via FetchSession callback. */
export async function scrapeViaServiceAsync(opts: {
  linkedinUrl: string;
  sessionId: string;
  callbackUrl: string;
}): Promise<void> {
  const base = getScraperUrl();
  if (!base) throw new Error("SCRAPER_URL is not configured");
  const apiKey = getScraperApiKey();
  if (!apiKey) throw new Error("SCRAPER_API_KEY is not configured");

  const res = await fetch(`${base.replace(/\/$/, "")}/scrape-async`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Scraper-Api-Key": apiKey },
    body: JSON.stringify({ ...opts }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error ?? `Scraper returned HTTP ${res.status}`);
  }
}

export async function scrapeViaService(linkedinUrl: string): Promise<ScraperResult> {
  const base = getScraperUrl();
  if (!base) throw new Error("SCRAPER_URL is not configured");

  const apiKey = getScraperApiKey();
  if (!apiKey) throw new Error("SCRAPER_API_KEY is not configured");

  const res = await fetch(`${base.replace(/\/$/, "")}/scrape`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Scraper-Api-Key": apiKey,
    },
    body: JSON.stringify({ url: linkedinUrl }),
    signal: AbortSignal.timeout(120_000), // 2 min — scraper needs time for deep pages
  });

  const data = await res.json().catch(() => ({ error: "Non-JSON response from scraper" })) as {
    profileText?: string;
    capturedAt?: string;
    profileUrl?: string;
    error?: string;
  };

  if (!res.ok || data.error) {
    throw new Error(data.error ?? `Scraper returned HTTP ${res.status}`);
  }

  if (!data.profileText || data.profileText.length < 100) {
    throw new Error("Scraper returned no usable profile text");
  }

  return {
    profileText: data.profileText,
    capturedAt: data.capturedAt ?? new Date().toISOString(),
    profileUrl: data.profileUrl ?? linkedinUrl,
  };
}
