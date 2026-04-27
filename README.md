# RecruitMe

AI-powered recruiter tool for IT search assignments. Finds LinkedIn candidates via SerpAPI/Bing, captures full profiles via a browser extension, scores them against parsed job requirements using Claude, and manages the hiring pipeline.

---

## Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js 15 (App Router, TypeScript) |
| Database | PostgreSQL via Prisma ORM |
| Auth | NextAuth.js with credentials (bcrypt) |
| AI | Claude (Anthropic) — JD parsing, scoring, outreach generation |
| Search | SerpAPI (Google) + Bing Web Search |
| Deployment | Railway (Docker/Nixpacks) |

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
| `ANTHROPIC_API_KEY` | Yes (if using Claude) | Anthropic API key. Claude is the recommended provider. |
| `ANTHROPIC_MODEL` | No | Model ID. Default: `claude-haiku-4-5-20251001`. Use `claude-sonnet-4-6` for higher quality scoring. |
| `AI_PROVIDER` | No | `claude` (default) \| `openai` \| `ollama`. |
| `OPENAI_API_KEY` | If `AI_PROVIDER=openai` | OpenAI API key. |
| `OPENAI_MODEL` | No | Default: `gpt-4o-mini`. |
| `OLLAMA_BASE_URL` | If `AI_PROVIDER=ollama` | e.g. `http://127.0.0.1:11434`. Local Ollama instance. |
| `OLLAMA_MODEL` | No | Default: `llama3.2:3b`. |

### Search APIs (at least one required to use LinkedIn search)

| Variable | Description | Where to get it |
|---|---|---|
| `SERPAPI_API_KEY` | Google LinkedIn search. 100 free searches/month. | [serpapi.com](https://serpapi.com) |
| `BING_API_KEY` | Bing LinkedIn search. ~$5/1000 searches. | [Azure Portal](https://portal.azure.com) → Bing Search |
| `PDL_API_KEY` | People Data Labs profile enrichment. 100 free/month. | [peopledatalabs.com](https://peopledatalabs.com) |

These can also be entered in the app's Settings modal (stored encrypted-in-DB). Env vars take priority.

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
│   ├── ai.ts                   # Claude/OpenAI/Ollama abstraction
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
└── recruitme-opera-linkedin-capture/
    ├── manifest.json
    ├── background.js            # Extension alarm, pending session polling
    ├── content.js               # LinkedIn DOM scraping + profile extraction
    └── popup.{html,js}          # Extension popup UI
```

### Key flows

**Search** — POST `/api/jobs/:id/search` → fires background task → polls GET `/api/jobs/:id/search?sessionId=X`. Results stored in `SearchSession` + `Candidate` tables.

**Profile capture** — Web UI POSTs to `/api/extension/fetch-session` → creates `FetchSession` → extension alarm opens LinkedIn tab → extension POSTs captured text to `/api/extension/fetch-session/complete` → profile saved and scored.

**Scoring** — every write path (capture, CV upload, manual add, score-all) uses `buildScoreCacheKey()` to avoid re-scoring unchanged profiles. Cache key includes profile text + job context (parsedRole, salary, location).

---

## Multi-tenancy

Each `Job` and derived data is scoped to an `orgId`. The `requireJobAccess` helper in `lib/session.ts` enforces this on every route. The owner account (`role: "owner"`) bypasses org filters. Org isolation is covered by tests in `src/app/api/__tests__/org-isolation.test.ts`.

---

## Browser extension

The extension ships as a zip download from `/api/extension/download`. Source lives in `browser-companion/recruitme-opera-linkedin-capture/`.

**To install locally:**
1. Open Opera → Extensions → Load unpacked → select the folder above
2. Open the extension popup → set server URL to `http://localhost:3000` → enter credentials → Save

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
