/**
 * JobAdder candidate-list walker. Navigates to /candidates and scrolls/
 * paginates to harvest every candidate's profile URL into a deduped Set.
 *
 * JobAdder's candidate list is lazy-loaded as you scroll (no clear page-N
 * URL), so the strategy is: scroll → wait → harvest visible links → check
 * if the count grew → repeat. Stop when the count is stable across 3
 * consecutive rounds (nothing new appearing) or we hit the safety cap.
 *
 * Pacing: 1.5–3 s pause between scroll passes. A 10 k list takes ~1 hr to
 * walk at this pace — fine because it's a one-time job. The per-candidate
 * scrape that follows is the larger time budget anyway.
 *
 * Abort condition: any navigation off `app.jobadder.com` (e.g. bounced to
 * id.jobadder.com login or /Account/SignIn). Caller fails the job and the
 * operator re-runs `npx tsx login.ts jobadder`.
 */

import type { Page } from "patchright";
import { humanScroll, randomDelay } from "../humanizer.js";
import { log } from "../util/log.js";

export interface JobAdderListHarvest {
  urls: string[];
}

const MAX_SCROLL_ROUNDS = 400; // ~10 k candidates worth of paging, with headroom
const STABLE_ROUNDS_TO_STOP = 3;

export async function scrapeJobAdderList(page: Page): Promise<JobAdderListHarvest> {
  // JobAdder uses regional subdomains (au6, us1, ...). Override base URL via
  // JOBADDER_BASE_URL in the worker .env if your tenant isn't on au6.
  const base = process.env.JOBADDER_BASE_URL ?? "https://au6.jobadder.com";
  log.info(`jobadder-list: starting candidate list walk at ${base}/candidates`);
  await page.goto(`${base}/candidates`, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await randomDelay(2_500, 5_000);

  const landed = page.url();
  if (
    !/\.jobadder\.com/.test(landed) ||
    /\/(SignIn|sign-in|signin|login|sso)/i.test(landed)
  ) {
    throw new Error(
      `JobAdder bounced to ${landed} during list walk — session likely expired, re-run login.ts jobadder`,
    );
  }

  const seen = new Set<string>();
  let stableRounds = 0;
  let lastCount = 0;
  let round = 0;

  while (round < MAX_SCROLL_ROUNDS && stableRounds < STABLE_ROUNDS_TO_STOP) {
    round++;

    const pageHeight = await page.evaluate(() => document.body.scrollHeight);
    await humanScroll(page, pageHeight);
    await randomDelay(1_500, 3_000);

    // Harvest every anchor pointing at /candidates/<id>. Done in the page so
    // we don't ship the whole DOM back.
    const newUrls = await page.evaluate(() => {
      const set = new Set<string>();
      const anchors = Array.from(
        document.querySelectorAll('a[href*="/candidates/"]'),
      ) as HTMLAnchorElement[];
      // Window's current host is whichever jobadder subdomain we landed on
      // (au6.jobadder.com, etc.) — preserve it for the harvested URLs.
      const host = window.location.host;
      for (const a of anchors) {
        try {
          const u = new URL(a.href, window.location.origin);
          if (!u.hostname.endsWith(".jobadder.com")) continue;
          const parts = u.pathname.split("/").filter(Boolean);
          // Expect: ["candidates", "<id>"]; skip /candidates/search etc.
          if (parts[0] !== "candidates" || !parts[1]) continue;
          const id = parts[1];
          if (!/^[A-Za-z0-9_-]{3,}$/.test(id)) continue;
          set.add(`https://${host}/candidates/${id}`);
        } catch {
          /* skip malformed hrefs */
        }
      }
      return Array.from(set);
    });

    for (const u of newUrls) seen.add(u);

    if (seen.size === lastCount) {
      stableRounds++;
    } else {
      stableRounds = 0;
      lastCount = seen.size;
    }

    if (round % 5 === 0 || stableRounds > 0) {
      log.info(
        `jobadder-list: round ${round} — ${seen.size} candidates (${stableRounds === 0 ? "growing" : `stable ${stableRounds}/${STABLE_ROUNDS_TO_STOP}`})`,
      );
    }
  }

  log.info(`jobadder-list: finished — ${seen.size} candidate URLs harvested in ${round} rounds`);
  return { urls: Array.from(seen) };
}
