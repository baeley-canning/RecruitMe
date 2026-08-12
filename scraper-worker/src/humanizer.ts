import type { Page, Locator } from "patchright";

/** Log-normal delay — most pauses are short; occasional long ones look human. */
export async function randomDelay(minMs: number, maxMs: number): Promise<void> {
  const range = maxMs - minMs;
  // Use a roughly log-normal distribution by squaring a uniform random.
  const r = Math.random() * Math.random();
  const ms = minMs + Math.floor(r * range);
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Scroll toward targetY in human-sized increments. */
export async function humanScroll(page: Page, targetY: number): Promise<void> {
  const current = await page.evaluate(() => window.scrollY);
  const step = targetY > current ? 1 : -1;
  let pos = current;
  // The walk is bounded because its cost scales with PAGE HEIGHT, and LinkedIn
  // results pages run to 20,000px+. At 50-150px a step with an 80-200ms pause,
  // an unbounded walk is ~340 steps ≈ 45s for ONE scroll; harvestVisibleCards
  // does two. On 2026-08-12 that consumed the entire 240s search budget twice
  // over — both jobs were recorded as timeouts having harvested 4 and 1 cards.
  //
  // Capping the steps and jumping the remainder keeps the incremental, lazy-
  // load-triggering motion that makes this look human while putting a ceiling
  // on the cost: MAX_STEPS * 200ms ≈ 8s worst case, whatever the page height.
  const MAX_STEPS = 40;
  let steps = 0;
  while (Math.abs(pos - targetY) > 50 && steps < MAX_STEPS) {
    const increment = step * (50 + Math.floor(Math.random() * 100));
    pos += increment;
    await page.evaluate((y: number) => window.scrollTo({ top: y, behavior: "instant" }), pos);
    await randomDelay(80, 200);
    steps++;
  }
  if (Math.abs(pos - targetY) > 50) {
    await page.evaluate((y: number) => window.scrollTo({ top: y, behavior: "instant" }), targetY);
    await randomDelay(120, 300);
  }
}

/** Type text character by character with human-like timing. */
export async function humanType(locator: Locator, text: string): Promise<void> {
  await locator.click();
  for (const char of text) {
    await locator.pressSequentially(char, { delay: 40 + Math.floor(Math.random() * 100) });
    if (char === " ") await randomDelay(100, 300);
  }
}

/** Pick a realistic desktop viewport. Desktop (not mobile) because both the
 *  login flow (#username/#password) and the profile scraper
 *  (.scaffold-layout__main) target LinkedIn's DESKTOP DOM. A mobile UA serves
 *  the mobile site where those selectors don't exist. */
export function randomViewport(): { width: number; height: number } {
  const viewports = [
    { width: 1366, height: 768 },
    { width: 1280, height: 800 },
    { width: 1440, height: 900 },
    { width: 1536, height: 864 },
  ];
  return viewports[Math.floor(Math.random() * viewports.length)];
}

/** Desktop Chrome UA (matches the bundled Chromium 148) so LinkedIn serves the
 *  desktop site the login + scraper selectors expect. */
export const DESKTOP_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
