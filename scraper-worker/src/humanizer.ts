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

/** Pick a realistic mobile viewport. */
export function randomViewport(): { width: number; height: number } {
  const viewports = [
    { width: 390, height: 844 },  // iPhone 14
    { width: 412, height: 915 },  // Pixel 7
    { width: 393, height: 852 },  // iPhone 15 Pro
    { width: 375, height: 812 },  // iPhone X
  ];
  return viewports[Math.floor(Math.random() * viewports.length)];
}

export const MOBILE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
