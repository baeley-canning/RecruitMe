/**
 * Humanizer — makes scraping behaviour look like real human interaction.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────────
 * LinkedIn, SEEK, and JobAdder use behavioural analytics to detect bots.
 * Key signals they look for:
 *   - Instant scrolling (bots jump to page bottom)
 *   - Uniform timing between actions (bots are too consistent)
 *   - Inhuman typing speed (bots type at 1000+ WPM)
 *   - No mouse movement between clicks
 *   - Fixed viewport size
 *
 * This module adds realistic variance to all of those signals.
 *
 * ── TUNING GUIDE (for AI handoff) ────────────────────────────────────────────
 * If LinkedIn starts rate-limiting the Pi:
 *   1. Increase LINKEDIN_HOURLY_CAP in .env (default 8)
 *   2. Increase randomDelay() range in the scraper — add more min/max
 *   3. Add randomViewport() calls between profiles
 *   4. Check if the Pi's IP changed — carrier IPs can still be flagged if
 *      the same IP scrapes too many profiles in one session
 */

import type { Page, Locator } from "playwright";

// Real mobile viewport dimensions from common devices
const MOBILE_VIEWPORTS = [
  { width: 390,  height: 844  }, // iPhone 14
  { width: 393,  height: 852  }, // iPhone 15 Pro
  { width: 412,  height: 915  }, // Pixel 7
  { width: 414,  height: 896  }, // iPhone 11 Pro Max
  { width: 360,  height: 800  }, // Samsung Galaxy S21
  { width: 428,  height: 926  }, // iPhone 12 Pro Max
];

export function randomViewport(): { width: number; height: number } {
  return MOBILE_VIEWPORTS[Math.floor(Math.random() * MOBILE_VIEWPORTS.length)];
}

/**
 * Log-normal delay that clusters around a natural "human" center.
 * Mean ~= (minMs + maxMs) / 2, with long-tail for "thinking pauses".
 */
export function randomDelay(minMs: number, maxMs: number): Promise<void> {
  // Use log-normal to cluster around midpoint with natural right-skew
  const mean = (minMs + maxMs) / 2;
  const sigma = (maxMs - minMs) / 6;
  const u1 = Math.random(), u2 = Math.random();
  const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const ms = Math.max(minMs, Math.min(maxMs, mean + normal * sigma));
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Scroll to targetY in small increments with variable speed.
 * Simulates a human scrolling through content at reading pace.
 */
export async function humanScroll(page: Page, targetY: number): Promise<void> {
  const currentY: number = await page.evaluate(() => window.scrollY);
  const distance = targetY - currentY;
  if (Math.abs(distance) < 50) return;

  const stepSize = 60 + Math.random() * 80; // 60-140px per step
  const steps = Math.ceil(Math.abs(distance) / stepSize);
  const direction = distance > 0 ? 1 : -1;

  for (let i = 0; i < steps; i++) {
    const scrollAmount = Math.min(stepSize, Math.abs(distance) - i * stepSize);
    await page.mouse.wheel(0, direction * scrollAmount);
    // Variable pause between scroll steps — fast reading pace
    await randomDelay(60, 200);

    // Occasional longer pause (looking at content)
    if (Math.random() < 0.08) {
      await randomDelay(400, 1200);
    }
  }
}

/**
 * Scroll through an entire page to simulate reading it top-to-bottom.
 * Returns when the page bottom is reached.
 */
export async function scrollPageToBottom(page: Page): Promise<void> {
  let lastHeight = 0;
  let attempts = 0;
  const maxAttempts = 30;

  while (attempts < maxAttempts) {
    const pageHeight: number = await page.evaluate(() => document.body.scrollHeight);
    const viewportHeight: number = await page.evaluate(() => window.innerHeight);
    const scrollY: number = await page.evaluate(() => window.scrollY);

    if (scrollY + viewportHeight >= pageHeight - 50) break;

    // Scroll one viewport-height at a time, with human variance
    const scrollAmount = viewportHeight * (0.6 + Math.random() * 0.4);
    await humanScroll(page, scrollY + scrollAmount);

    if (pageHeight === lastHeight) {
      attempts++;
    } else {
      lastHeight = pageHeight;
      attempts = 0;
    }

    await randomDelay(300, 900);
  }
}

/**
 * Type text char-by-char with realistic typing speed and word pauses.
 * Much slower than programmatic fill() — looks like a human typing.
 */
export async function humanType(locator: Locator, text: string): Promise<void> {
  await locator.click();
  await randomDelay(200, 500);

  for (let i = 0; i < text.length; i++) {
    await locator.pressSequentially(text[i], { delay: 40 + Math.random() * 100 });

    // Pause between words (space character)
    if (text[i] === " " && Math.random() < 0.3) {
      await randomDelay(100, 350);
    }

    // Occasional longer thinking pause mid-word
    if (Math.random() < 0.02) {
      await randomDelay(300, 800);
    }
  }
}

/**
 * Move mouse to a random point near the current position.
 * Prevents the cursor from sitting perfectly still between actions.
 */
export async function humanMouseDrift(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  if (!viewport) return;
  const x = 100 + Math.random() * (viewport.width - 200);
  const y = 100 + Math.random() * (viewport.height - 200);
  await page.mouse.move(x, y, { steps: 5 + Math.floor(Math.random() * 10) });
}

/**
 * Random pause that simulates a human "reading" the page before taking action.
 * Call after navigation and before any interaction.
 */
export async function humanPagePause(): Promise<void> {
  await randomDelay(1200, 3500);
}
