/**
 * LinkedIn profile scraper.
 *
 * ── FOR AI HANDOFF ────────────────────────────────────────────────────────────
 * This scraper navigates to a LinkedIn profile URL using the operator's own
 * LinkedIn session (managed by session-manager.ts). It does NOT use LinkedIn's
 * API — it reads the DOM of the profile page, the same content any logged-in
 * user would see.
 *
 * OUTPUT FORMAT: Same as the browser extension capture (linkedin-capture.ts).
 * The profileText is passed to applyProfileResult() in scrape-queue.ts which
 * feeds it through saveCapturedProfileFast() + applyAiEnrichmentInBackground().
 *
 * RATE LIMITING: LINKEDIN_HOURLY_CAP env var (default: 8).
 * If LinkedIn shows a rate-limit page, RateLimitError is thrown and the worker
 * pauses for 2–4 hours before retrying (see index.ts).
 *
 * SELECTOR NOTES: LinkedIn changes selectors frequently (~quarterly).
 * If extraction stops working, inspect the profile page and update:
 *   - Name:     h1.text-heading-xlarge
 *   - Headline: div.text-body-medium.break-words
 *   - Location: span.text-body-small.inline.t-black--light.break-words
 *   - About:    div#about section div.display-flex p.whitespace-pre-wrap
 *   - Jobs:     section#experience li.artdeco-list__item
 * The full-text extraction approach (innerText) is more robust than individual
 * selectors — only update the specific selectors above if needed.
 */

import type { Page } from "playwright";
import {
  humanPagePause,
  humanMouseDrift,
  scrollPageToBottom,
  randomDelay,
} from "../humanizer";
import { RateLimitError, LoginRequiredError } from "../util/retry";

// Hourly cap — prevents account-level rate limiting
const hourlyCap = parseInt(process.env.LINKEDIN_HOURLY_CAP ?? "8", 10);
const scrapeTimestamps: number[] = [];

function checkHourlyCap(): void {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const recent = scrapeTimestamps.filter((t) => t > oneHourAgo);
  scrapeTimestamps.length = 0;
  scrapeTimestamps.push(...recent);

  if (scrapeTimestamps.length >= hourlyCap) {
    throw new RateLimitError(`linkedin: hourly cap of ${hourlyCap} reached`);
  }
}

export interface LinkedInProfileResult {
  profileText: string;
  name: string;
  headline: string;
  location: string;
}

/**
 * Scrape a single LinkedIn profile URL.
 * Returns structured profile data in the same format as the browser extension.
 */
export async function scrapeLinkedInProfile(
  url: string,
  page: Page,
): Promise<LinkedInProfileResult> {
  checkHourlyCap();

  console.log(`[linkedin] Scraping: ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await humanPagePause();

  // Detect walls
  const currentUrl = page.url();
  if (currentUrl.includes("/authwall") || currentUrl.includes("/login")) {
    throw new LoginRequiredError("linkedin");
  }
  if (currentUrl.includes("/in/unavailable") || currentUrl.includes("404")) {
    throw new Error("Profile not found or removed");
  }

  // Check for rate limit page
  const pageTitle = await page.title();
  if (
    pageTitle.toLowerCase().includes("rate limit") ||
    pageTitle.toLowerCase().includes("too many requests") ||
    pageTitle.toLowerCase().includes("unusual activity")
  ) {
    throw new RateLimitError("linkedin");
  }

  await humanMouseDrift(page);

  // Scroll through the full profile (loads lazy sections)
  await scrollPageToBottom(page);
  await randomDelay(800, 1500);

  // Extract identity fields
  const name = await safeText(page, "h1") ?? "";
  const headline = await safeText(page, "div.text-body-medium.break-words") ?? "";
  const location = await safeText(page, "span.text-body-small.inline.t-black--light.break-words") ?? "";

  // Full-text extraction — grab all readable content in document order
  // This is the most robust approach: we don't need to know every section selector
  const profileText = await page.evaluate(() => {
    // Remove noise elements
    const noiseSelectors = [
      "nav", "header", "footer",
      "[class*='msg-overlay']",
      "[class*='notification']",
      "[class*='feed-follows']",
      "[class*='ad-banner']",
      "button", "svg",
    ];
    noiseSelectors.forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => el.remove());
    });

    // Get main content
    const main = document.querySelector("main") ?? document.body;
    return main.innerText
      .split("\n")
      .map((l: string) => l.trim())
      .filter((l: string) => l.length > 0)
      .join("\n");
  });

  if (!profileText || profileText.length < 100) {
    throw new Error("Profile text too short — may be private or not fully loaded");
  }

  scrapeTimestamps.push(Date.now());
  console.log(`[linkedin] Scraped ${profileText.length} chars for: ${name}`);

  // Natural pause before next action
  await randomDelay(2000, 5000);

  return { profileText, name: name.trim(), headline: headline.trim(), location: location.trim() };
}

async function safeText(page: Page, selector: string): Promise<string | null> {
  try {
    return await page.locator(selector).first().innerText({ timeout: 3000 });
  } catch {
    return null;
  }
}
