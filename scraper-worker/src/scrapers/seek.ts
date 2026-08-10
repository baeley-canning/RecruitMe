import type { Page } from "patchright";
import { humanScroll, randomDelay } from "../humanizer.js";
import { log } from "../util/log.js";
// Reuse the SSRF allow-list guard (and RateLimitError) from the LinkedIn
// scraper so both profile scrapers enforce the same host policy.
import { RateLimitError, assertAllowedProfileUrl } from "./linkedin.js";

export interface SeekProfile {
  profileText: string;
  name: string | null;
  headline: string | null;
  location: string | null;
  seekUrl: string;
  linkedinUrl: string | null;
}

export async function scrapeSeekProfile(url: string, page: Page): Promise<SeekProfile> {
  assertAllowedProfileUrl(url);
  log.info(`seek: scraping ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await randomDelay(1000, 2000);

  const currentUrl = page.url();
  if (currentUrl.includes("/login") || currentUrl.includes("/signin") || /authenticate\.seek\.com|\/oauth\//i.test(currentUrl)) {
    // `seek_challenge:` prefix → API flags the SearchRun's seek source needs-reauth.
    // RateLimitError (not a bare Error) keeps it consistent with the other
    // scrapers so the worker's auth-challenge classification catches it.
    throw new RateLimitError("seek_challenge: session expired — re-authentication required");
  }

  // SEEK Talent is a SPA: domcontentloaded fires long before the profile body
  // arrives over XHR, and the old code extracted immediately after a ~1-2s
  // pause. That is why every scrape threw "profile text too short" while the
  // session was perfectly valid. Wait for real content to render, then settle.
  await page
    .waitForFunction(() => (document.body?.innerText?.length ?? 0) > 400, undefined, { timeout: 20_000 })
    .catch(() => {}); // fall through to the extraction guard below

  const pageHeight = await page.evaluate(() => document.body.scrollHeight);
  await humanScroll(page, pageHeight * 0.4);
  await randomDelay(500, 1000);
  await humanScroll(page, pageHeight);
  await randomDelay(600, 1200);

  const extracted = await page.evaluate(() => {
    const getText = (selector: string) =>
      document.querySelector(selector)?.textContent?.trim() ?? null;
    const getAllText = (selector: string) =>
      Array.from(document.querySelectorAll(selector))
        .map((el) => el.textContent?.trim())
        .filter(Boolean)
        .join("\n");

    // Page <title> as a fallback when DOM selectors miss (class names drift).
    const titleName = (document.title || "")
      .replace(/\s*[|–\-].*$/, "")
      .trim() || null;
    // SEEK Talent profile layout selectors (approximated — may need tuning).
    const name = getText('[data-testid="candidate-name"], h1, .candidate-name') ?? titleName;
    const headline = getText('[data-testid="candidate-headline"], .candidate-headline');
    const location = getText('[data-testid="candidate-location"], .candidate-location');

    const profileSections = [
      getText('[data-testid="summary"], .candidate-summary'),
      getAllText('[data-testid="work-history"] li, .work-history-item'),
      getAllText('[data-testid="education"] li, .education-item'),
      getAllText('[data-testid="skills"] li, .skill-item'),
    ].filter(Boolean).join("\n\n");

    // Fallback chain, widest last. The testid selectors are approximations of a
    // layout that drifts, and `main`/[role=main] is not guaranteed to exist —
    // when it didn't, this returned "" and the caller threw, discarding a
    // perfectly good page. Body text is noisier but always present.
    const mainEl = document.querySelector("main, [role='main'], #app, #root") as HTMLElement | null;
    const mainText = (mainEl?.innerText ?? "").trim() || (document.body?.innerText ?? "").trim();

    // Look for a LinkedIn URL in the profile.
    const allLinks = Array.from(document.querySelectorAll("a[href]")) as HTMLAnchorElement[];
    const linkedinLink = allLinks.find(
      (a) => a.href.includes("linkedin.com/in/")
    )?.href ?? null;

    return {
      name,
      headline,
      location,
      profileText: profileSections.length > 200 ? profileSections : mainText,
      linkedinUrl: linkedinLink,
    };
  });

  if (!extracted.profileText || extracted.profileText.length < 50) {
    // Report the actual size and the landing URL — "may require different
    // selectors" told us nothing about whether the page was empty, a login
    // wall, or simply unrendered, and cost a day of chasing the wrong cause.
    throw new Error(
      `SEEK profile text too short (${extracted.profileText?.length ?? 0} chars) at ${page.url()} — page may not have rendered`,
    );
  }

  return {
    profileText: extracted.profileText,
    name: extracted.name,
    headline: extracted.headline,
    location: extracted.location,
    seekUrl: url,
    linkedinUrl: extracted.linkedinUrl,
  };
}
