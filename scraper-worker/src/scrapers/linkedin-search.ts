/**
 * LinkedIn people-search harvester. Given a boolean query, navigates to
 * LinkedIn's logged-in search results page, scrolls through it human-paced,
 * and harvests the unique profile URLs from the rendered cards. Returns the
 * URL list; the worker POSTs each URL back as a normal kind="profile"
 * ScrapeJob so the existing scrape→ingest path enriches the local library.
 *
 * Pacing is deliberately slow + human:
 *   • Wait several seconds after page load (human "reads the page").
 *   • Three scroll passes with multi-second pauses between them, so lazy-
 *     loaded results render and the session looks like a human browsing.
 *   • Pagination is OPT-IN and OFF by default (maxPages=1 → first results page
 *     only). Going deeper via &page=N is the highest-detectability move, so it's
 *     gated behind SCRAPER_SEARCH_MAX_PAGES on the worker — page-1 behaviour is
 *     byte-identical to before when the cap is 1. Each extra page adds a long
 *     human pause and stops early if a page yields no new cards.
 *
 * Abort on challenge: if LinkedIn bounces us to /checkpoint, /authwall, or a
 * login redirect, throw RateLimitError (reused from the profile scraper) so
 * the worker fails the job and the caller backs off.
 */

import type { Page } from "patchright";
import { humanScroll, randomDelay } from "../humanizer.js";
import { log } from "../util/log.js";
import { RateLimitError } from "./linkedin.js";

/** A harvested search-result card: the profile URL plus the name/headline/
 *  location already visible on the results page, so the UI can show a real
 *  row immediately instead of a "fetching…" placeholder. */
export interface SearchCard {
  url: string;
  name: string | null;
  headline: string | null;
  location: string | null;
}

export interface LinkedInSearchHarvest {
  urls: string[];
  cards: SearchCard[];
}

/** The slug (LinkedIn vanity id) from a harvested card URL, for cross-page dedup. */
function slugFromCardUrl(u: string): string | null {
  const m = u.match(/\/in\/([^/?#]+)/i);
  return m ? m[1] : null;
}

// Scroll the CURRENT results page human-paced, then extract the visible profile
// cards. Pulled into a helper so the pagination loop can reuse the exact same
// scroll+extract on each page. Two moderate scroll passes to lazy-load the
// results, then a SINGLE extraction. (An earlier 4-pass interleaved version
// wedged the page and hit the 120s harvest timeout on the low-power box — keep
// page ops minimal.) Extraction is anchor-climb + LINE ORDER, structure-agnostic
// (works whether LinkedIn wraps cards in <li> or <div>): for each /in/ anchor,
// climb to the smallest ancestor holding exactly one profile and ≥2 text lines,
// then parse: line 0 = name, "• 2nd" = degree (skip), then headline, location.
async function harvestVisibleCards(page: Page): Promise<SearchCard[]> {
  const pageHeight = await page.evaluate(() => document.body.scrollHeight);
  await humanScroll(page, pageHeight * 0.45);
  await randomDelay(1_500, 3_000);
  await humanScroll(page, pageHeight * 0.85);
  await randomDelay(1_800, 3_200);

  return await page.evaluate(() => {
    const ACTION = /^(Connect|Message|Follow|Following|Pending|View .*profile|Save|Connections?)$/i;
    const slugOf = (href: string): string | null => {
      try {
        const u = new URL(href, window.location.origin);
        if (!u.hostname.includes("linkedin.com") || !u.pathname.startsWith("/in/")) return null;
        return u.pathname.split("/")[2] || null;
      } catch {
        return null;
      }
    };
    // Group every /in/ anchor by slug — the NAME is the most reliable signal and
    // lives in the anchor text itself ("Runika Mathur • 2nd…" or just "Runika
    // Mathur"). Cards embedding "X and Y are mutual connections" contain OTHER
    // /in/ links, so we can't require a single-slug container; instead derive
    // the name straight from the anchor text, and best-effort the headline/
    // location from the card's first text lines.
    const bySlug = new Map<string, HTMLAnchorElement[]>();
    const order: string[] = [];
    for (const a of Array.from(document.querySelectorAll('a[href*="/in/"]')) as HTMLAnchorElement[]) {
      const slug = slugOf(a.href);
      if (!slug) continue;
      if (!bySlug.has(slug)) {
        bySlug.set(slug, []);
        order.push(slug);
      }
      bySlug.get(slug)!.push(a);
    }
    const cleanName = (t: string): string | null => {
      let s = (t || "").split("\n")[0].trim();
      const dot = s.indexOf(" • ");
      if (dot >= 0) s = s.slice(0, dot).trim();
      if (!s || s.length > 60 || ACTION.test(s) || /^https?:/i.test(s)) return null;
      return s;
    };
    const out: { url: string; name: string | null; headline: string | null; location: string | null }[] = [];
    for (const slug of order) {
      const anchors = bySlug.get(slug)!;
      // Name: first anchor text that cleans to a plausible name.
      let name: string | null = null;
      for (const a of anchors) {
        name = cleanName(a.textContent || "");
        if (name) break;
      }
      // Headline/location: from the card container's text lines (the line after
      // the name + degree is the headline; the next non-action line the location).
      let headline: string | null = null;
      let location: string | null = null;
      const host = anchors[0].closest("li") || anchors[0].parentElement?.parentElement?.parentElement || null;
      if (host && name) {
        const lines = ((host as HTMLElement).innerText || "")
          .split("\n").map((s) => s.trim()).filter(Boolean);
        const idx = lines.findIndex((l) => l.startsWith(name!));
        if (idx >= 0) {
          const rest = lines
            .slice(idx + 1)
            .filter((l) => !l.startsWith("•") && !ACTION.test(l) && !/^Current:/i.test(l) && !/mutual connection/i.test(l));
          headline = rest[0] ?? null;
          location = rest[1] ?? null;
        }
      }
      // WHY: only emit genuine search RESULTS. Real result cards always carry a
      // headline (line after "• Nth" degree) or at least a location; the
      // "People also viewed" sidebar and "X and Y are mutual connections" links
      // (e.g. Teresa Jordan, Han Li) are bare name-only anchors whose container
      // has neither. Dropping name-only-with-no-headline-and-no-location cards
      // removes those non-matches while staying conservative — anything with a
      // headline OR location survives.
      if (name && !headline && !location) continue;
      out.push({ url: `https://www.linkedin.com/in/${slug}`, name, headline, location });
    }
    return out;
  });
}

export async function scrapeLinkedInSearch(
  query: string,
  page: Page,
  maxPages = 1,
): Promise<LinkedInSearchHarvest> {
  const encoded = encodeURIComponent(query);
  // Constrain to New Zealand (geoId 103844754) so LinkedIn doesn't return
  // overseas profiles — RecruitMe is NZ-only and the app then narrows to the
  // requested region. Without geoUrn, results are only loosely NZ-biased by the
  // logged-in account, so other countries leak in.
  const nzGeo = encodeURIComponent('["103844754"]');
  const baseUrl = `https://www.linkedin.com/search/results/people/?keywords=${encoded}&geoUrn=${nzGeo}&origin=GLOBAL_SEARCH_HEADER`;
  const pages = Math.max(1, Math.min(maxPages, 10)); // hard cap — detectability guard
  log.info(`linkedin-search: ${query}${pages > 1 ? ` (up to ${pages} pages)` : ""}`);

  const challenge = (landed: string, where: string) => {
    if (/\/(checkpoint|authwall|uas\/login|login)/i.test(landed)) {
      // Stable machine-parseable prefix so the API can flip the SearchRun's
      // linkedinStatus to "needs re-auth" (string startsWith, not prose regex).
      throw new RateLimitError(`linkedin_challenge: auth wall during search${where}`);
    }
  };

  // Dedup harvested cards by slug across pages (the same person can re-appear).
  const bySlug = new Map<string, SearchCard>();
  const absorb = (cards: SearchCard[]): number => {
    let added = 0;
    for (const c of cards) {
      const slug = slugFromCardUrl(c.url);
      if (!slug || bySlug.has(slug)) continue;
      bySlug.set(slug, c);
      added++;
    }
    return added;
  };

  // Page 1 — byte-identical to the pre-pagination behaviour.
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await randomDelay(2_500, 5_000); // human "loads page, glances at the top"
  challenge(page.url(), "");
  absorb(await harvestVisibleCards(page));

  // Pages 2..N — opt-in via SCRAPER_SEARCH_MAX_PAGES (default 1 → this loop
  // never runs). Long human pause between pages; stop the moment a page yields
  // nothing new (end of results / repeated page) so we never page past signal.
  for (let p = 2; p <= pages; p++) {
    await randomDelay(3_000, 6_000); // human "turns the page"
    try {
      await page.goto(`${baseUrl}&page=${p}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await randomDelay(2_500, 5_000);
      challenge(page.url(), ` (page ${p})`);
      const added = absorb(await harvestVisibleCards(page));
      log.info(`linkedin-search: page ${p} added ${added} new card(s)`);
      if (added === 0) break;
    } catch (err) {
      if (err instanceof RateLimitError) throw err; // challenge → fail the job + back off
      // Any other page error: keep what we have rather than failing the whole harvest.
      log.warn(`linkedin-search: page ${p} failed (${err instanceof Error ? err.message : String(err)}) — stopping pagination`);
      break;
    }
  }

  const cards = [...bySlug.values()];
  log.info(`linkedin-search: harvested ${cards.length} cards (${cards.filter((c) => c.name).length} with names)`);
  return { urls: cards.map((c) => c.url), cards };
}
