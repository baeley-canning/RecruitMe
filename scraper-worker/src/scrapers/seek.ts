import type { Page } from "patchright";
import { humanScroll, randomDelay } from "../humanizer.js";
import { log } from "../util/log.js";

export interface SeekProfile {
  profileText: string;
  name: string | null;
  headline: string | null;
  location: string | null;
  seekUrl: string;
  linkedinUrl: string | null;
}

export async function scrapeSeekProfile(url: string, page: Page): Promise<SeekProfile> {
  log.info(`seek: scraping ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await randomDelay(1000, 2000);

  const currentUrl = page.url();
  if (currentUrl.includes("/login") || currentUrl.includes("/signin")) {
    throw new Error("SEEK session expired — re-authentication required");
  }

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

    // SEEK Talent profile layout selectors (approximated — may need tuning).
    const name = getText('[data-testid="candidate-name"], h1, .candidate-name');
    const headline = getText('[data-testid="candidate-headline"], .candidate-headline');
    const location = getText('[data-testid="candidate-location"], .candidate-location');

    const profileSections = [
      getText('[data-testid="summary"], .candidate-summary'),
      getAllText('[data-testid="work-history"] li, .work-history-item'),
      getAllText('[data-testid="education"] li, .education-item'),
      getAllText('[data-testid="skills"] li, .skill-item'),
    ].filter(Boolean).join("\n\n");

    const mainText = (document.querySelector("main, [role='main']") as HTMLElement)?.innerText ?? "";

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
    throw new Error(`SEEK profile text too short — may require different selectors`);
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
