import type { Page } from "patchright";
import { humanScroll, randomDelay } from "../humanizer.js";
import { log } from "../util/log.js";

export class RateLimitError extends Error {
  constructor(msg = "LinkedIn rate limit / checkpoint detected") {
    super(msg);
    this.name = "RateLimitError";
  }
}

export interface LinkedInProfile {
  profileText: string;
  name: string | null;
  headline: string | null;
  location: string | null;
  linkedinUrl: string;
}

// SSRF defence-in-depth: the profileUrl arrives from search harvests / the API,
// so before navigating we assert it's https and points at an allowed platform
// host. A poisoned/internal URL (file://, http://169.254.169.254, an intranet
// box) would otherwise be driven by the logged-in browser. Throw clearly so the
// job fails fast instead of fetching something it shouldn't.
const ALLOWED_PROFILE_HOST =
  /(^|\.)linkedin\.com$|(^|\.)seek\.com\.au$|(^|\.)employer\.seek\.com$|(^|\.)jobadder\.com$/i;

export function assertAllowedProfileUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Refusing to scrape malformed URL: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Refusing to scrape non-https URL: ${url}`);
  }
  if (!ALLOWED_PROFILE_HOST.test(parsed.hostname)) {
    throw new Error(`Refusing to scrape disallowed host: ${parsed.hostname}`);
  }
}

export async function scrapeLinkedInProfile(url: string, page: Page): Promise<LinkedInProfile> {
  assertAllowedProfileUrl(url);
  log.info(`linkedin: scraping ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await randomDelay(1200, 2500);

  const currentUrl = page.url();
  // `linkedin_challenge:` prefix is the stable signal the API matches to flag
  // the SearchRun's source as needs-reauth (a challenge often surfaces here,
  // on the profile fetch, not on the search harvest).
  if (currentUrl.includes("/checkpoint") || currentUrl.includes("/captcha")) {
    throw new RateLimitError("linkedin_challenge: checkpoint/captcha detected");
  }
  if (currentUrl.includes("/login") || currentUrl.includes("/authwall")) {
    throw new RateLimitError("linkedin_challenge: auth wall — session expired");
  }

  // Scroll through the profile to trigger lazy-loaded sections.
  const pageHeight = await page.evaluate(() => document.body.scrollHeight);
  await humanScroll(page, pageHeight * 0.3);
  await randomDelay(600, 1200);
  await humanScroll(page, pageHeight * 0.6);
  await randomDelay(600, 1200);
  await humanScroll(page, pageHeight);
  await randomDelay(800, 1500);

  // Extract structured text from the profile DOM.
  const extracted = await page.evaluate(() => {
    const getText = (selector: string) =>
      document.querySelector(selector)?.textContent?.trim() ?? null;
    const getAllText = (selector: string) =>
      Array.from(document.querySelectorAll(selector))
        .map((el) => el.textContent?.trim())
        .filter(Boolean)
        .join("\n");

    // Name/headline from the page <title> is the most stable signal — DOM class
    // names change constantly, but the tab title is reliably
    // "(N) Full Name - Headline | LinkedIn" (the "(N)" count and " - Headline"
    // are both optional). Used as a fallback when DOM selectors miss.
    let titleName: string | null = (document.title || "")
      .replace(/^\(\d+\+?\)\s*/, "")
      .replace(/\s*\|\s*LinkedIn.*$/i, "")
      .trim();
    let titleHeadline: string | null = null;
    const dash = titleName.indexOf(" - ");
    if (dash >= 0) {
      titleHeadline = titleName.slice(dash + 3).trim() || null;
      titleName = titleName.slice(0, dash).trim();
    }
    titleName = titleName || null;

    const name =
      getText("h1.text-heading-xlarge") ??
      getText(".pv-text-details__left-panel h1") ??
      getText("main h1") ??
      getText("h1") ??
      titleName;
    const headline =
      getText(".text-body-medium.break-words") ??
      getText('[data-generated-suggestion-target]') ??
      titleHeadline;
    const location =
      getText(".text-body-small.inline.t-black--light.break-words") ??
      getText(".pv-text-details__left-panel .text-body-small");

    // Build full profile text from all visible text sections.
    const sections = [
      "About section",
      getText(".display-flex.ph5.pv3 .visually-hidden") ?? "",
      "Experience",
      getAllText(".experience-section li, .pvs-entity"),
      "Education",
      getAllText(".education-section li, .pvs-entity--education"),
      "Skills",
      getAllText(".pv-skill-category-entity__name, .pvs-entity--skill"),
    ].join("\n");

    // Fallback: get all readable text from the main content area.
    const mainText =
      (document.querySelector("#main, .scaffold-layout__main, main") as HTMLElement)?.innerText ?? "";

    return {
      name,
      headline,
      location,
      profileText: sections.length > 200 ? sections : mainText,
    };
  });

  if (!extracted.profileText || extracted.profileText.length < 100) {
    throw new Error(`LinkedIn profile text too short (${extracted.profileText?.length ?? 0} chars) — may be private`);
  }

  return {
    profileText: extracted.profileText,
    name: extracted.name,
    headline: extracted.headline,
    location: extracted.location,
    linkedinUrl: url,
  };
}
