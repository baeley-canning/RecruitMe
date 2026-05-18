/**
 * SEEK Talent scraper.
 *
 * ── FOR AI HANDOFF ────────────────────────────────────────────────────────────
 * SEEK Talent (talent.seek.com.au) is a paid candidate database product.
 * This scraper navigates the SEEK Talent web UI using the operator's login.
 *
 * Two operations:
 *   searchCandidates() — search for candidates matching a query + location
 *   getCandidateProfile() — fetch a specific candidate's full profile
 *
 * SEEK Talent URL structure (may change — update selectors if SEEK redesigns):
 *   Search:  https://talent.seek.com.au/candidates?q={query}&where={location}
 *   Profile: https://talent.seek.com.au/candidates/{seekId}
 *
 * RATE LIMITING: SEEK_HOURLY_CAP env var (default: 15).
 * SEEK Talent is a paid subscription product — they're less aggressive about
 * blocking legitimate use, but still detect obvious bot patterns.
 *
 * IF THE SCRAPER BREAKS: SEEK redesigns their UI periodically. Inspect the
 * candidate search results page and update the selectors in extractResults().
 */

import type { Page } from "playwright";
import {
  humanPagePause,
  humanMouseDrift,
  humanScroll,
  randomDelay,
  humanType,
} from "../humanizer";
import { RateLimitError, LoginRequiredError } from "../util/retry";

const hourlyCap = parseInt(process.env.SEEK_HOURLY_CAP ?? "15", 10);
const scrapeTimestamps: number[] = [];

function checkHourlyCap(): void {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const recent = scrapeTimestamps.filter((t) => t > oneHourAgo);
  scrapeTimestamps.length = 0;
  scrapeTimestamps.push(...recent);
  if (scrapeTimestamps.length >= hourlyCap) {
    throw new RateLimitError(`seek: hourly cap of ${hourlyCap} reached`);
  }
}

export interface SEEKCandidateSummary {
  url: string;
  name: string;
  headline: string;
  location?: string;
}

export interface SEEKCandidateProfile {
  profileText: string;
  name: string;
  headline: string;
  location: string;
}

/** Search SEEK Talent for candidates matching query + location. */
export async function searchSEEKCandidates(
  query: string,
  location: string,
  count: number,
  page: Page,
): Promise<SEEKCandidateSummary[]> {
  checkHourlyCap();

  const searchUrl = `https://talent.seek.com.au/candidates?q=${encodeURIComponent(query)}&where=${encodeURIComponent(location)}`;
  console.log(`[seek] Searching: ${query} in ${location}`);

  await page.goto(searchUrl, { waitUntil: "networkidle", timeout: 30000 });
  await humanPagePause();

  const url = page.url();
  if (url.includes("/login") || url.includes("/sign-in")) {
    throw new LoginRequiredError("seek");
  }

  await humanMouseDrift(page);

  // Scroll to load more results
  await humanScroll(page, 1500);
  await randomDelay(800, 1500);

  // Extract candidate cards
  const results = await page.evaluate((maxCount: number) => {
    // SEEK Talent candidate card selectors — update if UI changes
    const cards = Array.from(document.querySelectorAll(
      '[data-automation="candidate-card"], [class*="CandidateCard"], [class*="candidate-card"]'
    )).slice(0, maxCount);

    return cards.map((card) => {
      const nameEl  = card.querySelector('[data-automation="candidate-name"], h3, h2, [class*="name"]');
      const headEl  = card.querySelector('[data-automation="candidate-headline"], [class*="headline"], [class*="jobTitle"]');
      const locEl   = card.querySelector('[data-automation="candidate-location"], [class*="location"]');
      const linkEl  = card.querySelector('a[href*="/candidates/"]');

      return {
        url:      linkEl ? `https://talent.seek.com.au${linkEl.getAttribute("href")}` : "",
        name:     (nameEl as HTMLElement)?.innerText?.trim() ?? "",
        headline: (headEl as HTMLElement)?.innerText?.trim() ?? "",
        location: (locEl as HTMLElement)?.innerText?.trim() ?? "",
      };
    }).filter((c) => c.url && c.name);
  }, count);

  scrapeTimestamps.push(Date.now());
  console.log(`[seek] Found ${results.length} candidates`);

  await randomDelay(1500, 3000);
  return results;
}

/** Fetch full profile text for a SEEK Talent candidate by profile URL. */
export async function getSEEKCandidateProfile(
  profileUrl: string,
  page: Page,
): Promise<SEEKCandidateProfile> {
  checkHourlyCap();

  console.log(`[seek] Fetching profile: ${profileUrl}`);
  await page.goto(profileUrl, { waitUntil: "networkidle", timeout: 30000 });
  await humanPagePause();

  if (page.url().includes("/login")) throw new LoginRequiredError("seek");

  await humanMouseDrift(page);
  await humanScroll(page, 2000);
  await randomDelay(500, 1000);

  const name     = await safeText(page, '[data-automation="candidate-name"], h1') ?? "";
  const headline = await safeText(page, '[data-automation="candidate-headline"], [class*="headline"]') ?? "";
  const location = await safeText(page, '[data-automation="candidate-location"], [class*="location"]') ?? "";

  const profileText = await page.evaluate(() => {
    const main = document.querySelector("main") ?? document.body;
    return (main as HTMLElement).innerText
      .split("\n")
      .map((l: string) => l.trim())
      .filter((l: string) => l.length > 0)
      .join("\n");
  });

  if (!profileText || profileText.length < 50) {
    throw new Error("SEEK profile too short or inaccessible");
  }

  scrapeTimestamps.push(Date.now());
  console.log(`[seek] Scraped ${profileText.length} chars for: ${name}`);

  await randomDelay(2000, 4000);
  return { profileText, name: name.trim(), headline: headline.trim(), location: location.trim() };
}

async function safeText(page: Page, selector: string): Promise<string | null> {
  try {
    return await page.locator(selector).first().innerText({ timeout: 3000 });
  } catch {
    return null;
  }
}
