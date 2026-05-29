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
import { randomDelay, randomViewport, MOBILE_USER_AGENT } from "./humanizer.js";
import { ensureSession } from "./session-manager.js";
import { scrapeLinkedInProfile, RateLimitError } from "./scrapers/linkedin.js";
import { scrapeSeekProfile } from "./scrapers/seek.js";
import { log } from "./util/log.js";

const RAILWAY_URL = (process.env.RAILWAY_API_URL ?? "").replace(/\/$/, "");
const SCRAPER_SECRET = process.env.SCRAPER_SECRET ?? "";
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? "15000", 10);

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
  profileUrl: string;
  retryCount: number;
}

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

async function processJob(
  job: ScrapeJob,
  page: import("patchright").Page,
  context: import("patchright").BrowserContext,
): Promise<void> {
  log.info(`processing job ${job.id} — ${job.platform} — ${job.profileUrl}`);

  try {
    if (job.platform === "linkedin") {
      await ensureSession("linkedin", context, page);
      const profile = await scrapeLinkedInProfile(job.profileUrl, page);
      await postResult(job.id, { status: "completed", result: profile });
      log.info(`job ${job.id} completed — ${profile.profileText.length} chars`);
    } else if (job.platform === "seek") {
      await ensureSession("seek", context, page);
      const profile = await scrapeSeekProfile(job.profileUrl, page);
      await postResult(job.id, { status: "completed", result: profile });
      log.info(`job ${job.id} completed — ${profile.profileText.length} chars`);
    } else if (job.platform === "jobadder") {
      // JobAdder scraping not yet implemented — fail gracefully.
      await postResult(job.id, { status: "failed", error: "JobAdder scraping not yet implemented" });
    } else {
      await postResult(job.id, { status: "failed", error: `Unknown platform: ${job.platform}` });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`job ${job.id} failed:`, message);

    if (err instanceof RateLimitError) {
      // Back off for 2-4 hours when rate-limited.
      const backoffMs = 2 * 60 * 60 * 1000 + Math.floor(Math.random() * 2 * 60 * 60 * 1000);
      log.warn(`rate limit hit — backing off ${Math.round(backoffMs / 60000)}min`);
      await postResult(job.id, { status: "failed", error: message });
      await randomDelay(backoffMs, backoffMs + 60_000);
      return;
    }

    await postResult(job.id, { status: "failed", error: message });
  }
}

async function main() {
  log.info(`scraper worker starting — polling ${RAILWAY_URL} every ${POLL_INTERVAL_MS}ms`);

  const viewport = randomViewport();
  const proxyOpts = process.env.HTTP_PROXY
    ? { server: process.env.HTTP_PROXY }
    : undefined;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport,
    userAgent: MOBILE_USER_AGENT,
    ...(proxyOpts ? { proxy: proxyOpts } : {}),
  });
  const page = await context.newPage();

  log.info(`browser ready — viewport ${viewport.width}×${viewport.height}`);

  // Graceful shutdown.
  process.on("SIGINT", async () => {
    log.info("shutting down...");
    await browser.close();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    log.info("shutting down...");
    await browser.close();
    process.exit(0);
  });

  while (true) {
    try {
      const jobs = await pollJobs();

      if (jobs.length === 0) {
        log.debug("no pending jobs");
      } else {
        log.info(`claimed ${jobs.length} job(s)`);
        for (const job of jobs) {
          await processJob(job, page, context);
          // Human-like pause between jobs.
          await randomDelay(2000, 6000);
        }
      }
    } catch (err) {
      log.error("poll error:", err instanceof Error ? err.message : String(err));
    }

    // Wait before next poll + small jitter so the timing isn't perfectly regular.
    await randomDelay(POLL_INTERVAL_MS, POLL_INTERVAL_MS + 5000);
  }
}

main().catch((err) => {
  log.error("fatal:", err);
  process.exit(1);
});
