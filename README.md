# RecruitMe

AI-powered recruiter tool for IT search assignments. Discovers candidates from a local talent library (Postgres full-text boolean search) plus live LinkedIn/SEEK discovery via a self-hosted scraper worker, captures full profiles via a browser extension, scores them against parsed job requirements using Claude (with a local Ollama/Llama fallback), and manages the hiring pipeline.

---

## Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js 15 (App Router, TypeScript) |
| Database | PostgreSQL via Prisma ORM |
| Auth | NextAuth.js with credentials (bcrypt) |
| AI | Claude (Anthropic) primary — JD parsing, scoring, outreach. Local Ollama/Llama fallback (chat-with-failover) when Claude is unavailable. |
| Search | Local library boolean FTS (Postgres `to_tsquery`) + live LinkedIn/SEEK discovery via the self-hosted scraper worker. PDL for optional profile enrichment. |
| Deployment | Railway (app + Postgres); a mini-PC runs the scraper worker + local Ollama (polls Railway outbound — no inbound path). |

---

## Local development

### Prerequisites

- Node.js 20+ (via nvm recommended — project uses v20)
- PostgreSQL running locally, OR a Railway dev database
- On Windows: run everything inside WSL — `wsl.exe --cd /home/cassius/recruitme bash -lc "npm install && npm run dev"`

### Setup

```bash
cp .env.example .env.local
# Fill in the required vars (see Environment Variables below)

npm install
npm run db:push      # sync schema to your local DB (first time)
npm run dev          # http://localhost:3000
```

### Useful scripts

```bash
npm run dev            # Next.js dev server with HMR
npm run build          # production build (also generates Prisma client)
npm run start:prod     # production start (runs migrations then Next)
npm run test           # Vitest unit + route tests
npm run db:generate    # regenerate Prisma client after schema changes
npm run db:migrate     # create a new migration (dev only)
npm run db:push        # push schema directly (local dev only — prod uses migrate deploy)
npm run db:studio      # Prisma Studio DB browser
```

---

## Environment variables

Copy `.env.example` to `.env.local`. All variables below are required unless marked optional.

### Database

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string. Railway injects this automatically via `${{Postgres.DATABASE_URL}}`. |

### Auth

| Variable | Description |
|---|---|
| `NEXTAUTH_SECRET` | Random secret for session signing. Generate with `openssl rand -base64 32`. |
| `NEXTAUTH_URL` | Full URL of the deployment, e.g. `https://your-app.railway.app`. Used for OAuth callbacks. |

### AI

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key. Claude is the primary provider for parsing, scoring, and outreach. |
| `ANTHROPIC_MODEL` | No | Model ID. Default: `claude-haiku-4-5-20251001`. Use `claude-sonnet-4-6` for higher-quality scoring. |
| `OLLAMA_BASE_URL` | No | OpenAI-compatible endpoint for the local Ollama fallback. Default `http://127.0.0.1:11434/v1`. On any Claude error the failover wrapper retries on Ollama. (The old OpenAI/GPT failover was removed — the fallback is now local Ollama only.) |
| `OLLAMA_MODEL` | No | Local model used for offloaded tasks. |
| `OLLAMA_OFFLOAD_TASKS` | No | Comma-list of light tasks (e.g. `info_extract`, `cv_clean`) to run on local Ollama instead of Claude to save tokens. Candidate SCORING is not offloadable — it's Claude, with a free deterministic Fit score as the default (see "AI scoring" in PLAN.md). |

### Discovery & enrichment

Primary candidate discovery is the **self-hosted scraper worker** (live LinkedIn/SEEK people search) feeding the local library, plus Postgres boolean FTS over that library. The worker runs on a mini-PC and polls the app — see `scraper-worker/`.

| Variable | Description |
|---|---|
| `SCRAPER_SECRET` | Shared secret the scraper worker presents (`x-scraper-secret`) to claim/post jobs. Must match the worker's `.env`. |
| `SCRAPER_DISCOVERY_ENABLED` | `true` (default) → a multi-source search enqueues live LinkedIn/SEEK discovery jobs (the SERP replacement). `false` → library-only. |
| `PDL_API_KEY` | People Data Labs profile enrichment (optional). [peopledatalabs.com](https://peopledatalabs.com) |
| `SERPAPI_API_KEY` / `BING_API_KEY` | Legacy SERP providers — present only for historical source labels/back-compat; no longer the primary discovery path (the scraper replaces them). Optional. |

API keys can also be entered in the app's Settings modal (stored encrypted-in-DB). Env vars take priority.

### File storage (optional — Cloudflare R2 / S3-compatible)

CV files are AES-256-GCM encrypted (`CV_ENCRYPTION_KEY`) and stored inline (base64) in Postgres by default. Setting the `BLOB_S3_*` vars offloads the encrypted blobs to an S3-compatible bucket (Cloudflare R2) instead — **inert until configured** (with none set, files stay as encrypted base64 in Postgres; existing rows keep working after you flip it on).

| Variable | Description |
|---|---|
| `BLOB_S3_ENDPOINT` / `BLOB_S3_BUCKET` / `BLOB_S3_ACCESS_KEY_ID` / `BLOB_S3_SECRET_ACCESS_KEY` / `BLOB_S3_REGION` | S3-compatible (R2) credentials for the encrypted-CV blob store. |
| `CV_ENCRYPTION_KEY` | AES-256-GCM key for the at-rest CV envelope (independent of where the blob lands). |

### Rate limits (optional — defaults shown)

| Variable | Default | Description |
|---|---|---|
| `RATE_LIMIT_SEARCH` | `30` | Max LinkedIn searches per org per hour. |
| `RATE_LIMIT_SCORE_ALL` | `20` | Max score-all runs per org per hour. |
| `RATE_LIMIT_SCORE` | `200` | Max individual scores per org per hour. |
| `RATE_LIMIT_CAPTURE` | `100` | Max extension captures per org per hour. |
| `RATE_LIMIT_PARSE` | `100` | Max JD parse calls per org per hour. |

### Other

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_APP_URL` | Public URL shown in the extension download and auth flows. |

---

## Database

### Schema changes

**Do not use `db push` in production.** The production startup script runs `prisma migrate deploy`, which applies pending migrations in order. To make a schema change:

```bash
# 1. Edit prisma/schema.prisma
# 2. Create a migration
npm run db:migrate     # prompts for a migration name, generates SQL
# 3. Commit prisma/migrations/** along with your schema change
```

The baseline migration (`20260427000000_baseline`) is idempotent — it uses `CREATE TABLE IF NOT EXISTS` throughout. Safe to run against a DB that was previously managed by `db push`.

### First deploy (fresh Railway database)

Railway runs `npm run start:prod` which executes `prisma migrate deploy` before starting Next. New tables are created automatically.

### Seeding

`prisma/seed.js` creates the owner account on every startup if it doesn't exist. Configure the owner credentials in the seed file or override via env if you add that feature.

---

## Architecture overview

```
src/
├── app/
│   ├── api/                    # All API routes (Next.js App Router)
│   │   ├── jobs/               # CRUD + parse + search + candidates
│   │   ├── candidates/         # Library (cross-job deduped view)
│   │   ├── extension/          # Browser extension endpoints (CORS open)
│   │   └── ...
│   ├── jobs/[id]/              # Job detail page (candidates, search, scoring)
│   └── candidates/             # Candidate library page
├── components/
│   ├── job/                    # Job-page sub-components (SearchCard, PipelineCard, modals)
│   ├── candidate-card.tsx      # Candidate accordion with score breakdown
│   └── ...
├── lib/
│   ├── ai/                     # Claude primary + local Ollama fallback (chat-with-failover), parsing, scoring seams
│   ├── linkedin-capture.ts     # Extension session queue + profile save
│   ├── scoring.ts              # Score breakdown types and builders
│   ├── usage.ts                # Rate limiting + usage event logging
│   ├── session.ts              # Auth helpers + org access guards
│   └── ...
└── ...

prisma/
├── schema.prisma
└── migrations/                 # All schema migrations (committed to git)

browser-companion/
└── recruitme-chrome-extension/
    ├── manifest.json
    ├── background.js            # Extension alarm, pending session polling
    ├── content.js               # LinkedIn DOM scraping + profile extraction
    └── popup.{html,js}          # Extension popup UI
```

### Key flows

**Search** — POST `/api/search` creates a durable `SearchRun`: the local library boolean FTS (`to_tsquery`) attaches synchronously; LinkedIn/SEEK discovery runs asynchronously via the scraper worker (child `ScrapeJob`s → harvested → ingested → attached to the run). The client polls the run. (The legacy per-job `/api/jobs/:id/search` still exists.)

**Profile capture** — Web UI POSTs to `/api/extension/fetch-session` → creates `FetchSession` → extension alarm opens LinkedIn tab → extension POSTs captured text to `/api/extension/fetch-session/complete` → profile saved and scored.

**Scoring** — every write path (capture, CV upload, manual add, score-all) uses `buildScoreCacheKey()` to avoid re-scoring unchanged profiles. Cache key includes profile text + job context (parsedRole, salary, location).

---

## Multi-tenancy

Each `Job` and derived data is scoped to an `orgId`. The `requireJobAccess` helper in `lib/session.ts` enforces this on every route. The owner account (`role: "owner"`) bypasses org filters. Org isolation is covered by tests in `src/app/api/__tests__/org-isolation.test.ts`.

---

## Browser extension

The extension ships as a zip download from `/api/extension/download`. Source lives in `browser-companion/recruitme-chrome-extension/`.

**To install locally:**
1. Open Chrome, Opera, Edge, Brave, or another Chromium browser → Extensions → Load unpacked → select the folder above
2. Open the extension settings → set the RecruitMe server URL to the exact app origin, for example `http://localhost:3000` in dev or the desktop app's displayed `http://localhost:<port>`
3. Enter your RecruitMe username and password → Save and test connection

Desktop builds may use a free localhost port when `3000` is unavailable. The extension manifest allows any localhost port, but the saved server URL still needs to match the URL shown by the running RecruitMe app.

**How it works:**
1. The web app creates a `FetchSession` when you click "Fetch Profile"
2. The extension polls `/api/extension/fetch-session` every 30 seconds via an alarm
3. When it finds a pending session, it opens the LinkedIn profile tab
4. `content.js` scrapes the visible DOM, expands sections, and returns the profile text
5. The extension POSTs the text to `/api/extension/fetch-session/complete`
6. The server cleans, scores, and saves the profile; the web UI polls for completion

---

## Running tests

```bash
npm run test               # all tests (vitest)
npm run test:watch         # watch mode
```

Tests are unit/route tests with mocked DB and AI calls. There are no integration tests requiring a real DB. Coverage is focused on:
- Scoring logic and cache key invariants (`src/lib/__tests__/`)
- Route auth and org isolation (`src/app/api/__tests__/org-isolation.test.ts`)
- Search import and talent pool upgrade (`src/app/api/jobs/[id]/search/route.test.ts`)
- Score-all cache freshness (`src/app/api/jobs/[id]/candidates/score-all/route.test.ts`)

---

## Deployment (Railway)

1. Connect your GitHub repo to Railway
2. Railway auto-detects Nixpacks from `railway.toml`
3. Add a PostgreSQL plugin — Railway injects `DATABASE_URL` automatically
4. Set env vars in Railway dashboard (see Environment Variables above)
5. Push to `main` → Railway builds and deploys
6. On startup: `prisma migrate deploy` runs, then Next.js starts on `PORT`

### Scraper worker + local AI (mini-PC)

The scraper worker (`scraper-worker/`) and a local Ollama run on a self-hosted mini-PC, **not** on Railway. The worker polls the Railway app's `/api/scraper/jobs` (outbound only — no inbound path needed), scrapes LinkedIn/SEEK/JobAdder, and POSTs results back for the app to ingest into the library. A local Ollama optionally handles LIGHT tasks (`OLLAMA_OFFLOAD_TASKS`, e.g. CV cleaning / info extraction) and chat failover — **not** candidate scoring (scoring is Claude, defaulting to the free deterministic Fit score; the old box score-offload was removed 2026-07-04). The box authenticates with the shared `SCRAPER_SECRET` (operator, all orgs) or a per-org `SCRAPER_API_TOKEN` (a customer's BYO-box, locked to their org). See `scraper-worker/HANDOFF.md`.
