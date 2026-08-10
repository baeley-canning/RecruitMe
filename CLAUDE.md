# RecruitMe Claude Code Instructions

Use these instructions for Claude Code work in this repository. `AGENTS.md` mirrors the same operating contract for Codex so both agents share the same project map.

## Project Map

- Main app: Next.js 15 App Router, TypeScript, React 19, Prisma, PostgreSQL.
- Main source: `src/`.
- Prisma schema and migrations: `prisma/`.
- Browser companion extension: `browser-companion/recruitme-opera-linkedin-capture/`.
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

## Delegate To The DeepSeek Harness — Default, Not Optional

Any task that burns a lot of tokens — bulk coding, mechanical refactors, sweeps
across many files, boilerplate, test scaffolding, migrations of call sites — goes
to the DeepSeek harness. Do not grind through it in-context. If you find yourself
about to hand-edit the tenth call site, stop and delegate it.

**This is NOT the app's DeepSeek integration.** The app's is `src/lib/ai/`, keyed by
`DEEPSEEK_API_KEY` on Railway, and it serves customers. The harness is the owner's
own tool for delegating *our* work, keyed from `~/.config/deepseek/key`. Never mix
them: never spend the app's key on development, never point the harness at
production config.

```bash
HARNESS=~/.local/share/ds-harness            # clone: git@github.com:baeley-canning/DeepSeek-Harness-.git
export DEEPSEEK_API_KEY="$(cat ~/.config/deepseek/key)"

python3 $HARNESS/delegate.py --self-test     # confirm reachable
python3 $HARNESS/delegate.py --list-models

# typical: spec in a file, real files as context, verified before it comes back
python3 $HARNESS/delegate.py -f /tmp/spec.md \
  -c src/a.ts src/b.ts --extract -o /tmp/out.ts \
  --verify "npx tsc --noEmit" --retries 2
```

Useful flags: `--extract` (largest fenced code block only), `--verify CMD --retries N`
(harness re-prompts until the command passes), `--review` (second-model critique),
`--thinking off|low|high|max`, `--context-budget`. Every call is logged to
`~/.local/share/delegate/`.

Rules learned the hard way:

- **The delegate writes production code, never the tests that verify it.** A model's
  own tests assert the behaviour it *believed* it implemented, so they pass whether
  or not the code is right. Write the test, or the `--verify` command, yourself.
- **Never `--extract` a prose deliverable.** It returns the first fenced block, so a
  handoff doc comes back as a 2-line snippet.
- **Always read the returned diff before committing.** Delegated output has shipped
  real bugs here (a smoke test that tracked only the last id and leaked rows).
- Give it a written spec and the actual files. A vague prompt costs more than doing
  it yourself, because you pay for the round trip and still have to fix it.

Do NOT delegate — the dividing line is blast radius, not difficulty. Keep anything
whose failure is silent and expensive:

- The score cache key / invalidation (`buildScoreCacheKey`, `SCORE_CACHE_VERSION`) —
  a wrong key re-scores the whole library and spends real money.
- The scoring rubric in `src/lib/ai/prompts/` — pure judgement, and it is the product.
- Org isolation, auth, scraper-token boundaries — failures here are breaches that pass tests.
- Prisma migrations.
- Anything that spends the owner's money or calls a paid vendor.

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
