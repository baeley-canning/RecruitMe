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
 *   • No pagination — only the first results page. Going deeper is the
 *     highest-detectability move and the top page typically has the best
 *     matches anyway. Re-run the search later to refresh.
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

export async function scrapeLinkedInSearch(
  query: string,
  page: Page,
): Promise<LinkedInSearchHarvest> {
  const encoded = encodeURIComponent(query);
  const url = `https://www.linkedin.com/search/results/people/?keywords=${encoded}&origin=GLOBAL_SEARCH_HEADER`;
  log.info(`linkedin-search: ${query}`);

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  // Human "loads page, glances at the top of results".
  await randomDelay(2_500, 5_000);

  const landed = page.url();
  if (/\/(checkpoint|authwall|uas\/login|login)/i.test(landed)) {
    // Stable machine-parseable prefix so the API can flip the SearchRun's
    // linkedinStatus to "needs re-auth" (string startsWith, not prose regex).
    throw new RateLimitError("linkedin_challenge: auth wall during search");
  }

  // Two moderate scroll passes to lazy-load the first page of results, then a
  // SINGLE extraction. (An earlier 4-pass interleaved version wedged the page
  // and hit the 120s harvest timeout on the low-power box — keep page ops
  // minimal.) Extraction is anchor-climb + LINE ORDER, structure-agnostic
  // (works whether LinkedIn wraps cards in <li> or <div>): for each /in/
  // anchor, climb to the smallest ancestor holding exactly one profile and
  // ≥2 text lines, then parse:
  //   line 0 = name, "• 2nd" = degree (skip), then headline, then location.
  const pageHeight = await page.evaluate(() => document.body.scrollHeight);
  await humanScroll(page, pageHeight * 0.45);
  await randomDelay(1_500, 3_000);
  await humanScroll(page, pageHeight * 0.85);
  await randomDelay(1_800, 3_200);

  const cards = await page.evaluate(() => {
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

  log.info(`linkedin-search: harvested ${cards.length} cards (${cards.filter((c) => c.name).length} with names)`);
  return { urls: cards.map((c) => c.url), cards };
}
