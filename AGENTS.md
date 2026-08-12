# RecruitMe Agent Instructions

Use these instructions for Codex work in this repository. `CLAUDE.md` mirrors the same operating contract for Claude Code so both agents share the same project map.

## Project Map

- Main app: Next.js 15 App Router, TypeScript, React 19, Prisma, PostgreSQL.
- Main source: `src/`.
- Prisma schema and migrations: `prisma/`.
- Browser companion extension: `browser-companion/recruitme-chrome-extension/`.
- Electron shell: `electron/`.
- Admin portal: `admin-portal/`, a separate Hono/Node app.
- Scraper worker: `scraper-worker/`, a separate TypeScript worker for self-hosted discovery.
- Railway deployment config: `railway.toml`, `Dockerfile`, and `scripts/start-production.mjs`.

## Core Commands

From the repo root:

```bash
npm run dev
npm run build
npm run test
npm run lint
npm run db:generate
npm run db:migrate
npm run db:push
```

Admin portal:

```bash
cd admin-portal
npm run dev
npm run start
```

Scraper worker:

```bash
cd scraper-worker
npm run dev
npm run build
npm run test
```

## Database Rules

- Do not use `npm run db:push` for production changes.
- For schema changes, edit `prisma/schema.prisma`, run `npm run db:migrate`, and commit the generated migration.
- Production startup runs `prisma migrate deploy`.
- Regenerate Prisma client after schema changes with `npm run db:generate` when needed.

## Testing Expectations

- Run the narrowest relevant test first.
- For shared app behavior, route logic, scoring, auth, org isolation, search, or cache changes, run `npm run test` before finishing when feasible.
- For scraper worker changes, run `cd scraper-worker && npm run test` and `npm run build` when TypeScript behavior changes.
- If tests are not run, state why and name the command that should be run.

## Multi-Agent Workflow

- Only one agent should own a file at a time.
- Prefer a lead/reviewer split:
  - Implementer edits and runs tests.
  - Reviewer inspects `git diff` for bugs, regressions, missing tests, and simpler alternatives.
- For parallel implementation, use isolated Git worktrees instead of sharing the same checkout.
- Good branch names:
  - `agent/codex/<short-task>`
  - `agent/claude/<short-task>`
- Before editing, check `git status --short` and avoid reverting unrelated user or agent changes.
- Before handoff, provide:
  - Files changed.
  - Tests run.
  - Known risks or follow-up checks.

## Style And Safety

- Keep changes scoped to the task.
- Follow existing patterns before adding abstractions.
- Do not commit secrets or `.env.local`.
- Do not touch generated build output such as `.next/`, `node_modules/`, or `tsconfig.tsbuildinfo`.
- Use existing AI provider abstractions in `src/lib/ai/` rather than creating ad hoc provider calls.
- Preserve org isolation and auth checks on routes. New route behavior should use existing session/org helpers.
- Browser extension changes should preserve localhost and deployed-origin flows described in `README.md`.
