# Profile-Update Alerts — BUILD spec (post-review decision doc)

*Engineer-facing. Derived from a 3-agent review of `docs/PROFILE-UPDATE-ALERTS-PLAN.md`. This is the authoritative build spec; the PLAN doc is the product framing.*

## Verdict
Design is sound; the plan's architecture was wrong in two load-bearing places. Do **not** extend `SavedSearch`; do **not** invent a parallel result/feed pipeline. A watch run is a **system-initiated `SearchRun`** seeded by a cron route; hit-detection reads that run's existing `SearchRunResult` rows. New `WatchedSearch` + `ProfileUpdateHit`; reuse `SearchRun`/`ScrapeJob`/`attachScraperHits`/SSE verbatim.

## Confirmed issues → resolutions (baked into the build)
- **I1 SavedSearch wrong base** (jobId non-null + cascade + unique blocks job-less watch) → new `WatchedSearch`, org-scoped, `jobId` nullable. Leave SavedSearch untouched.
- **I2 No dedupe/feed ledger** → new `ProfileUpdateHit` with DB `@@unique([watchId, seekId, updatedAtBucket])`, raw `ON CONFLICT DO NOTHING` upsert. Doubles as feed source + dedupe + bell count.
- **I3 Scraper doesn't parse "Updated X ago"** → add `updatedAgo` to `SearchCard`/`extractSeekCards` (additive, always-on, safe) + a pure unit-tested `parseUpdatedAgo(text, now)` → bucket floor ("today"→start-of-day, "2h ago"→now-2h, "last week"→now-7d, "over a year ago"→now-370d).
- **I4 Scraper doesn't set sort/filter** → add Date-updated sort + Last-updated filter to `scrapeSeekSearch`, **behind `SCRAPER_WATCH_FEATURES_ENABLED` env (off)** so the shared path is byte-identical when off. WARN loudly if a control isn't found; log final URL params. DEFERRED to owner for live-SEEK verification.
- **I5 No scheduler** → build `POST /api/watches/run-due` copying `src/app/api/admin/search-runs/sweep/route.ts` timing-safe auth; gate on `isProfileWatchSchedulerEnabled()`. Code now; trigger wiring deferred.
- **I6 Flag absent** → add `isProfileWatchEnabled()` (`FEATURES_PROFILE_WATCH_ENABLED`, default false) + `isProfileWatchSchedulerEnabled()` (`FEATURES_PROFILE_WATCH_SCHEDULER_ENABLED`, default false) to `src/lib/feature-flags.ts`.
- **I7 Shared cap starves discovery** → enforce a watch sub-cap APP-SIDE in `run-due` (`WATCH_DAILY_CAP` default 40); tag watch runs via `SearchRun.requestedBy = "watch:<id>"`. Worker backstop deferred (box deploy).
- **I8 $queryRaw tz-trap** (`library.ts:215-225`) → threshold comparison in **JS**, not SQL. `parseUpdatedAgo` returns a JS Date; compare to `notifyFrom` in TS. Unit-test the NZ-midnight boundary.
- **I9 No interval floor** → server-side clamp `intervalMinutes` to `[30, 1440]`, reject below-floor 422.
- **I10 Dedupe key** → numeric SEEK profile id (`seekId`, parsed from `/profile/(\d+)`), not the URL. `seekUrl` fallback.
- **I11 Core-search regression risk** → the I4 env gate means Phases ship with the shared scraper untouched at runtime; the `updatedAgo` parse is additive/safe.
- **Cross-org**: `ProfileUpdateHit.orgId` non-null; feed query filters `watchId AND orgId`. **Reminders**: do NOT create Reminder rows; bell shows a separate "N new profile updates" line from a COUNT.

## Schema (add to prisma/schema.prisma)
```prisma
model WatchedSearch {
  id              String   @id @default(cuid())
  orgId           String
  jobId           String?
  createdBy       String?
  name            String
  query           String
  location        String?
  notifyFrom      DateTime
  intervalMinutes Int      @default(1440)
  active          Boolean  @default(true)
  lastRunAt       DateTime?
  nextRunAfter    DateTime?
  lastRunId       String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  hits            ProfileUpdateHit[]
  @@index([orgId, active])
  @@index([active, nextRunAfter])
  @@unique([orgId, name])
}

model ProfileUpdateHit {
  id              String   @id @default(cuid())
  watchId         String
  watch           WatchedSearch @relation(fields: [watchId], references: [id], onDelete: Cascade)
  orgId           String
  seekId          String
  profileUrl      String
  candidateId     String?
  name            String?
  headline        String?
  location        String?
  updatedAgo      String?
  updatedAtBucket DateTime
  flaggedAt       DateTime @default(now())
  seen            Boolean  @default(false)
  @@unique([watchId, seekId, updatedAtBucket])
  @@index([orgId, seen, flaggedAt])
  @@index([watchId, flaggedAt])
}
```
Also add idempotent DDL for both tables to `scripts/apply-schema-changes.mjs` (the repo applies schema via that raw-DDL script, NOT prisma migrate). Run `npx prisma generate` so tsc sees the models.

## Build order (each stage leaves the tree compiling; all flags OFF)
- **A — headless core:** schema models + apply-schema-changes DDL + `prisma generate`; two feature flags; `src/lib/seek-updated-ago.ts` (`parseUpdatedAgo`) + unit tests.
- **B — scraper (behavior-gated):** `SearchCard`/`extractSeekCards` add `updatedAgo`+`seekId` (additive, always-on); `scrapeSeekSearch` sort/filter behind `SCRAPER_WATCH_FEATURES_ENABLED` (off). Build scraper-worker separately (`cd scraper-worker && npx tsc`).
- **C — app pipeline:** `src/lib/watched-search.ts` (CRUD + `enqueueWatchCheck` → `createRun({sources:["seek"]})` + `enqueueSearchJob({platform:"seek", priority:50, searchRunId})`; `detectHits(watchId, runId)` reads the run's SEEK SearchRunResult rows, JS-thresholds vs notifyFrom, ON CONFLICT upserts hits, resolves candidateId via seekUrl). `/api/watches` (GET/POST), `/api/watches/[id]` (PATCH/DELETE), `/api/watches/[id]/check` (POST). All gated on `isProfileWatchEnabled()` (404 off). **Prefer lazy hit-detection on feed load** keyed off `lastRunId` (simpler, headless-testable).
- **D — feed + bell:** `/api/watches/feed` (GET + mark-seen PATCH), `/api/watches/feed/stream` (SSE, copy `src/app/api/search/[runId]/stream/route.ts` in-process tick), `src/app/updates/page.tsx` (terminal-style live feed reusing box-dashboard mono aesthetic; `[open ↗]` → candidate page if candidateId else SEEK deep-link), watch setup form, `reminder-bell.tsx` adds a flag-gated "N new profile updates" line (separate fetch; no Reminder rows).
- **E — scheduler code:** `/api/watches/run-due` (cron-secret auth, gated on scheduler flag, app-side `WATCH_DAILY_CAP`).
- **Tests:** `parseUpdatedAgo` unit (incl. NZ-midnight); `/api/watches` route tests (flag-off 404, org-isolation, interval clamp 422, run-due auth + cap-skip); real-DB smoke for the `@@unique` dedupe.

## DEFER to owner (NOT headless-safe — Stage F)
1. Prod schema migration (apply the DDL to Railway prod; test on a replica first).
2. Box scraper rsync deploy + worker restart.
3. Live-SEEK verification of the Date-updated sort + Last-updated filter + parseable card date; only then `SCRAPER_WATCH_FEATURES_ENABLED=true` on the box.
4. Ban-cadence test at 30-45 min for a day.
5. Scheduler trigger (Railway scheduled job vs box systemd timer hitting `/api/watches/run-due` with `x-cron-secret`); then `FEATURES_PROFILE_WATCH_SCHEDULER_ENABLED=true`.
6. Worker-side cap backstop (`SCRAPER_WATCH_DAILY_CAP`) during box deploy.
7. Flag flips: `FEATURES_PROFILE_WATCH_ENABLED` (after prod migration + UI review), then the scheduler flag.

## Key reuse anchors
`src/lib/search-run.ts` (createRun, attachScraperHits, loadRunSnapshot), `src/lib/scrape-queue.ts` (enqueueSearchJob — has priority + searchRunId + searchLocation), `src/app/api/search/[runId]/stream/route.ts` (SSE), `src/app/api/admin/search-runs/sweep/route.ts` (cron-secret auth), `src/lib/feature-flags.ts` (isRemindersEnabled pattern), `src/app/box-dashboard/page.tsx` (mono/terminal UI + SSE). Anti-base: `prisma/schema.prisma:596-613` (SavedSearch — do NOT extend).
