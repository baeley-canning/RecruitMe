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
startup → launch ONE Chromium → log in to LinkedIn + SEEK (ONCE)
         → save encrypted session cookies to disk
         → loop forever: poll → scrape → post result → sleep 15s
```

On the next restart, `ensureSession()` loads the saved cookies from disk and
validates them. If they're still valid, no login happens. If they've expired,
it logs in once and saves fresh cookies.

**Key file: `scraper-worker/src/session-manager.ts`**

```
ensureSession(platform, context, page)
  └── loadSession()      — decrypts cookies from sessions/{platform}.enc
      └── isSessionValid() — navigates to feed/dashboard, checks we're not on /login
          └── if invalid: authenticate() — types credentials, submits, waits for redirect
              └── saveSession() — encrypts cookies back to disk
```

Sessions are stored as AES-256-GCM encrypted files in `scraper-worker/sessions/`.
They persist across restarts. The encryption key is `SESSION_ENCRYPTION_KEY` in `.env`.

---

## JobAdder — why we don't scrape it

JobAdder has an **official REST API**. Scraping their web app is unnecessary,
fragile, and violates their terms. The correct approach for JobAdder is:

1. Recruiter grants OAuth access via JobAdder → we get an access token
2. We call the JobAdder API directly (`GET /candidates/{id}`) — no browser needed
3. Profile data arrives as structured JSON, cleaner than any scrape

**What to do with JobAdder scrape jobs right now:** mark them failed immediately
with `"JobAdder: use API integration instead of scraping"`. Do NOT attempt to
scrape their web app. The API integration is a separate feature.

This is already implemented in `scraper-worker/src/index.ts`:
```typescript
} else if (job.platform === "jobadder") {
  await postResult(job.id, { status: "failed", error: "JobAdder scraping not yet implemented" });
}
```

---

## Architecture overview

```
Railway (cloud):
  PostgreSQL ─── ScrapeJob table ─── pending | processing | completed | failed
  Next.js app ── GET  /api/scraper/jobs       ← worker polls this every 15s
                 PATCH /api/scraper/jobs/{id} ← worker posts result here
                 Auth: x-scraper-secret header (shared secret in env)

Local machine (laptop / mini PC):
  scraper-worker/
    src/index.ts          ← main loop (ONE browser, ONE context, ONE page)
    src/session-manager.ts ← load/validate/save encrypted sessions
    src/humanizer.ts       ← human-like delays, scrolling, typing
    src/scrapers/
      linkedin.ts          ← navigate profile, extract text
      seek.ts              ← navigate SEEK Talent profile, extract text
    src/util/
      encrypt.ts           ← AES-256-GCM for session files
      log.ts               ← leveled logger
    sessions/
      linkedin.enc         ← encrypted cookies (gitignored)
      seek.enc             ← encrypted cookies (gitignored)
    .env                   ← credentials (gitignored)
```

---

## The main loop in detail

`src/index.ts` does exactly this — **do not restructure it**:

```
main()
  browser = chromium.launch({ headless: true })   ← ONE browser, lives forever
  context = browser.newContext(...)                ← ONE context with mobile UA
  page    = context.newPage()                      ← ONE page, reused for every scrape

  loop:
    jobs = GET /api/scraper/jobs
    for each job:
      ensureSession(job.platform, context, page)   ← login once, reuse session
      profile = scrapeLinkedInProfile(url, page)   ← navigate + extract
      PATCH /api/scraper/jobs/{job.id} completed
      sleep 2–6s                                   ← human pause between jobs
    sleep 15s                                      ← poll interval
```

The single `page` object navigates between LinkedIn profiles, then to SEEK profiles,
then back. There is no reason to open a new tab or new browser per job.

---

## What to actually do (the remaining setup tasks)

### 1. Apply database schema (run once)

```bash
psql "postgresql://postgres:FLGuQVIEZsjVjiYfHHsXyWrYRLbASZTa@maglev.proxy.rlwy.net:26875/railway" << 'SQL'
CREATE TABLE IF NOT EXISTS "ScrapeJob" (
  "id"          TEXT NOT NULL,
  "orgId"       TEXT NOT NULL,
  "platform"    TEXT NOT NULL,
  "profileUrl"  TEXT NOT NULL,
  "status"      TEXT NOT NULL DEFAULT 'pending',
  "result"      TEXT,
  "error"       TEXT,
  "retryCount"  INTEGER NOT NULL DEFAULT 0,
  "candidateId" TEXT,
  "identityId"  TEXT,
  "requestedBy" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScrapeJob_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ScrapeJob_orgId_status_idx" ON "ScrapeJob"("orgId","status");
CREATE INDEX IF NOT EXISTS "ScrapeJob_orgId_platform_idx" ON "ScrapeJob"("orgId","platform");
CREATE INDEX IF NOT EXISTS "ScrapeJob_status_createdAt_idx" ON "ScrapeJob"("status","createdAt");
ALTER TABLE "CandidateIdentity" ADD COLUMN IF NOT EXISTS "seekUrl" TEXT;
ALTER TABLE "ProfileInsight" ADD COLUMN IF NOT EXISTS "sourceInputHash" TEXT;
ALTER TABLE "ProfileInsight" ADD COLUMN IF NOT EXISTS "contributingPlatforms" TEXT NOT NULL DEFAULT '[]';
SQL
```

Or paste the above SQL into Railway dashboard → Postgres service → **Data** tab.

### 2. Regenerate Prisma client

```bash
cd /path/to/RecruitMe
DATABASE_URL="postgresql://postgres:FLGuQVIEZsjVjiYfHHsXyWrYRLbASZTa@maglev.proxy.rlwy.net:26875/railway" npx prisma generate
```

### 3. Create `scraper-worker/.env`

```env
RAILWAY_API_URL=https://YOUR-APP.railway.app
SCRAPER_SECRET=SR3zbGS01zGjy/Y7+YvBlMY+2LJ1iPxdueTQxUirf+E=
LINKEDIN_EMAIL=recruiter@youragency.com
LINKEDIN_PASSWORD=yourpassword
SEEK_EMAIL=recruiter@youragency.com
SEEK_PASSWORD=yourpassword
SESSION_ENCRYPTION_KEY=8a5eaa9edae54044f33366c2e4592f30ca9588bac6ea4d49fb76f1e9326617fb
LOG_LEVEL=info
POLL_INTERVAL_MS=15000
```

Get `RAILWAY_API_URL` from: Railway dashboard → your web service → Settings → Domains.

The `SCRAPER_SECRET` value above must match what's already set in Railway's
environment variables (the user set this in Step 1).

### 4. Install + launch

```bash
cd scraper-worker
npm install
npx patchright install chromium
npm run dev
```

Expected startup output:
```
[info] scraper worker starting — polling https://recruitme.railway.app every 15000ms
[info] browser ready — viewport 390×844
[info] linkedin: session valid        ← (after first run; first run will log in)
[info] no pending jobs
[info] no pending jobs
...
```

### 5. Test with a real job

First, get an orgId from Railway DB:
```bash
psql "postgresql://postgres:FLGuQVIEZsjVjiYfHHsXyWrYRLbASZTa@maglev.proxy.rlwy.net:26875/railway" \
  -c 'SELECT id, name FROM "Org" LIMIT 5'
```

Then enqueue a LinkedIn scrape job:
```bash
curl -X POST https://YOUR-APP.railway.app/api/scraper/jobs \
  -H "x-scraper-secret: SR3zbGS01zGjy/Y7+YvBlMY+2LJ1iPxdueTQxUirf+E=" \
  -H "Content-Type: application/json" \
  -d '{"orgId":"<id from above>","platform":"linkedin","profileUrl":"https://www.linkedin.com/in/williamhgates/"}'
```

The worker should log within 15 seconds:
```
[info] claimed 1 job(s)
[info] processing job cxxx — linkedin — https://www.linkedin.com/in/williamhgates/
[info] job cxxx completed — 2847 chars
```

---

## Do NOT do any of these

- ❌ Create a new browser/context/page per job — defeats session persistence entirely
- ❌ Attempt to scrape JobAdder — they have an API, scraping is unnecessary and blocked
- ❌ Change the auth from `x-scraper-secret` to API keys — the shared secret is already
  set in Railway and is working. API key system doesn't exist yet in the codebase.
- ❌ Rewrite the session manager — it already handles load/validate/login/save correctly
- ❌ Add pm2 or nodemon as a dependency — user will set that up on the mini PC separately

## Running forever (production)

On the mini PC (tonight), run with pm2 so it restarts on crash:
```bash
npm run build          # compile TS → dist/
pm2 start dist/index.js --name scraper-worker --restart-delay=5000
pm2 save
pm2 startup            # auto-start on boot
```

---

## Key secrets (already generated, do not regenerate)

| Variable | Value |
|---|---|
| `SCRAPER_SECRET` | `SR3zbGS01zGjy/Y7+YvBlMY+2LJ1iPxdueTQxUirf+E=` |
| `SESSION_ENCRYPTION_KEY` | `8a5eaa9edae54044f33366c2e4592f30ca9588bac6ea4d49fb76f1e9326617fb` |
| `DATABASE_URL` | `postgresql://postgres:FLGuQVIEZsjVjiYfHHsXyWrYRLbASZTa@maglev.proxy.rlwy.net:26875/railway` |

The `SCRAPER_SECRET` is set in Railway's environment variables already.
The `RECRUITME_SCRAPER_ENABLED=true` is set in Railway's environment variables already.
