/**
 * RecruitMe Scraper Worker — main entry point.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * FOR AI HANDOFF — READ THIS FIRST
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * WHAT THIS IS:
 *   A standalone Node.js process that runs on a Raspberry Pi (4G carrier IP)
 *   or Fly.io (residential proxy). It polls the RecruitMe Railway app for
 *   pending ScrapeJob rows, scrapes the target URLs, and posts results back.
 *
 * HOW IT CONNECTS TO RAILWAY:
 *   - RAILWAY_API_URL: the Railway app URL (e.g. https://recruitme.up.railway.app)
 *   - SCRAPER_API_KEY: a Bearer API key created in RecruitMe (POST /api/v1/keys)
 *   - The worker polls GET /api/scraper/jobs every POLL_INTERVAL_MS (default 15s)
 *   - Results are submitted via PATCH /api/scraper/jobs/{id}
 *
 * HOW JOBS GET CREATED (on Railway):
 *   - When search finds a LinkedIn URL with only snippet data (no profileText),
 *     src/app/api/jobs/[id]/search/route.ts calls enqueueScrapeJob()
 *   - SCRAPER_ENABLED=true must be set in Railway env vars for this to happen
 *   - Jobs can also be created manually via POST /api/scraper/jobs (session auth)
 *
 * HOW RESULTS FLOW BACK:
 *   - Worker posts result to PATCH /api/scraper/jobs/{id}
 *   - Railway's completeScrapeJob() (src/lib/scrape-queue.ts) writes profileText
 *     to the Candidate row and triggers background AI scoring
 *   - Same pipeline as browser extension import (saveCapturedProfileFast +
 *     applyAiEnrichmentInBackground in linkedin-capture.ts)
 *
 * IP LAYER:
 *   - Pi: 4G modem provides carrier IP automatically — no proxy config needed
 *   - Fly.io: set HTTP_PROXY to residential proxy endpoint in .env
 *   - Playwright picks up HTTP_PROXY automatically
 *
 * SESSIONS:
 *   - Sessions are AES-256-GCM encrypted, stored in ./sessions/
 *   - session-manager.ts handles auto-login and re-auth on expiry
 *   - Credentials stay in .env on the device — never sent to Railway
 *
 * RATE LIMITING:
 *   - LINKEDIN_HOURLY_CAP (default: 8) — profiles per hour
 *   - SEEK_HOURLY_CAP (default: 15)
 *   - If a RateLimitError is thrown, the worker pauses 2–4 hours before retrying
 *   - The humanizer adds realistic delays between every action
 *
 * SETUP STEPS FOR A NEW PI:
 *   1. Install Node.js 20+: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
 *   2. sudo apt install nodejs chromium-browser
 *   3. cd /path/to/RecruitMe/scraper-worker
 *   4. cp .env.example .env && nano .env   (fill in credentials + API key)
 *   5. npm install && npx playwright install chromium
 *   6. npm run build
 *   7. npm start   (or: pm2 start dist/index.js --name scraper-worker)
 *   8. Set SCRAPER_ENABLED=true in Railway env vars
 *   9. Create a ScrapeJob manually to test: POST /api/scraper/jobs
 *
 * ════════════════════════════════════════════════════════════════════════════════
 */

import { config } from "dotenv";
config(); // load .env from cwd

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { ensureSession, type Platform } from "./session-manager";
import { randomViewport, randomDelay } from "./humanizer";
import { RateLimitError, LoginRequiredError, withRetry } from "./util/retry";
import { scrapeLinkedInProfile } from "./scrapers/linkedin";
import { searchSEEKCandidates, getSEEKCandidateProfile } from "./scrapers/seek";
import { searchJobAdderCandidates, getJobAdderCandidate } from "./scrapers/jobadder";

// ── Config ────────────────────────────────────────────────────────────────────

const RAILWAY_API_URL  = process.env.RAILWAY_API_URL?.replace(/\/$/, "");
const SCRAPER_API_KEY  = process.env.SCRAPER_API_KEY;
const WORKER_ID        = process.env.WORKER_ID ?? `worker-${Date.now()}`;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? "15000", 10);

if (!RAILWAY_API_URL) throw new Error("RAILWAY_API_URL is required in .env");
if (!SCRAPER_API_KEY) throw new Error("SCRAPER_API_KEY is required in .env");

// ── Types (mirrors ScrapeJob schema) ─────────────────────────────────────────

interface ScrapeJobInput {
  url?:         string;
  query?:       string;
  location?:    string;
  count?:       number;
  jobId?:       string;
  candidateId?: string;
}

interface PendingJob {
  id:          string;
  platform:    string;
  jobType:     string;
  input:       ScrapeJobInput;
  retryCount:  number;
}

// ── Railway API helpers ───────────────────────────────────────────────────────

const headers = {
  Authorization: `Bearer ${SCRAPER_API_KEY}`,
  "Content-Type": "application/json",
};

async function pollPendingJobs(): Promise<PendingJob[]> {
  const res = await fetch(
    `${RAILWAY_API_URL}/api/scraper/jobs?workerId=${encodeURIComponent(WORKER_ID)}`,
    { headers },
  );
  if (!res.ok) {
    throw new Error(`Poll failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json() as { jobs: PendingJob[] };
  return data.jobs ?? [];
}

async function submitResult(
  jobId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: any,
): Promise<void> {
  const res = await fetch(`${RAILWAY_API_URL}/api/scraper/jobs/${jobId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ status: "done", result, workerId: WORKER_ID }),
  });
  if (!res.ok) {
    throw new Error(`Submit failed: ${res.status} ${await res.text()}`);
  }
}

async function submitError(jobId: string, error: string): Promise<void> {
  await fetch(`${RAILWAY_API_URL}/api/scraper/jobs/${jobId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ status: "error", error, workerId: WORKER_ID }),
  });
}

// ── Job processor ─────────────────────────────────────────────────────────────

async function processJob(job: PendingJob, page: Page, context: BrowserContext): Promise<void> {
  const { id, platform, jobType, input } = job;
  console.log(`[worker] Processing job ${id}: ${platform}/${jobType}`);

  // Ensure the session for this platform is valid
  await ensureSession(platform as Platform, context, page);

  switch (`${platform}:${jobType}`) {
    case "linkedin:profile": {
      if (!input.url) throw new Error("linkedin:profile requires input.url");
      const result = await scrapeLinkedInProfile(input.url, page);
      await submitResult(id, result);
      break;
    }

    case "seek:search": {
      const results = await searchSEEKCandidates(
        input.query ?? "",
        input.location ?? "New Zealand",
        input.count ?? 20,
        page,
      );
      await submitResult(id, { candidates: results });
      break;
    }

    case "seek:profile": {
      if (!input.url) throw new Error("seek:profile requires input.url");
      const result = await getSEEKCandidateProfile(input.url, page);
      await submitResult(id, result);
      break;
    }

    case "jobadder:search": {
      const results = await searchJobAdderCandidates(
        input.query ?? "",
        input.location ?? "",
        input.count ?? 20,
        page,
      );
      await submitResult(id, { candidates: results });
      break;
    }

    case "jobadder:profile": {
      if (!input.url) throw new Error("jobadder:profile requires input.url or candidateId");
      const candidateId = input.url.split("/").pop() ?? input.url;
      const result = await getJobAdderCandidate(candidateId, page);
      if (!result) throw new Error(`JobAdder candidate not found: ${candidateId}`);
      await submitResult(id, result);
      break;
    }

    default:
      throw new Error(`Unknown job type: ${platform}:${jobType}`);
  }

  console.log(`[worker] Job ${id} complete`);
}

// ── Rate-limit pause tracker ──────────────────────────────────────────────────

const rateLimitPause: Map<string, number> = new Map();

function isRateLimited(platform: string): boolean {
  const until = rateLimitPause.get(platform);
  return until !== undefined && Date.now() < until;
}

function setRateLimitPause(platform: string): void {
  const pauseMs = (2 + Math.random() * 2) * 60 * 60 * 1000; // 2–4 hours
  const until = Date.now() + pauseMs;
  rateLimitPause.set(platform, until);
  const resumeAt = new Date(until).toLocaleTimeString();
  console.warn(`[worker] Rate limit on ${platform} — pausing until ${resumeAt}`);
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`[worker] Starting RecruitMe scraper worker (id: ${WORKER_ID})`);
  console.log(`[worker] Railway: ${RAILWAY_API_URL}`);
  console.log(`[worker] Poll interval: ${POLL_INTERVAL_MS}ms`);

  const proxy = process.env.HTTP_PROXY;
  const launchOptions = proxy
    ? { proxy: { server: proxy }, headless: true }
    : { headless: true };

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  // Browser restart counter — restart every 50 jobs to clear memory leaks
  let jobsProcessed = 0;
  const RESTART_EVERY = 50;

  async function initBrowser(): Promise<void> {
    if (browser) await browser.close().catch(() => {});

    browser = await chromium.launch(launchOptions);
    const viewport = randomViewport();
    context = await browser.newContext({
      viewport,
      userAgent: mobileUserAgent(),
      locale: "en-NZ",
      timezoneId: "Pacific/Auckland",
    });
    page = await context.newPage();
    console.log(`[worker] Browser launched (${viewport.width}x${viewport.height})`);
  }

  await initBrowser();

  while (true) {
    try {
      const jobs = await withRetry(() => pollPendingJobs(), {
        maxAttempts: 3,
        label: "poll",
      });

      if (jobs.length === 0) {
        await randomDelay(POLL_INTERVAL_MS, POLL_INTERVAL_MS + 5000);
        continue;
      }

      console.log(`[worker] Claimed ${jobs.length} job(s)`);

      for (const job of jobs) {
        if (isRateLimited(job.platform)) {
          console.log(`[worker] Skipping ${job.id} — ${job.platform} is rate-limited`);
          await submitError(job.id, `Rate limited on ${job.platform} — will retry when pause lifts`);
          continue;
        }

        try {
          await withRetry(
            () => processJob(job, page!, context!),
            { maxAttempts: 2, label: `job-${job.id}` },
          );
        } catch (err) {
          if (err instanceof RateLimitError) {
            setRateLimitPause(job.platform);
            await submitError(job.id, err.message);
          } else if (err instanceof LoginRequiredError) {
            console.warn(`[worker] Login required for ${job.platform} — will re-auth next job`);
            await submitError(job.id, err.message);
            // Force re-auth on next job by invalidating in-memory session state
          } else {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[worker] Job ${job.id} failed:`, msg);
            await submitError(job.id, msg);
          }
        }

        jobsProcessed++;
        if (jobsProcessed % RESTART_EVERY === 0) {
          console.log(`[worker] Restarting browser after ${RESTART_EVERY} jobs...`);
          await initBrowser();
        }

        // Natural inter-job pause
        await randomDelay(3000, 8000);
      }

    } catch (err) {
      console.error("[worker] Poll error:", err instanceof Error ? err.message : err);
      await randomDelay(30000, 60000); // back off on poll failure
    }
  }
}

function mobileUserAgent(): string {
  const agents = [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Linux; Android 13; Samsung SM-S901B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36",
  ];
  return agents[Math.floor(Math.random() * agents.length)];
}

main().catch((err) => {
  console.error("[worker] Fatal error:", err);
  process.exit(1);
});
