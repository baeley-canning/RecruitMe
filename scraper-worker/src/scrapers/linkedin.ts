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

export async function scrapeLinkedInProfile(url: string, page: Page): Promise<LinkedInProfile> {
  log.info(`linkedin: scraping ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await randomDelay(1200, 2500);

  const currentUrl = page.url();
  if (currentUrl.includes("/checkpoint") || currentUrl.includes("/captcha")) {
    throw new RateLimitError("LinkedIn checkpoint/captcha detected");
  }
  if (currentUrl.includes("/login") || currentUrl.includes("/authwall")) {
    throw new RateLimitError("LinkedIn auth wall — session expired");
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

    const name = getText("h1");
    const headline = getText(".text-body-medium.break-words") ?? getText('[data-generated-suggestion-target]');
    const location = getText(".text-body-small.inline.t-black--light.break-words");

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
