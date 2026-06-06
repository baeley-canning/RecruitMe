/**
 * SEEK Talent Search harvester. Mirrors linkedin-search.ts: given a
 * boolean query, navigates to SEEK's logged-in Talent Search results
 * page, scrolls through it human-paced, and harvests the unique
 * profile URLs from the result cards. Returns the URL list; the worker
 * POSTs each URL back as a normal kind="profile" platform="seek"
 * ScrapeJob so the existing scrape→ingest path enriches the local
 * library.
 *
 * Notes on SEEK:
 *   - The search lives under https://talentsearch.seek.com.au/ — a
 *     separate domain from the public job board (seek.com.au). Cookies
 *     and storage are per-domain; the worker's "seek" session must be
 *     pointed at talentsearch.seek.com.au.
 *   - The keywords box accepts the same boolean operators as LinkedIn:
 *     uppercase AND / OR / NOT, parens, "quoted phrases". The full
 *     query goes straight into the `keywords` URL param.
 *   - SEEK lazy-loads result cards on scroll, just like LinkedIn — same
 *     three-pass human scroll pattern works.
 *
 * Pacing: deliberately slow (3 scroll passes, multi-second pauses) to
 * stay below detection thresholds. No pagination — first page only.
 */

import type { Page } from "patchright";
import { randomDelay } from "../humanizer.js";
import { log } from "../util/log.js";
import { RateLimitError } from "./linkedin.js";
import type { SearchCard } from "./linkedin-search.js";

export interface SeekSearchHarvest {
  urls: string[];
  cards: SearchCard[];
}

const AUTH_WALL = /login\.seek\.com|authenticate\.seek\.com|\/oauth\/|\/sign-in/i;

// SEEK Talent Search is REGION-SPECIFIC: an NZ employer account lives at
// nz.employer.seek.com (nation=3001), an AU one at au.employer.seek.com
// (nation=3000). Pointing at the wrong region returns the wrong candidates (or
// zero) — placeMe is an NZ agency, so default NZ. Override with
// SEEK_EMPLOYER_HOST if the account region differs.
const SEEK_HOST = process.env.SEEK_EMPLOYER_HOST ?? "https://nz.employer.seek.com";
// 3001 = NZ candidate pool, 3000 = AU. Matches the employer host's region.
const SEEK_NATION = process.env.SEEK_NATION ?? "3001";
// Result pages to harvest (20 cards each). 5 → up to ~100 results. Listing
// cards is credit-free, so this is safe to raise.
const SEEK_MAX_PAGES = Math.max(1, Number(process.env.SEEK_MAX_PAGES ?? "5") || 5);

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Extract result cards from the current /search/profiles page. Each card links
// to /talentsearch/profile/<id>; name = line 0, headline = line 1, location =
// the line ending in a 2-letter country code ("Wellington, NZ"). Structure-only
// parse, no hashed class names.
function extractSeekCards(page: Page, host: string) {
  return page.evaluate((h: string) => {
    const out: { url: string; name: string | null; headline: string | null; location: string | null }[] = [];
    const seen = new Set<string>();
    const idOf = (href: string): string | null => {
      const m = href.match(/\/profile\/(\d+)/);
      return m ? m[1] : null;
    };
    for (const a of Array.from(document.querySelectorAll('a[href*="/profile/"]')) as HTMLAnchorElement[]) {
      const id = idOf(a.href);
      if (!id || seen.has(id)) continue;
      let el: HTMLElement | null = a;
      let card: HTMLElement | null = null;
      for (let i = 0; i < 10 && el; i++) {
        const ids = new Set(
          (Array.from(el.querySelectorAll('a[href*="/profile/"]')) as HTMLAnchorElement[])
            .map((x) => idOf(x.href))
            .filter(Boolean),
        );
        const lineCount = (el.innerText || "").split("\n").filter((s) => s.trim()).length;
        if (ids.size === 1 && lineCount >= 2) card = el;
        if (ids.size > 1) break;
        el = el.parentElement;
      }
      seen.add(id);
      let name: string | null = null;
      let headline: string | null = null;
      let location: string | null = null;
      if (card) {
        const lines = (card.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean);
        name = lines[0] ?? null;
        headline = lines[1] ?? null;
        location = lines.find((l) => /,\s*[A-Z]{2}$/.test(l)) ?? null;
      }
      out.push({ url: `${h}/talentsearch/profile/${id}`, name, headline, location });
    }
    return out;
  }, host);
}

export async function scrapeSeekSearch(
  query: string,
  page: Page,
  location?: string | null,
): Promise<SeekSearchHarvest> {
  log.info(`seek-search: ${query} (${SEEK_HOST} nation=${SEEK_NATION}${location ? ` loc=${location}` : ""})`);

  // Open the Talent Search FORM and SUBMIT — SEEK only runs the search on form
  // submit (it builds a searchId); navigating directly to /search/profiles
  // lands empty. First text input = boolean keyword box; the "Suburb, city or
  // region" box optionally scopes location; the pink "SEEK" button submits.
  await page.goto(`${SEEK_HOST}/talentsearch/search`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await randomDelay(2_000, 4_000);

  if (AUTH_WALL.test(page.url())) {
    // The session isn't valid for this region's employer portal — run
    // `npx tsx login.ts seek` on the box to refresh it.
    throw new RateLimitError("seek_challenge: auth wall / login redirect during search (run login.ts seek)");
  }

  const box = page
    .locator('input[type="text"], input[type="search"], textarea, [contenteditable="true"]')
    .first();
  try {
    await box.waitFor({ state: "visible", timeout: 20_000 });
  } catch {
    throw new Error(`seek-search: keyword box not found on ${page.url()} — Talent Search UI may have changed`);
  }
  await box.click({ timeout: 10_000 }).catch(() => {});
  await box.fill(query, { timeout: 10_000 }).catch(() => {});
  await randomDelay(500, 1_000);

  // Location filter: type into the "Suburb, city or region" box and pick the
  // broad "All <region>" option from the autocomplete (matches a recruiter's
  // region search, e.g. "All Wellington"). Best-effort — if it doesn't take,
  // the search just runs nation-wide.
  if (location) {
    const locBox = page.getByPlaceholder(/suburb, city or region/i).first();
    if (await locBox.count().catch(() => 0)) {
      await locBox.click({ timeout: 8_000 }).catch(() => {});
      await locBox.fill(location, { timeout: 8_000 }).catch(() => {});
      await randomDelay(1_800, 2_800); // let the autocomplete dropdown render
      // The region-wide option is a <li role="option">All <region></li> (probe-
      // confirmed). waitFor (not a bare count check) so a slow dropdown doesn't
      // make us skip the pick and silently fall back to a nation-wide search.
      const allOpt = page.getByText(new RegExp(`^All\\s+${escapeRegex(location)}`, "i")).first();
      let picked = false;
      try {
        await allOpt.waitFor({ state: "visible", timeout: 6_000 });
        await allOpt.click({ timeout: 5_000 });
        picked = true;
      } catch { /* option didn't render in time — fall back to keyboard select */ }
      if (!picked) {
        // fall back to the first suggestion
        await page.keyboard.press("ArrowDown").catch(() => {});
        await page.keyboard.press("Enter").catch(() => {});
      }
      await randomDelay(600, 1_200);
    }
  }

  // Submit via the SEEK button (more reliable than Enter when two fields exist).
  const seekBtn = page.getByRole("button", { name: /^seek$/i }).first();
  if (await seekBtn.count().catch(() => 0)) {
    await seekBtn.click({ timeout: 8_000 }).catch(() => {});
  } else {
    await page.keyboard.press("Enter").catch(() => {});
  }
  await page.waitForURL(/\/search\/profiles/, { timeout: 25_000 }).catch(() => {});
  await randomDelay(3_000, 5_000);

  if (AUTH_WALL.test(page.url())) {
    throw new RateLimitError("seek_challenge: auth wall / login redirect during search (run login.ts seek)");
  }

  // Verify the region filter actually applied: SEEK puts locationList=<id> in
  // the results URL when it accepted the pick. If a location was requested but
  // it's absent, the search is running NATION-WIDE — log loudly so capped
  // nation-wide results aren't silently presented as region-scoped (the bug
  // behind "100 harvested vs 33 real Wellington matches").
  if (location && !/[?&]locationList=/.test(page.url())) {
    log.warn(
      `seek-search: location "${location}" was NOT applied (no locationList in results URL) — ` +
        `search ran nation-wide; harvest will be over-broad and capped. URL: ${page.url()}`,
    );
  }

  // Harvest page 1, then paginate by incrementing pageNumber in the URL (the
  // searchId in the URL persists the search context). Cap at SEEK_MAX_PAGES and
  // stop early once we've covered the reported total.
  const byUrl = new Map<string, { url: string; name: string | null; headline: string | null; location: string | null }>();
  const absorb = (rows: { url: string; name: string | null; headline: string | null; location: string | null }[]) => {
    for (const r of rows) if (!byUrl.has(r.url)) byUrl.set(r.url, r);
  };
  absorb(await extractSeekCards(page, SEEK_HOST));

  // Total matches → page budget (20/page), capped.
  const total = await page.evaluate(() => {
    const m = (document.body.innerText || "").match(/([\d,]+)\s+matching candidates/i);
    return m ? Number(m[1].replace(/,/g, "")) : 0;
  });
  const pagesNeeded = total > 0 ? Math.ceil(total / 20) : 1;
  const maxPages = Math.min(SEEK_MAX_PAGES, Math.max(1, pagesNeeded));

  // CLICK the "Next" pagination control — the SPA ignores a changed pageNumber
  // in a fresh URL (it resets to page 1), but clicking rel="next" properly
  // advances and loads the next 20. Verified: each click yields 20 fresh cards.
  for (let p = 2; p <= maxPages; p++) {
    const next = page.locator('a[rel="next"], [aria-label="Next" i]').first();
    if (!(await next.count().catch(() => 0))) break; // no Next = last page
    const enabled = await next.isEnabled().catch(() => false);
    if (!enabled) break;
    await next.scrollIntoViewIfNeeded().catch(() => {});
    const before = byUrl.size;
    await next.click({ timeout: 8_000 }).catch(() => {});
    await page.waitForURL(new RegExp(`pageNumber=${p}\\b`), { timeout: 15_000 }).catch(() => {});
    await randomDelay(2_500, 4_000);
    if (AUTH_WALL.test(page.url())) break;
    absorb(await extractSeekCards(page, SEEK_HOST));
    if (byUrl.size === before) break; // no new cards — stop early
  }

  const cards = Array.from(byUrl.values());
  log.info(
    `seek-search: harvested ${cards.length} cards across ${maxPages} page(s) ` +
      `(${cards.filter((c) => c.name).length} with names, ${total} total matches)`,
  );
  return { urls: cards.map((c) => c.url), cards };
}
