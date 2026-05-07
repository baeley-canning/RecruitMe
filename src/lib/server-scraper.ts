/**
 * Client for the separate RecruitMe scraper service.
 *
 * When SCRAPER_URL is set, profile fetches go to the Playwright-based scraper
 * instead of the basic public-HTML fallback. The scraper service authenticates
 * via a shared secret (SCRAPER_API_KEY) and runs on a dedicated Railway
 * service so the scraping load is isolated from the main app.
 *
 * Configure in Railway / .env:
 *   SCRAPER_URL=https://recruitme-scraper.up.railway.app
 *   SCRAPER_API_KEY=<random-secret — must match the scraper service>
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
