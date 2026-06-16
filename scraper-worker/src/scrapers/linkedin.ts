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

// ── Ban-safety dials ─────────────────────────────────────────────────────────
// The box drives a persistent, automated, logged-in session — far more
// detectable than a human in their own browser. The cardinal rule (learned the
// hard way: jumping straight to /details/experience + /details/education got a
// temp ban): NEVER navigate off the profile page. We stay put, glide-scroll
// like a reader, and click only the IN-PLACE "…see more" text expanders. We do
// NOT click "Show all N experiences" (that's a link to /details/ — the move
// that gets flagged). Conservative by design; tune here if needed.
// Env-tunable so the operator can dial expansion down — or OFF entirely with
// SCRAPER_LINKEDIN_MAX_EXPAND=0 (glide + extract only, zero clicks) — without a
// code change if LinkedIn tightens bot detection. Conservative defaults.
const MAX_EXPAND_CLICKS = Number(process.env.SCRAPER_LINKEDIN_MAX_EXPAND ?? 20); // hard ceiling on expander clicks
const EXPAND_BUDGET_MS  = Number(process.env.SCRAPER_LINKEDIN_EXPAND_MS ?? 30_000); // wall-clock budget for expansion

// SSRF defence-in-depth: the profileUrl arrives from search harvests / the API,
// so before navigating we assert it's https and points at an allowed platform
// host. A poisoned/internal URL (file://, http://169.254.169.254, an intranet
// box) would otherwise be driven by the logged-in browser. Throw clearly so the
// job fails fast instead of fetching something it shouldn't.
const ALLOWED_PROFILE_HOST =
  /(^|\.)linkedin\.com$|(^|\.)seek\.com\.au$|(^|\.)employer\.seek\.com$|(^|\.)jobadder\.com$/i;

export function assertAllowedProfileUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Refusing to scrape malformed URL: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Refusing to scrape non-https URL: ${url}`);
  }
  if (!ALLOWED_PROFILE_HOST.test(parsed.hostname)) {
    throw new Error(`Refusing to scrape disallowed host: ${parsed.hostname}`);
  }
}

/** Glide down the profile in human-sized steps with reading dwells, so every
 *  lazy-loaded section (Experience/Education/Skills) renders before we extract.
 *  Pure scrolling — no clicks, no navigation. */
async function glideProfile(page: Page): Promise<void> {
  // Dwell at the top first — "reading the header / about". This is also the
  // signal that drives LinkedIn's own "viewed your profile" feature, i.e. it
  // reads as a genuine visit.
  await randomDelay(2_000, 4_500);
  let lastHeight = 0;
  for (let i = 0; i < 8; i += 1) {
    const height = await page.evaluate(() => document.body.scrollHeight);
    const target = Math.min(height, Math.round((i + 1) * height * 0.16));
    await humanScroll(page, target);
    await randomDelay(700, 1_700); // pause on each "screen" like a reader
    if (height === lastHeight && i >= 3) break; // bottom reached + stable
    lastHeight = height;
  }
}

// In-page expansion: click ONLY safe in-place "…see more" text expanders, paced
// like a human, and bail the instant a click changes the URL. Returns how many
// it expanded and whether it had to back out of a navigation. Kept as a single
// page function (DOM-context) so the click→read→click rhythm runs page-side; the
// caller adds a second, box-side URL guard as belt-and-braces.
async function expandInPlace(
  page: Page,
  maxClicks: number,
  budgetMs: number,
): Promise<{ clicked: number; navigatedAway: boolean }> {
  return page.evaluate(
    async ({ maxClicks, budgetMs }) => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const rand = (a: number, b: number) => a + Math.floor(Math.random() * (b - a));
      const clean = (s: string | null | undefined) =>
        (s || "").replace(/ /g, " ").replace(/[ \t]{2,}/g, " ").trim();

      const SAFE = /\b(about|experience|education|licenses|certifications|skills|top skills)\b/i;
      const BLOCKED =
        /\b(activity|posts|featured|recommendations|interests|people also viewed|people you may know|pages for you|explore premium|groups|services)\b/i;
      const SECTION_SEL = "section, div.artdeco-card, div.pvs-card, div[data-view-name]";
      const onProfile = () => /linkedin\.com\/in\//i.test(location.href);

      const parentHeading = (el: Element): string => {
        let n: Element | null = el.parentElement;
        while (n && n !== document.body) {
          if (n.matches && n.matches(SECTION_SEL)) {
            const h = n.querySelector("h2, h3");
            const t = h ? clean((h as HTMLElement).innerText || h.textContent) : "";
            if (t && (SAFE.test(t) || BLOCKED.test(t))) return t;
          }
          n = n.parentElement;
        }
        return "";
      };
      const inPlaceClass = (el: Element) => {
        const c = typeof el.className === "string" ? el.className : "";
        return /inline-show-more-text__button|lt-line-clamp__more|see-more-less-toggle/i.test(c);
      };
      // The crux of the ban-safety: a clickable thing is safe ONLY if it's a
      // <button> with no href, not wrapped in a link/nav, whose label is a pure
      // in-place text expander ("…see more" / "see more" / "more"). We never
      // match "Show all N …" — those are <a> links to /details/ pages.
      const safeToClick = (el: Element): boolean => {
        if (!el || el.tagName !== "BUTTON") return false;
        if (el.getAttribute("href")) return false;
        if (el.closest("a, [role='link'], nav, header, footer, aside, [role='dialog']")) return false;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const label = clean(
          (el as HTMLElement).innerText ||
            el.getAttribute("aria-label") ||
            el.getAttribute("title"),
        );
        const isInPlaceLabel = /^(?:…\s*)?see more$|^(?:…\s*)?more$|^show more$/i.test(label);
        if (!inPlaceClass(el) && !isInPlaceLabel) return false;
        const heading = parentHeading(el);
        if (!heading || BLOCKED.test(heading)) return false;
        return SAFE.test(heading);
      };

      const clicked = new Set<string>();
      let total = 0;
      const startedAt = Date.now();

      for (let pass = 0; pass < 4; pass += 1) {
        if (Date.now() - startedAt > budgetMs || total >= maxClicks) break;
        let clickedThisPass = 0;
        // Re-query each pass — earlier clicks mutate the DOM and stale prior nodes.
        const controls = Array.from(
          document.querySelectorAll("main section button, main div.artdeco-card button"),
        );
        for (const el of controls) {
          if (Date.now() - startedAt > budgetMs || total >= maxClicks) break;
          try {
            if (!safeToClick(el)) continue;
            const key = `${clean((el as HTMLElement).innerText)}|${el.getAttribute("aria-label") || ""}|${parentHeading(el)}`;
            if (clicked.has(key)) continue;
            clicked.add(key);
            el.scrollIntoView({ block: "center", behavior: "auto" });
            await sleep(rand(250, 700)); // settle on it before clicking
            (el as HTMLElement).click();
            total += 1;
            clickedThisPass += 1;
            await sleep(rand(800, 2_000)); // "read" the freshly expanded text
            if (!onProfile()) {
              // A click navigated us off the profile (shouldn't happen with the
              // filter above, but if LinkedIn changes a button to a nav action,
              // this is the in-page backstop): go back, stop expanding.
              try { history.back(); } catch { /* noop */ }
              await sleep(1_500);
              return { clicked: total, navigatedAway: true };
            }
          } catch {
            // Stale node after a prior expand mutated the DOM — the next pass
            // re-queries and picks it up. Never let one bad node abort the rest.
          }
        }
        if (clickedThisPass === 0) break; // nothing left to expand
        await sleep(rand(1_200, 3_000)); // pause between passes
      }
      return { clicked: total, navigatedAway: false };
    },
    { maxClicks, budgetMs },
  );
}

/** Extract a populated, de-noised profileText plus name/headline/location, using
 *  selectors that survive LinkedIn's redesigns: sections are anchored by their
 *  stable id div (#about/#experience/#education/#skills — kept for in-page nav),
 *  not by volatile class names. Falls back to a filtered dump of the main column. */
async function extractProfile(page: Page): Promise<{
  name: string | null;
  headline: string | null;
  location: string | null;
  profileText: string;
}> {
  return page.evaluate(() => {
    const clean = (s: string | null | undefined) =>
      (s || "").replace(/ /g, " ").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    const toLines = (s: string) => clean(s).split(/\n+/).map(clean).filter(Boolean);
    const getText = (sel: string) => {
      const e = document.querySelector(sel);
      return e ? clean((e as HTMLElement).innerText || e.textContent) : null;
    };

    const STOP = [
      /^more profiles for you$/i, /^people you may know$/i, /^pages for you$/i,
      /^explore premium/i, /^linkedin corporation/i, /^select language$/i,
    ];
    const NOISE = [
      /^message$/i, /^follow$/i, /^following$/i, /^connect$/i, /^pending$/i, /^contact info$/i,
      /^more$/i, /^show all/i, /^see all/i, /^see more$/i, /^show more$/i, /^…\s*more$/i,
      /^connections?$/i, /^followers$/i, /^\d+\+?\s+(connections?|followers)$/i,
      /^\d+\s+endorsements?$/i, /^[·•]?\s*\d+(st|nd|rd|th)$/i, /^save in sales navigator$/i,
    ];
    const looksNoise = (l: string) => {
      if (/^[{[]/.test(l)) return true;
      if (/"\$type"|urn:li:|trackingId/i.test(l)) return true;
      return false;
    };
    const filterLines = (arr: string[]) => {
      const out: string[] = [];
      const seen = new Set<string>();
      for (const l of arr) {
        if (STOP.some((p) => p.test(l))) break;
        if (NOISE.some((p) => p.test(l))) continue;
        if (looksNoise(l)) continue;
        const k = l.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
        if (!k || seen.has(k)) continue;
        seen.add(k);
        out.push(l);
      }
      return out;
    };

    // Intro — modern selectors first, <title> as the stable fallback
    // ("(N) Full Name - Headline | LinkedIn").
    let titleName = clean((document.title || "").replace(/^\(\d+\+?\)\s*/, "").replace(/\s*\|\s*LinkedIn.*$/i, ""));
    let titleHeadline: string | null = null;
    const dash = titleName.indexOf(" - ");
    if (dash >= 0) {
      titleHeadline = clean(titleName.slice(dash + 3)) || null;
      titleName = clean(titleName.slice(0, dash));
    }
    const name =
      getText("main h1") || getText("h1.text-heading-xlarge") || getText("h1") || (titleName || null);
    const headline =
      getText(".text-body-medium.break-words") ||
      getText(".pv-text-details__left-panel .text-body-medium") ||
      titleHeadline;
    const location =
      getText(".pv-text-details__left-panel .text-body-small.inline.t-black--light.break-words") ||
      getText(".text-body-small.inline.t-black--light.break-words") ||
      getText(".pv-text-details__left-panel .text-body-small");

    // Sections anchored by id div, climbed to their card, de-noised.
    const SECTIONS: [string, string][] = [
      ["about", "About"],
      ["experience", "Experience"],
      ["education", "Education"],
      ["skills", "Skills"],
      ["licenses_certifications", "Licenses & certifications"],
      ["certifications", "Certifications"],
    ];
    const cardOf = (id: string): Element | null => {
      const anchor =
        document.getElementById(id) ||
        document.querySelector(`div[id="${id}"], section[id="${id}"]`);
      if (!anchor) return null;
      return anchor.closest("section, .artdeco-card, div[data-view-name]") || anchor.parentElement;
    };
    const seenCards = new Set<Element>();
    const parts: string[] = [];
    for (const [id, label] of SECTIONS) {
      const card = cardOf(id);
      if (!card || seenCards.has(card)) continue;
      seenCards.add(card);
      const body = filterLines(toLines((card as HTMLElement).innerText || ""));
      if (body.length && body[0].toLowerCase() === label.toLowerCase()) body.shift();
      if (body.length) parts.push(`${label}\n${body.join("\n")}`);
    }

    const intro = [name, headline, location].filter(Boolean).join("\n");
    const structured = parts.length ? `${intro}\n\n${parts.join("\n\n")}` : intro;

    // Fallback: filtered dump of the whole main column (when section anchoring
    // misses entirely on a future layout, this still returns the real content).
    const main = document.querySelector("main, .scaffold-layout__main, #main");
    const fallback = main
      ? `${intro}\n\n${filterLines(toLines((main as HTMLElement).innerText || "")).join("\n")}`
      : structured;

    const profileText =
      parts.length >= 1 && structured.length > 300
        ? structured
        : fallback.length > structured.length
          ? fallback
          : structured;

    return { name, headline, location, profileText };
  });
}

export async function scrapeLinkedInProfile(url: string, page: Page): Promise<LinkedInProfile> {
  assertAllowedProfileUrl(url);
  log.info(`linkedin: scraping ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await randomDelay(1_200, 2_500);

  const profileUrl = page.url();
  // `linkedin_challenge:` prefix is the stable signal the API matches to flag
  // the SearchRun's source as needs-reauth (a challenge often surfaces here, on
  // the profile fetch, not on the search harvest).
  if (profileUrl.includes("/checkpoint") || profileUrl.includes("/captcha")) {
    throw new RateLimitError("linkedin_challenge: checkpoint/captcha detected");
  }
  if (profileUrl.includes("/login") || profileUrl.includes("/authwall")) {
    throw new RateLimitError("linkedin_challenge: auth wall — session expired");
  }

  // 1. Glide down the page so every section lazy-loads.
  await glideProfile(page);

  // 2. Expand truncated text IN PLACE — never navigate. Page-side guard backs out
  //    of any accidental navigation; the box-side check below is the backstop.
  let navigatedAway = false;
  try {
    const result = await expandInPlace(page, MAX_EXPAND_CLICKS, EXPAND_BUDGET_MS);
    navigatedAway = result.navigatedAway;
    log.info(`linkedin: expanded ${result.clicked} section(s) in place${navigatedAway ? " (backed out of a navigation)" : ""}`);
  } catch (err) {
    // A full-page navigation destroys the evaluate context → it rejects here.
    log.warn(`linkedin: expand step aborted (${err instanceof Error ? err.message : String(err)})`);
    navigatedAway = page.url() !== profileUrl;
  }
  // Box-side nav-guard: if anything moved us off the profile, get back on it
  // before extracting (and never follow it deeper).
  if (navigatedAway || page.url() !== profileUrl) {
    try {
      await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
      await randomDelay(800, 1_600);
    } catch { /* extract from wherever we are rather than failing the whole job */ }
  }

  await randomDelay(500, 1_200);

  // 3. Extract structured, de-noised text.
  const extracted = await extractProfile(page);

  if (!extracted.profileText || extracted.profileText.length < 100) {
    throw new Error(
      `LinkedIn profile text too short (${extracted.profileText?.length ?? 0} chars) — may be private or a changed layout`,
    );
  }

  return {
    profileText: extracted.profileText,
    name: extracted.name,
    headline: extracted.headline,
    location: extracted.location,
    linkedinUrl: url,
  };
}
