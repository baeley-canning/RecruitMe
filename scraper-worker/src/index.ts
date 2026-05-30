/**
 * RecruitMe scraper worker — main poll loop.
 *
 * Runs on local hardware (your laptop, mini PC, etc.) with a
 * residential/carrier IP so LinkedIn and SEEK don't block it.
 *
 * Setup:
 *   cp .env.example .env
 *   # fill in credentials
 *   npm install
 *   npx patchright install chromium
 *   npm run dev          # dev mode (tsx, no build step)
 *   # or: npm run build && npm start
 */

import { chromium } from "patchright";
import { randomDelay, randomViewport, DESKTOP_USER_AGENT } from "./humanizer.js";
import { ensureSession, openContextWithSavedSession } from "./session-manager.js";
import { scrapeLinkedInProfile, RateLimitError } from "./scrapers/linkedin.js";
import { scrapeSeekProfile } from "./scrapers/seek.js";
import { scrapeLinkedInSearch } from "./scrapers/linkedin-search.js";
import { scrapeSeekSearch } from "./scrapers/seek-search.js";
import { scrapeJobAdderList } from "./scrapers/jobadder-list.js";
import { scrapeJobAdderProfile } from "./scrapers/jobadder-profile.js";
import { closeArchive } from "./archive.js";
import { log } from "./util/log.js";

const RAILWAY_URL = (process.env.RAILWAY_API_URL ?? "").replace(/\/$/, "");
const SCRAPER_SECRET = process.env.SCRAPER_SECRET ?? "";
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? "15000", 10);

// Phase B kill-switch (LinkedIn search discovery).
const DISCOVERY_ENABLED = (process.env.SCRAPER_DISCOVERY_ENABLED ?? "").toLowerCase() === "true";
const DAILY_SEARCH_CAP = parseInt(process.env.SCRAPER_DAILY_SEARCH_CAP ?? "10", 10);
let searchCountToday = 0;
let searchCountDay = isoDay(new Date());

// Phase D kill-switch (JobAdder scrape — independent of LinkedIn discovery so
// they can be toggled separately). Daily cap is a guardrail, not a wall —
// JobAdder is your own ATS so the risk profile is materially lower than
// LinkedIn; crank this up after we see day one runs cleanly.
const JOBADDER_ENABLED = (process.env.SCRAPER_JOBADDER_ENABLED ?? "").toLowerCase() === "true";
const JOBADDER_DAILY_CAP = parseInt(process.env.SCRAPER_JOBADDER_DAILY_CAP ?? "2000", 10);
const JOBADDER_DELAY_MIN_MS = parseInt(process.env.SCRAPER_JOBADDER_DELAY_MIN_MS ?? "1000", 10);
const JOBADDER_DELAY_MAX_MS = parseInt(process.env.SCRAPER_JOBADDER_DELAY_MAX_MS ?? "3000", 10);
let jobadderCountToday = 0;
let jobadderCountDay = isoDay(new Date());

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function rolloverDailySearchCounter(): void {
  const today = isoDay(new Date());
  if (today !== searchCountDay) {
    searchCountDay = today;
    searchCountToday = 0;
  }
}

function rolloverDailyJobAdderCounter(): void {
  const today = isoDay(new Date());
  if (today !== jobadderCountDay) {
    jobadderCountDay = today;
    jobadderCountToday = 0;
  }
}

if (!RAILWAY_URL) {
  console.error("RAILWAY_API_URL is required. Copy .env.example to .env and fill it in.");
  process.exit(1);
}
if (!SCRAPER_SECRET) {
  console.error("SCRAPER_SECRET is required.");
  process.exit(1);
}

interface ScrapeJob {
  id: string;
  orgId: string;
  platform: "linkedin" | "seek" | "jobadder";
  kind: "profile" | "search";
  /** For kind="profile": the URL to scrape. Null for search jobs. */
  profileUrl: string | null;
  /** For kind="search": the boolean query to run. Null for profile jobs. */
  searchQuery: string | null;
  /** Phase K — durable SearchRun this job belongs to (null for background). */
  searchRunId: string | null;
  /** Run's location filter (e.g. "Wellington"), enriched from the SearchRun on
   *  claim. SEEK uses it to scope the search; null = nation-wide. */
  searchLocation?: string | null;
  /** Queue priority (0 = background flywheel, 100 = live recruiter search).
   *  Children of a live search inherit the parent's priority so they jump
   *  the queue instead of landing at 0 behind background work. */
  priority: number;
  retryCount: number;
}

// Per-run fan-out cap (Phase K fairness): a single live search enqueues at
// most this many priority-100 profile children, so a broad query can't
// monopolise the single-Chromium worker and starve background discovery.
const LIVE_SEARCH_FANOUT_CAP = 25;

async function pollJobs(): Promise<ScrapeJob[]> {
  const res = await fetch(`${RAILWAY_URL}/api/scraper/jobs`, {
    headers: { "x-scraper-secret": SCRAPER_SECRET },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "(no body)");
    throw new Error(`Poll failed: ${res.status} ${text}`);
  }
  const data = await res.json() as { jobs: ScrapeJob[] };
  return data.jobs ?? [];
}

async function postResult(
  jobId: string,
  payload:
    | { status: "completed"; result: object }
    | { status: "failed"; error: string },
): Promise<void> {
  const res = await fetch(`${RAILWAY_URL}/api/scraper/jobs/${jobId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "x-scraper-secret": SCRAPER_SECRET,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "(no body)");
    log.warn(`postResult failed for job ${jobId}: ${res.status} ${text}`);
  }
}

// Hard wall-clock guard for a single browser operation. Patchright's
// page.evaluate / scroll can hang indefinitely when a results page never
// settles (observed: a live LinkedIn search wedged the worker for >5 min with
// no error). processJob runs inside the single while(true) loop, so one hung
// harvest freezes ALL scraping. Racing the op against a timer lets us fail the
// job and free the worker instead of dead-locking the queue.
class WedgeTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = "WedgeTimeoutError";
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new WedgeTimeoutError(label, ms)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

// A harvest is bounded in design (~30s nav + ~16s human pauses + scroll), so
// anything past ~2 min means the page wedged. Fail fast rather than hang.
const HARVEST_TIMEOUT_MS = 120_000;
// A single profile scrape is ~10-30s in practice; 90s is generous headroom.
// Past that the page (or patchright) has wedged — fail the job, free the loop.
const PROFILE_TIMEOUT_MS = 90_000;

// Enqueue a follow-up profile scrape (used after a search-job harvests URLs).
// Fire-and-forget at the call site — failures are logged but never throw.
async function postNewProfileJob(args: {
  orgId: string;
  platform: "linkedin" | "seek" | "jobadder";
  profileUrl: string;
  /** Phase K — propagate the SearchRun so the ingested profile attaches to it. */
  searchRunId?: string | null;
  /** Inherit the parent search's queue priority so live-search children jump
   *  the queue ahead of background flywheel work (default 0 = background). */
  priority?: number;
}): Promise<void> {
  try {
    const res = await fetch(`${RAILWAY_URL}/api/scraper/jobs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-scraper-secret": SCRAPER_SECRET,
      },
      body: JSON.stringify({
        orgId: args.orgId,
        platform: args.platform,
        kind: "profile",
        profileUrl: args.profileUrl,
        searchRunId: args.searchRunId ?? null,
        priority: args.priority ?? 0,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok && res.status !== 201) {
      const text = await res.text().catch(() => "(no body)");
      log.warn(`postNewProfileJob failed: ${res.status} ${text}`);
    }
  } catch (err) {
    log.warn(`postNewProfileJob error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function processJob(
  job: ScrapeJob,
  page: import("patchright").Page,
  context: import("patchright").BrowserContext,
  browser: import("patchright").Browser,
): Promise<void> {
  log.info(`processing job ${job.id} — ${job.platform} — ${job.kind} — ${job.profileUrl ?? job.searchQuery ?? "(no target)"}`);

  try {
    // --- Search jobs ---------------------------------------------------------
    if (job.kind === "search") {
      // LinkedIn search discovery (Phase B).
      if (job.platform === "linkedin") {
        if (!DISCOVERY_ENABLED) {
          await postResult(job.id, {
            status: "failed",
            error: "LinkedIn discovery not enabled (set SCRAPER_DISCOVERY_ENABLED=true).",
          });
          return;
        }
        rolloverDailySearchCounter();
        if (searchCountToday >= DAILY_SEARCH_CAP) {
          await postResult(job.id, {
            status: "failed",
            error: `Daily LinkedIn search cap (${DAILY_SEARCH_CAP}) reached for ${searchCountDay}.`,
          });
          return;
        }
        if (!job.searchQuery) {
          await postResult(job.id, { status: "failed", error: "LinkedIn search job missing searchQuery" });
          return;
        }
        await ensureSession("linkedin", context, page);
        const harvest = await withTimeout(
          scrapeLinkedInSearch(job.searchQuery, page),
          HARVEST_TIMEOUT_MS,
          "linkedin-search",
        );
        searchCountToday += 1;
        // Phase K: POST profile children BEFORE settling the search job. Cap
        // fan-out so a broad live search can't starve background work — but
        // ALL harvested cards are reported (result.cards) so every result row
        // shows immediately with its name/headline/location; the capped subset
        // is what we deep-scrape to enrich into the library (free for LinkedIn).
        const liUrls = harvest.urls.slice(0, LIVE_SEARCH_FANOUT_CAP);
        for (const url of liUrls) {
          // Inherit the search's priority: children of a priority-100 live
          // recruiter search must also be 100 so they jump the queue instead
          // of landing at 0 behind background flywheel work.
          await postNewProfileJob({ orgId: job.orgId, platform: "linkedin", profileUrl: url, searchRunId: job.searchRunId, priority: job.priority });
          await randomDelay(150, 350);
        }
        await postResult(job.id, { status: "completed", result: { urls: harvest.urls, cards: harvest.cards } });
        log.info(`job ${job.id} linkedin-search completed — ${harvest.cards.length} cards, ${liUrls.length} dispatched for enrichment (today ${searchCountToday}/${DAILY_SEARCH_CAP})`);
        return;
      }

      // SEEK Talent Search discovery (Phase F). Unlike LinkedIn, we do NOT
      // auto-dispatch profile children: opening a SEEK Talent Search profile
      // can consume the account's (paid) search credits, so we only HARVEST
      // the result cards (name/headline/location/profile URL — no credit cost)
      // and show them as results. Deep enrichment of a specific candidate is a
      // deliberate, credit-aware action, not an automatic fan-out.
      if (job.platform === "seek") {
        if (!DISCOVERY_ENABLED) {
          await postResult(job.id, {
            status: "failed",
            error: "SEEK discovery not enabled (set SCRAPER_DISCOVERY_ENABLED=true).",
          });
          return;
        }
        rolloverDailySearchCounter();
        if (searchCountToday >= DAILY_SEARCH_CAP) {
          await postResult(job.id, {
            status: "failed",
            error: `Daily search cap (${DAILY_SEARCH_CAP}) reached for ${searchCountDay}.`,
          });
          return;
        }
        if (!job.searchQuery) {
          await postResult(job.id, { status: "failed", error: "SEEK search job missing searchQuery" });
          return;
        }
        await ensureSession("seek", context, page);
        const harvest = await withTimeout(
          scrapeSeekSearch(job.searchQuery, page, job.searchLocation ?? null),
          HARVEST_TIMEOUT_MS,
          "seek-search",
        );
        searchCountToday += 1;
        // Report all harvested cards as results; do NOT dispatch profile
        // children (credit safety — see branch comment above).
        await postResult(job.id, { status: "completed", result: { urls: harvest.urls, cards: harvest.cards } });
        log.info(`job ${job.id} seek-search completed — ${harvest.cards.length} cards harvested, 0 dispatched (credit-safe) (today ${searchCountToday}/${DAILY_SEARCH_CAP})`);
        return;
      }

      // JobAdder library walk (Phase D). No query — always "walk the whole
      // library". Each harvested URL becomes a kind="profile" platform="jobadder"
      // job, which the worker picks up on its next poll and scrapes into the
      // archive. JobAdder needs its OWN context built with Playwright's
      // storageState (Auth0 cross-origin localStorage tokens) — addCookies
      // alone can't restore them.
      if (job.platform === "jobadder") {
        if (!JOBADDER_ENABLED) {
          await postResult(job.id, {
            status: "failed",
            error: "JobAdder scraping not enabled (set SCRAPER_JOBADDER_ENABLED=true).",
          });
          return;
        }
        const { context: jaCtx, page: jaPage } = await openContextWithSavedSession(browser, "jobadder");
        try {
          const harvest = await withTimeout(
            scrapeJobAdderList(jaPage),
            HARVEST_TIMEOUT_MS,
            "jobadder-list",
          );
          // Post profile children BEFORE settling the search job — consistent
          // with the LinkedIn/SEEK branches. JobAdder walks carry no searchRunId
          // today (background archive, not a live durable search), so this
          // ordering is currently inert, but matching the pattern avoids a
          // premature-settle race if JobAdder is ever wired to a SearchRun.
          for (const url of harvest.urls) {
            await postNewProfileJob({ orgId: job.orgId, platform: "jobadder", profileUrl: url, searchRunId: job.searchRunId });
            await randomDelay(150, 350);
          }
          await postResult(job.id, {
            status: "completed",
            result: { urls: harvest.urls },
          });
          log.info(`job ${job.id} jobadder-list completed — ${harvest.urls.length} candidate URLs`);
        } finally {
          await jaCtx.close().catch(() => {});
        }
        return;
      }

      await postResult(job.id, {
        status: "failed",
        error: `Search jobs not supported on platform: ${job.platform}`,
      });
      return;
    }

    // --- Profile jobs (existing behaviour) ----------------------------------
    if (!job.profileUrl) {
      await postResult(job.id, { status: "failed", error: "Profile job missing profileUrl" });
      return;
    }

    if (job.platform === "linkedin") {
      await ensureSession("linkedin", context, page);
      const profile = await withTimeout(
        scrapeLinkedInProfile(job.profileUrl, page),
        PROFILE_TIMEOUT_MS,
        "linkedin-profile",
      );
      await postResult(job.id, { status: "completed", result: profile });
      log.info(`job ${job.id} completed — ${profile.profileText.length} chars — name="${profile.name ?? "(none)"}"`);
    } else if (job.platform === "seek") {
      await ensureSession("seek", context, page);
      const profile = await withTimeout(
        scrapeSeekProfile(job.profileUrl, page),
        PROFILE_TIMEOUT_MS,
        "seek-profile",
      );
      await postResult(job.id, { status: "completed", result: profile });
      log.info(`job ${job.id} completed — ${profile.profileText.length} chars`);
    } else if (job.platform === "jobadder") {
      if (!JOBADDER_ENABLED) {
        await postResult(job.id, {
          status: "failed",
          error: "JobAdder scraping not enabled (set SCRAPER_JOBADDER_ENABLED=true).",
        });
        return;
      }
      rolloverDailyJobAdderCounter();
      if (jobadderCountToday >= JOBADDER_DAILY_CAP) {
        await postResult(job.id, {
          status: "failed",
          error: `Daily JobAdder profile cap (${JOBADDER_DAILY_CAP}) reached for ${jobadderCountDay}.`,
        });
        return;
      }
      // Fresh context per scrape — Auth0 storageState only restores correctly
      // this way. Slight per-scrape overhead is well within budget.
      const { context: jaCtx, page: jaPage } = await openContextWithSavedSession(browser, "jobadder");
      let result;
      try {
        result = await withTimeout(
          scrapeJobAdderProfile(job.profileUrl, jaPage, jaCtx),
          PROFILE_TIMEOUT_MS,
          "jobadder-profile",
        );
      } finally {
        await jaCtx.close().catch(() => {});
      }
      jobadderCountToday += 1;
      // The archive holds the full data; the ScrapeJob result is just an
      // audit pointer (id + counts) — keeps ScrapeJob rows small.
      await postResult(job.id, {
        status: "completed",
        result: {
          jobAdderId: result.jobAdderId,
          fileCount: result.fileCount,
          noteCount: result.noteCount,
        },
      });
      log.info(`job ${job.id} jobadder-profile completed (today ${jobadderCountToday}/${JOBADDER_DAILY_CAP})`);
      // Inter-candidate pause uses JobAdder-specific delay knobs so we can
      // tune pacing without touching LinkedIn/SEEK.
      await randomDelay(JOBADDER_DELAY_MIN_MS, JOBADDER_DELAY_MAX_MS);
    } else {
      await postResult(job.id, { status: "failed", error: `Unknown platform: ${job.platform}` });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`job ${job.id} failed:`, message);

    // An AUTH CHALLENGE (session expired / login wall — message carries the
    // "_challenge:" prefix) is NOT a rate limit. It will keep failing until a
    // human re-logs in, so it must NOT trigger the multi-hour global backoff
    // (a dead SEEK session was freezing ALL platforms, incl. LinkedIn, for
    // 2-4h) and must NOT be retried. Fail the job, let the API flag the source
    // needs-reauth, and CONTINUE to the next job immediately.
    const isAuthChallenge = message.includes("_challenge:");

    if (err instanceof RateLimitError && !isAuthChallenge) {
      // Genuine throttle/checkpoint — back off this worker for 2-4 hours.
      const backoffMs = 2 * 60 * 60 * 1000 + Math.floor(Math.random() * 2 * 60 * 60 * 1000);
      log.warn(`rate limit hit — backing off ${Math.round(backoffMs / 60000)}min`);
      await postResult(job.id, { status: "failed", error: message });
      await randomDelay(backoffMs, backoffMs + 60_000);
      return;
    }

    if (isAuthChallenge) {
      log.warn(`auth challenge (${message}) — failing job, no backoff/retry; needs manual re-login`);
    }
    await postResult(job.id, { status: "failed", error: message });

    // A wedged page op times out but the underlying operation keeps running on
    // the shared page — reusing it for the next job risks a cascade of
    // timeouts. Re-throw so the poll loop can recreate the page before
    // continuing. (Already recorded the failure above.)
    if (err instanceof WedgeTimeoutError) throw err;
  }
}

async function main() {
  log.info(`scraper worker starting — polling ${RAILWAY_URL} every ${POLL_INTERVAL_MS}ms`);

  const viewport = randomViewport();
  const proxyOpts = process.env.HTTP_PROXY
    ? { server: process.env.HTTP_PROXY }
    : undefined;

  // ONE browser for the whole process lifetime; the single page is reused for
  // every scrape. Session persistence is via encrypted .enc files
  // (session-manager.ts), loaded by ensureSession on each job.
  const browser = await chromium.launch({ headless: process.env.HEADLESS !== "false" });
  const context = await browser.newContext({
    viewport,
    userAgent: DESKTOP_USER_AGENT,
    ...(proxyOpts ? { proxy: proxyOpts } : {}),
  });
  let page = await context.newPage();

  log.info(`browser ready — viewport ${viewport.width}×${viewport.height}`);

  // Graceful shutdown.
  const shutdown = async () => {
    log.info("shutting down...");
    await browser.close().catch(() => {});
    await closeArchive().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Phase K: drive the SearchRun safety-net sweep from the poll loop. There's
  // no cron on the box, so the worker is the only always-on process that can
  // reclaim zombie jobs + settle stuck runs. Every SWEEP_EVERY_N polls.
  const SWEEP_EVERY_N = 8;
  let pollCount = 0;

  while (true) {
    try {
      const jobs = await pollJobs();

      if (jobs.length === 0) {
        log.debug("no pending jobs");
      } else {
        log.info(`claimed ${jobs.length} job(s)`);
        for (const job of jobs) {
          try {
            await processJob(job, page, context, browser);
          } catch (err) {
            // Only WedgeTimeoutError propagates out of processJob (it already
            // recorded the job failure). The shared page is likely poisoned by
            // the still-running wedged op, so recreate it before the next job.
            if (err instanceof WedgeTimeoutError) {
              log.warn(`page wedged (${err.message}) — recreating page`);
              await page.close().catch(() => {});
              page = await context.newPage();
            } else {
              throw err;
            }
          }
          // Human-like pause between jobs.
          await randomDelay(2000, 6000);
        }
      }

      pollCount += 1;
      if (pollCount % SWEEP_EVERY_N === 0) {
        await runSearchRunSweep();
      }
    } catch (err) {
      log.error("poll error:", err instanceof Error ? err.message : String(err));
    }

    // Wait before next poll + small jitter so the timing isn't perfectly regular.
    await randomDelay(POLL_INTERVAL_MS, POLL_INTERVAL_MS + 5000);
  }
}

// Fire the durable-search sweep endpoint. Fire-and-forget; logged, never throws.
async function runSearchRunSweep(): Promise<void> {
  try {
    const res = await fetch(`${RAILWAY_URL}/api/admin/search-runs/sweep`, {
      method: "POST",
      headers: { "x-scraper-secret": SCRAPER_SECRET },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const body = await res.json().catch(() => null);
      if (body && (body.reclaimed || body.swept)) {
        log.info(`search-run sweep: reclaimed=${body.reclaimed} swept=${body.swept}`);
      }
    }
  } catch (err) {
    log.warn(`search-run sweep failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

main().catch((err) => {
  log.error("fatal:", err);
  process.exit(1);
});
