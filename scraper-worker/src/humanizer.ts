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
  while (Math.abs(pos - targetY) > 50) {
    const increment = step * (50 + Math.floor(Math.random() * 100));
    pos += increment;
    await page.evaluate((y: number) => window.scrollTo({ top: y, behavior: "instant" }), pos);
    await randomDelay(80, 200);
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
