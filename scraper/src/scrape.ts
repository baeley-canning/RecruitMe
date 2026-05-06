/**
 * Core scrape logic — navigates to a LinkedIn profile and extracts text.
 *
 * Concurrency is limited to one active scrape at a time via a simple lock.
 * This keeps the load on a single browser instance manageable and avoids
 * the rapid multi-profile pattern that triggers LinkedIn's automation warnings.
 *
 * Timing is deliberately human-paced: random pauses between sections,
 * scrolling to trigger lazy-loaded content, and per-section delays to mimic
 * a real person reading a profile. The goal is NOT to be undetectable (LinkedIn
 * will always have better signal), but to reduce the fingerprint enough that
 * bulk-scraping triggers are less likely to fire on low-volume personal use.
 */

import { newContext } from "./browser.js";
import type { Page } from "playwright";

// Hard cap so a single scrape can't block the queue for 10 minutes.
const SCRAPE_TIMEOUT_MS = 90_000;

// Per-profile concurrency lock — one active scrape at a time.
let _activeScrape: Promise<ScrapeResult> | null = null;

export interface ScrapeResult {
  profileText: string;
  capturedAt: string;
  profileUrl: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(baseMs: number, variance = 0.4): number {
  return Math.round(baseMs * (1 + (Math.random() - 0.5) * variance));
}

async function scrollProfile(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      let scrolled = 0;
      const id = setInterval(() => {
        const step = 300 + Math.round(Math.random() * 200);
        window.scrollBy(0, step);
        scrolled += step;
        if (scrolled >= document.body.scrollHeight || scrolled > 12000) {
          clearInterval(id);
          resolve();
        }
      }, 120 + Math.round(Math.random() * 80));
    });
  });
  await sleep(jitter(800));
  // Scroll back to top to trigger any sticky sections
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(jitter(500));
}

async function extractMainText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const main = document.querySelector("main") as HTMLElement | null;
    if (!main) return document.body.innerText ?? "";

    const lines: string[] = [];
    const walk = (el: Element) => {
      const tag = el.tagName.toLowerCase();
      if (["script", "style", "noscript", "svg", "button", "nav"].includes(tag)) return;
      if ((el as HTMLElement).offsetParent === null && tag !== "body") return; // hidden
      const text = (el as HTMLElement).innerText?.trim();
      if (text && el.children.length === 0 && text.length > 0 && text.length < 500) {
        lines.push(text);
      }
      for (const child of Array.from(el.children)) walk(child);
    };
    walk(main);

    return [...new Set(lines)].join("\n");
  });
}

async function fetchDetailPage(page: Page, baseUrl: string, section: string): Promise<string> {
  await sleep(jitter(2000, 0.5)); // human pause before navigating to sub-page
  const detailUrl = baseUrl.replace(/\/?$/, `/details/${section}/`);
  try {
    const res = await page.goto(detailUrl, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    if (!res || !res.ok()) return "";
    // Only keep the page if it landed on the details section — not a redirect
    if (!page.url().includes(`/details/${section}`)) return "";
    await sleep(jitter(1200));
    const text = await extractMainText(page);
    // Back to the profile
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
    return text;
  } catch {
    return "";
  }
}

async function doScrape(url: string): Promise<ScrapeResult> {
  const ctx = await newContext();
  const page = await ctx.newPage();

  // Block heavy assets to speed up page load and reduce fingerprint noise.
  await page.route("**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf}", (r) => r.abort());
  await page.route("**/li/track*", (r) => r.abort()); // LinkedIn analytics

  try {
    // Navigate with a human-paced wait
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (!res || !res.ok()) throw new Error(`LinkedIn returned HTTP ${res?.status() ?? "?"} for ${url}`);

    // Make sure we're on a real profile, not a login/checkpoint wall
    if (page.url().includes("/authwall") || page.url().includes("/checkpoint") || page.url().includes("/login")) {
      throw new Error("LinkedIn redirected to auth/checkpoint page — session may be expired or requires manual verification");
    }

    await sleep(jitter(1500));
    await scrollProfile(page);

    // Canonical URL after potential redirect (handles vanity slug changes)
    const canonicalUrl = await page.evaluate(() =>
      document.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? location.href
    );
    const profileBaseUrl = canonicalUrl.split("?")[0].replace(/\/$/, "");

    const mainText = await extractMainText(page);

    // Fetch deep sections with human-paced pauses between each
    const sections: Record<string, string> = {};
    for (const section of ["experience", "skills", "education", "certifications"]) {
      sections[section] = await fetchDetailPage(page, profileBaseUrl, section);
    }

    const parts = [
      mainText,
      ...Object.entries(sections)
        .filter(([, v]) => v.length > 100)
        .map(([k, v]) => `\n\n${k.charAt(0).toUpperCase() + k.slice(1)}\n${v}`),
    ];

    const profileText = parts.join("").replace(/\n{3,}/g, "\n\n").trim();
    if (profileText.length < 200) {
      throw new Error("Extracted profile text was too short — profile may be private or empty");
    }

    return {
      profileText: profileText.slice(0, 100_000),
      capturedAt: new Date().toISOString(),
      profileUrl: canonicalUrl || url,
    };
  } finally {
    await ctx.close();
  }
}

// Public entry — serialises requests so only one scrape runs at a time.
export async function scrapeProfile(url: string): Promise<ScrapeResult> {
  // Wait for any active scrape to finish before starting a new one
  while (_activeScrape) {
    await _activeScrape.catch(() => {});
  }

  const promise = Promise.race([
    doScrape(url),
    sleep(SCRAPE_TIMEOUT_MS).then(() => {
      throw new Error("Scrape timed out after 90s");
    }),
  ]) as Promise<ScrapeResult>;

  _activeScrape = promise;
  try {
    return await promise;
  } finally {
    _activeScrape = null;
  }
}
