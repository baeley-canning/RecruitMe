# RecruitMe Scraper Worker — Full Handoff

## What this is

A 24/7 background process that runs on **local hardware** (laptop or mini PC) and
scrapes LinkedIn and SEEK candidate profiles on behalf of the recruiter. It never
stops — one Chromium instance stays open for the entire lifetime of the process,
keeping a persistent logged-in session so it never needs to log in again unless
cookies expire (typically weeks or months).

The process polls the Railway-hosted app every 15 seconds for pending jobs, scrapes
the requested profile, and posts the result back. Railway handles the database and
web app; the scraper handles the IP-sensitive browser work.

---

## Why one persistent Chromium, not one per job

LinkedIn and SEEK detect scrapers by fingerprinting the browser session:

- A fresh browser every request = bot-like pattern = instant block
- One persistent session that navigates between profiles = normal user behaviour

The architecture is:

```
startup -> launch ONE Chromium -> log in to LinkedIn + SEEK (ONCE)
         -> save session to disk
         -> loop forever: poll -> scrape -> post result -> sleep 15s
```

On the next restart, `ensureSession()` loads the saved session from disk and
validates it. If still valid, no login happens. If expired, it logs in once and
saves a fresh session.

**Key file: `scraper-worker/src/session-manager.ts`**

```
ensureSession(platform, context, page)
  -> isSessionValid()  -> navigates to feed/dashboard, checks we're not on /login
  -> (fallback) loadSession() -> restores saved cookies
  -> if not logged in: authenticate() -> types credentials, submits, waits for redirect
```

---

## JobAdder — why we don't scrape it

JobAdder has an **official REST API**. Scraping their web app is unnecessary,
fragile, and violates their terms. The correct approach for JobAdder is:

1. Recruiter grants OAuth access via JobAdder -> we get an access token
2. We call the JobAdder API directly (`GET /candidates/{id}`) -> no browser needed
3. Profile data arrives as structured JSON, cleaner than any scrape

**What to do with JobAdder scrape jobs right now:** mark them failed immediately.
Do NOT attempt to scrape their web app. The API integration is a separate feature.

Already implemented in `scraper-worker/src/index.ts`:
```typescript
} else if (job.platform === "jobadder") {
  await postResult(job.id, { status: "failed", error: "JobAdder scraping not yet implemented" });
}
```

---

## Architecture overview

```
Railway (cloud):
  PostgreSQL -- ScrapeJob table -- pending | processing | completed | failed
  Next.js app - GET   /api/scraper/jobs       <- worker polls this every 15s
                PATCH /api/scraper/jobs/{id}   <- worker posts result here
                Auth: x-scraper-secret header (shared secret in env)

Local machine (laptop / mini PC):
  scraper-worker/
    src/index.ts            - main loop (ONE browser, ONE context, ONE page)
    src/session-manager.ts  - load/validate/save sessions
    src/humanizer.ts        - human-like delays, scrolling, typing
    src/scrapers/
      linkedin.ts           - navigate profile, extract text
      seek.ts               - navigate SEEK Talent profile, extract text
    src/util/
      encrypt.ts            - AES-256-GCM for session files
      log.ts                - leveled logger
    .env                    - credentials (gitignored)
```

---

## The main loop

`src/index.ts` keeps ONE browser alive for the whole process; the single `page`
navigates between LinkedIn and SEEK profiles. No new tab/browser per job.

```
main()
  context = launch ONE persistent browser
  page    = context's page (reused for every scrape)
  loop:
    jobs = GET /api/scraper/jobs
    for each job:
      ensureSession(job.platform, context, page)
      profile = scrape{LinkedIn|Seek}Profile(url, page)
      PATCH /api/scraper/jobs/{job.id} completed
      sleep 2-6s
    sleep 15s
```

---

## Remaining setup tasks (status)

1. **DB schema** — applied (ScrapeJob table + indexes, CandidateIdentity.seekUrl,
   ProfileInsight.sourceInputHash/contributingPlatforms). Verified in prod.
2. **Prisma client** — regenerated.
3. **`scraper-worker/.env`** — created on the mini-PC (RAILWAY_API_URL, SCRAPER_SECRET,
   SESSION_ENCRYPTION_KEY, LINKEDIN_*, SEEK_*, LOG_LEVEL, POLL_INTERVAL_MS).
4. **Install + Chromium** — done (npm install + patchright chromium, 24.04 platform
   override for Ubuntu 26.04; browser launch smoke-tested OK).
5. **Run forever** — systemd service `recruitme-scraper` installed + enabled (autostart
   on boot). On the mini-PC, pm2 is an alternative.
6. **First login** — one-time interactive login required (LinkedIn challenges a fresh
   device); done via `npx tsx login.ts linkedin` / `seek` in the desktop session over RDP.

---

## Do NOT

- Create a new browser/context/page per job — defeats session persistence.
- Scrape JobAdder — they have an API; scraping is unnecessary and blocked.
- Change auth from `x-scraper-secret` to API keys — the shared secret is set in Railway
  and working.

---

## Notes from setup (RecruitMe specifics)

- Mini-PC OS is **Ubuntu 26.04** — too new for Playwright's OS list, so Chromium was
  installed with `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64`.
- Railway deploys `main`; the scraper backend (`/api/scraper/jobs` routes +
  `scraper-ingestion.ts`) was cherry-picked onto main and is live.
- Remote access to the mini-PC is via **GNOME Remote Desktop (RDP)** on port 3389
  (Ubuntu's built-in remote desktop). The interactive login must run inside the
  desktop session — a Chromium window launched purely over SSH won't map on Wayland.
- Secrets (SCRAPER_SECRET, SESSION_ENCRYPTION_KEY, DATABASE_URL) live in the mini-PC
  `.env` / Railway env vars — never commit them.
