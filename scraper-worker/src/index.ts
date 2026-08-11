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
import { randomDelay } from "./humanizer.js";
import { msUntilNextJobAllowed } from "./job-pacing.js";
import { ensureSession, openContextWithSavedSession, discardPlatformSession } from "./session-manager.js";
import { scrapeLinkedInProfile, RateLimitError } from "./scrapers/linkedin.js";
import { scrapeSeekProfile } from "./scrapers/seek.js";
import { scrapeLinkedInSearch } from "./scrapers/linkedin-search.js";
import { scrapeSeekSearch } from "./scrapers/seek-search.js";
import { scrapeJobAdderList } from "./scrapers/jobadder-list.js";
import { scrapeJobAdderProfile } from "./scrapers/jobadder-profile.js";
import { closeArchive } from "./archive.js";
import { log } from "./util/log.js";
import { isAuthChallengeMessage } from "./auth-failure.js";
import { resolveJobTarget } from "./job-routing.js";
import { hostname } from "node:os";

const RAILWAY_URL = (process.env.RAILWAY_API_URL ?? "").replace(/\/$/, "");
const SCRAPER_SECRET = process.env.SCRAPER_SECRET ?? "";
// Per-box org-bound token (the BYO-box customer model). When set, the box
// authenticates with `Authorization: Bearer <token>` and the server LOCKS it to
// the token's org (resolveScraperOrgId) — a customer box can only ever touch
// their own org's data. When unset, the box falls back to the shared
// SCRAPER_SECRET (the platform OPERATOR box, which serves all orgs). Minting:
// `node scripts/create-scraper-token.mjs <label> <orgId>` on the app side.
const SCRAPER_API_TOKEN = (process.env.SCRAPER_API_TOKEN ?? "").trim();
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? "15000", 10);
/**
 * Minimum gap between JOB STARTS, whatever the outcome. Protects the account:
 * a fast-failing job must not let the worker hammer a platform. Override with
 * MIN_JOB_INTERVAL_MS; 0 disables (tests).
 */
const MIN_JOB_INTERVAL_MS = parseInt(process.env.MIN_JOB_INTERVAL_MS ?? "30000", 10);
let lastJobStartedAt = 0;



/** Auth header for every call to the app: prefer the per-org bearer token
 *  (tenant box), else the shared secret (operator box). */
function scraperAuthHeaders(): Record<string, string> {
  return SCRAPER_API_TOKEN
    ? { Authorization: `Bearer ${SCRAPER_API_TOKEN}` }
    : { "x-scraper-secret": SCRAPER_SECRET };
}

// Phase I2 — worker heartbeat. Stable per-box id so the upsert keeps ONE row.
const WORKER_ID = (process.env.BOX_ID || hostname() || "scraper").trim();
const HEARTBEAT_INTERVAL_MS = 60_000;
let hbJobsOk = 0;
let hbJobsFailed = 0;
let hbPollErrors = 0;
let hbLastPollAt: string | null = null;
let hbLastSentAt = 0;

// Phase B kill-switch (LinkedIn search discovery).
const DISCOVERY_ENABLED = (process.env.SCRAPER_DISCOVERY_ENABLED ?? "").toLowerCase() === "true";
const DAILY_SEARCH_CAP = parseInt(process.env.SCRAPER_DAILY_SEARCH_CAP ?? "200", 10);
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
if (!SCRAPER_SECRET && !SCRAPER_API_TOKEN) {
  console.error("Set SCRAPER_API_TOKEN (per-org box) or SCRAPER_SECRET (operator box).");
  process.exit(1);
}

interface ScrapeJob {
  id: string;
  orgId: string;
  platform: "linkedin" | "seek" | "jobadder";
  // "score" retained in the union only so a stray legacy job deserialises;
  // nothing enqueues or processes it (offload removed 2026-07-04).
  kind: "profile" | "search" | "score";
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

// LinkedIn search pagination depth (volume vs detectability). Default 1 =
// first results page only (~10 cards) — the safe, historical behaviour. Raise
// to harvest ~10×N cards per search at the cost of higher detectability (each
// extra &page=N load is the highest-risk move). Clamped 1..10. Pair a higher
// value with a higher SCRAPER_DAILY_SEARCH_CAP and watch for auth challenges.
const SCRAPER_SEARCH_MAX_PAGES = Math.max(1, Math.min(parseInt(process.env.SCRAPER_SEARCH_MAX_PAGES ?? "1", 10) || 1, 10));

async function pollJobs(): Promise<ScrapeJob[]> {
  const res = await fetch(`${RAILWAY_URL}/api/scraper/jobs`, {
    headers: scraperAuthHeaders(),
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
  if (payload.status === "completed") hbJobsOk += 1; else hbJobsFailed += 1;
  // Result delivery is THE contract with Railway: if this PATCH never lands,
  // the job sits 'processing' until the 10-min sweep reclaims it and the
  // recruiter stares at a stuck "processing" pill the whole time (observed
  // live 2026-07-02: the scraper logged a SEEK failure that never reached the
  // DB). Retry transient failures — network errors and 5xx — with backoff; a
  // 4xx is a semantic rejection that retrying can't fix, so log and stop.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${RAILWAY_URL}/api/scraper/jobs/${jobId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...scraperAuthHeaders(),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) return;
      const text = await res.text().catch(() => "(no body)");
      if (res.status < 500) {
        log.warn(`postResult rejected for job ${jobId}: ${res.status} ${text}`);
        return;
      }
      log.warn(`postResult attempt ${attempt}/3 for job ${jobId}: ${res.status} ${text}`);
    } catch (err) {
      log.warn(`postResult attempt ${attempt}/3 for job ${jobId} errored: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (attempt < 3) await randomDelay(2_000 * attempt, 4_000 * attempt);
  }
  log.error(`postResult FAILED after 3 attempts for job ${jobId} — the sweep will reclaim it in ~10min`);
}

/** Fire-and-forget worker heartbeat (Phase I2) — never disrupts the poll loop. */
async function postHeartbeat(detail: string): Promise<void> {
  try {
    await fetch(`${RAILWAY_URL}/api/scraper/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...scraperAuthHeaders() },
      body: JSON.stringify({
        workerId: WORKER_ID,
        lastPollAt: hbLastPollAt,
        jobsOk: hbJobsOk,
        jobsFailed: hbJobsFailed,
        pollErrors: hbPollErrors,
        detail,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // ignore — a failed heartbeat must never affect scraping
  } finally {
    hbLastSentAt = Date.now();
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
        ...scraperAuthHeaders(),
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
  browser: import("patchright").Browser,
): Promise<void> {
  log.info(`processing job ${job.id} — ${job.platform} — ${job.kind} — ${job.profileUrl ?? job.searchQuery ?? "(no target)"}`);

  try {
    // The Llama score-offload (kind="score") path was removed 2026-07-04. A
    // stray legacy score job (there should be none) is failed cleanly instead
    // of processed — it has no URL to scrape and no local model to run.
    if (job.kind === "score") {
      await postResult(job.id, { status: "failed", error: "score offload removed" });
      return;
    }

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
        const page = await ensureSession("linkedin", browser);
        const harvest = await withTimeout(
          scrapeLinkedInSearch(job.searchQuery, page, SCRAPER_SEARCH_MAX_PAGES),
          // Scale the wedge guard with page depth (60s headroom per extra page);
          // default maxPages=1 leaves the 120s budget unchanged.
          HARVEST_TIMEOUT_MS + (SCRAPER_SEARCH_MAX_PAGES - 1) * 60_000,
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
        const page = await ensureSession("seek", browser);
        const harvest = await withTimeout(
          scrapeSeekSearch(job.searchQuery, page, job.searchLocation ?? null),
          HARVEST_TIMEOUT_MS,
          "seek-search",
        );
        searchCountToday += 1;
        // Report all harvested cards as results; do NOT dispatch profile
        // children (credit safety — see branch comment above). locationApplied
        // tells the app SEEK already scoped the search to the requested region,
        // so it must not re-filter cards on their (often unparseable) location.
        await postResult(job.id, { status: "completed", result: { urls: harvest.urls, cards: harvest.cards, locationApplied: harvest.locationApplied } });
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

    // --- Profile jobs -------------------------------------------------------
    // Route by the URL, not by the platform column it arrived in. A merge-key
    // string ("seek:https://…") sitting in the linkedinUrl column once sent 100
    // SEEK URLs to the LinkedIn scraper; each failed in ~4s, which spun this
    // loop ~6x faster than intended and got the owner's account flagged.
    const target = resolveJobTarget({ platform: job.platform, profileUrl: job.profileUrl });
    if (!target.ok) {
      await postResult(job.id, { status: "failed", error: target.error });
      return;
    }
    const { platform: targetPlatform, url: targetUrl } = target;
    if (targetPlatform !== job.platform) {
      log.warn(
        `job ${job.id} was filed as ${job.platform} but its URL is ${targetPlatform} — routing by URL (${targetUrl})`,
      );
    }

    if (targetPlatform === "linkedin") {
      const page = await ensureSession("linkedin", browser);
      const profile = await withTimeout(
        scrapeLinkedInProfile(targetUrl, page),
        PROFILE_TIMEOUT_MS,
        "linkedin-profile",
      );
      await postResult(job.id, { status: "completed", result: profile });
      log.info(`job ${job.id} completed — ${profile.profileText.length} chars — name="${profile.name ?? "(none)"}"`);
    } else if (targetPlatform === "seek") {
      const page = await ensureSession("seek", browser);
      const profile = await withTimeout(
        scrapeSeekProfile(targetUrl, page),
        PROFILE_TIMEOUT_MS,
        "seek-profile",
      );
      await postResult(job.id, { status: "completed", result: profile });
      log.info(`job ${job.id} completed — ${profile.profileText.length} chars`);
    } else if (targetPlatform === "jobadder") {
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
          scrapeJobAdderProfile(targetUrl, jaPage, jaCtx),
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

    // An AUTH CHALLENGE (session expired / login wall — the scrapers raise a
    // "<platform>_challenge:" prefix) is NOT a rate limit. It will keep failing
    // until a human re-logs in, so it must NOT trigger the multi-hour global
    // backoff (a dead SEEK session was freezing ALL platforms for 2-4h) and must
    // NOT be retried. Match the prefix in an ANCHORED way (isAuthChallengeMessage)
    // so arbitrary error text containing "_challenge:" can't false-trigger it.
    const isAuthChallenge = isAuthChallengeMessage(message);

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

  // ONE browser for the whole process lifetime; contexts are PER PLATFORM
  // (session-manager's getPlatformPage), each built fresh from its saved .enc
  // storageState. The old single shared context accumulated init scripts and
  // both platforms' cookies forever — that compounding staleness rotted the
  // SEEK login ~20min after every re-auth (295KB session vs ~46KB healthy).
  const browser = await chromium.launch({ headless: process.env.HEADLESS !== "false" });

  log.info("browser ready — per-platform contexts created on first use");

  // Graceful shutdown.
  const shutdown = async () => {
    log.info("shutting down...");
    await browser.close().catch(() => {});
    await closeArchive().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Phase K: the OPERATOR box drives the SearchRun safety-net sweep from the
  // poll loop (reclaim zombie jobs + settle stuck runs), backing up the Railway
  // in-process sweep timer. A per-org TOKEN box skips it: the sweep endpoint is
  // operator-auth only (shared secret / cron), so a token box would just 401,
  // and platform-wide maintenance isn't a tenant box's job anyway.
  const SWEEP_EVERY_N = 8;
  const DRIVES_SWEEP = !SCRAPER_API_TOKEN;
  let pollCount = 0;

  while (true) {
    try {
      const jobs = await pollJobs();
      hbLastPollAt = new Date().toISOString();

      if (jobs.length === 0) {
        log.debug("no pending jobs");
      } else {
        log.info(`claimed ${jobs.length} job(s)`);
        for (const job of jobs) {
          // Pace by job START, not by the pause after it. A job that fails
          // instantly (bad URL, open circuit) returns in ~4s, so a trailing
          // 2-6s pause let the loop cycle every ~7s — roughly six times the
          // intended rate at the platform. That is how a routing bug turned a
          // paced queue into a burst and got the account flagged. Pacing from
          // the start makes the floor hold no matter how the job ends.
          const waitMs = msUntilNextJobAllowed(lastJobStartedAt, Date.now(), MIN_JOB_INTERVAL_MS);
          if (waitMs > 0) await randomDelay(waitMs, waitMs + 4000);
          lastJobStartedAt = Date.now();
          try {
            await processJob(job, browser);
          } catch (err) {
            // Only WedgeTimeoutError propagates out of processJob (it already
            // recorded the job failure). The platform's context is likely
            // poisoned by the still-running wedged op — discard it so the next
            // job for that platform rebuilds cleanly from the saved session.
            if (err instanceof WedgeTimeoutError) {
              log.warn(`page wedged (${err.message}) — discarding ${job.platform} context`);
              await discardPlatformSession(job.platform);
            } else {
              throw err;
            }
          }
          // Human-like pause between jobs. NOTE: this alone is not enough —
          // see the start-paced floor above. A pause AFTER the work only paces
          // the loop when the work itself is slow.
          await randomDelay(2000, 6000);
        }
      }

      pollCount += 1;
      if (DRIVES_SWEEP && pollCount % SWEEP_EVERY_N === 0) {
        await runSearchRunSweep();
      }
    } catch (err) {
      hbPollErrors += 1;
      log.error("poll error:", err instanceof Error ? err.message : String(err));
    }

    // Heartbeat (throttled) so /api/health + the box-dashboard see real liveness
    // even when the queue is idle. Fire-and-forget — never blocks the loop.
    if (Date.now() - hbLastSentAt >= HEARTBEAT_INTERVAL_MS) {
      void postHeartbeat(hbLastPollAt ? "polling" : "starting");
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
      headers: scraperAuthHeaders(),
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
