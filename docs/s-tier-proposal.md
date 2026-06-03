# RecruitMe `s-tier-hardening` — Single-Box Perf/UX + Maintainability Plan (v2, reviewed)

> Scope = single self-hosted box (~14k candidates). No fleet/centralization.
> Goal = recruiter-facing perf/UX + maintainability, landed incrementally on
> `s-tier-hardening` with the standard gate per step (tsc + lint + vitest + smoke:db).
>
> **v2** = revised after a 3-agent adversarial review (claim-verification, pragmatism,
> correctness/risk). What the review changed is summarised under each item.

## TL;DR — the vetted sequence

1. **Bump `score-all` `CONCURRENCY` 3 → 6 and measure.** One literal (`score-all/route.ts:22`). May fix large-job truncation outright. **S (~1h + measure).**
2. **C2-lite: parallelize + cache `getLibraryStats`.** Move it into the dashboard `Promise.all` with a `.catch` fallback + a short in-process cache. Unconditional, near-zero-risk latency win on the two hottest screens. **S (~1-2h).**
3. **C1 backstop (only if step 1 isn't enough): client auto-continue for score-all** — but first reconcile the 60s cooldown, with a mandatory round cap and terminal handling. **M (~4-6h).**
4. **C3 (optional, maintainability): extract the fetch state machine to a tested hook** — hook-level tests written *first*. **L (~10-14h).**
5. **C4 (rides after C3): per-critical-module coverage ratchet.** **S (~2h).**

**CUT this cycle:** full SQL rewrite of `getLibraryStats` (gated on measurement + a new parity test), `ReferenceCheck.orgId` (C5 — no reader, no bug), dead-code sweep (C6 — churn, no recruiter value).

Steps 1-2 are the proven recurring wins and are both ~1h. Everything else is conditional or maintainability.

## Context corrections (verified by the review against the tree)

These were already fixed — NOT problems: job API uses an explicit `select` excluding heavy fields (`jobs/[id]/route.ts:31-52`); candidate list render-capped at 50 (`page.tsx:226-227`); `CandidateCard` is `memo`'d with on-expand-only score fetch (`src/components/candidate-card.tsx:902, 1006-1010`); search deferred (`page.tsx:1193`); library cursor-paginated (`library.ts:195-383`). The fact-checker confirmed all of these.

## The changes (revised)

### Step 1 — Raise `score-all` CONCURRENCY, then measure
**Problem (PROVEN):** `maxDuration=300`, `CONCURRENCY=3` (`.../candidates/score-all/route.ts:20,22`), two AI calls/candidate → ~0.6 cand/s → ~180/300s; bigger jobs truncate to `partial` (`page.tsx:1036-1038`).
**Change:** raise `CONCURRENCY` to 6 (measure box CPU + AI rate limits). The per-chunk spend-cap gate (`route.ts:203-210`) already bounds overspend to CONCURRENCY calls, so this is a throughput/rate-limit question, not a correctness one. At 6 you clear ~360-480 candidates in one request — covers most real jobs with zero new machinery.
**Why this is first (review):** the pragmatism reviewer flagged that the original plan jumped to a client loop without trying the 1-line lever. Measure before building.

### Step 2 — C2-lite: parallelize + cache `getLibraryStats`
**Problem (PROVEN structure):** `getLibraryStats` (`library.ts:432-471`) does a no-LIMIT ~14k-row scan + per-row correlated `EXISTS` + JS dedup, and on the dashboard it runs **serially after** the main `Promise.all` (`dashboard/route.ts:100,103`). (Correction from review: the *candidates* page already calls it in parallel — so this win is dashboard-specific.)
**Change:** move the dashboard call into the `Promise.all` with `.catch(() => fallbackStats)` (so a stats failure degrades one card, not 500s the whole dashboard — review caught this), and add a short (30-60s) in-process cache keyed by accessible-orgs. ~1-2h, near-zero risk.
**Deferred — full SQL rewrite:** HIGH risk per the review. A naive `GROUP BY lower(trim(url))` does **not** reproduce `normaliseLinkedInUrl` (`linkedin.ts:1-5`) — diverges on query strings, host/`www` variation, trailing slash, and especially **NULL urls (each counts as a distinct person in JS; SQL would collapse them)**. And `getLibraryStats` has **zero test coverage today**, so the original "verify vs library.test.ts + smoke:db" was hollow. Only pursue if: (a) measurement (Q4) proves the per-row EXISTS is the actual cost, AND (b) a new real-DB parity test (`stats.total === JS-normaliser count`, with NULL/querystring/host cases) is written and passing *first*.

### Step 3 — C1 backstop: client auto-continue (only if Step 1 insufficient)
**Change:** when the score-all stream ends without `done:true` and `scored < total`, `handleRescoreAll` (`page.tsx:992-1046`) re-POSTs with `?onlyUnscored=1` (exists, `route.ts:36,74`) until done or a round cap.
**Review-mandated safeguards (the original plan got the cooldown backwards):**
- **Reconcile the 60s cooldown** (`route.ts:87-102`): a sub-60s round that re-POSTs hits `claim.count===0` → 429 "already running" → the loop self-aborts. Either back off ≥60s between rounds (slow) or special-case the chained `onlyUnscored` continuation in the claim logic. **This is a blocker to resolve before building.**
- **Mandatory round cap** (load-bearing, not optional): an always-failing candidate keeps `matchScore:null` (`route.ts:348-352`), stays in the `onlyUnscored` set forever → `total` never hits 0. Cap rounds + surface "stopped after N, X remain".
- **Treat `capped` and `aiUnavailable` (`route.ts:387`) as terminal stops**, not retry.
- **Test:** a permanently-failing candidate terminates the loop.
- **Known limitation (state it):** closing the tab mid-loop stops scoring (resumable by re-clicking). Acceptable, but not durable.

### Step 4 — C3 (optional): extract the fetch state machine to a tested hook
**Change:** move the capture orchestration (`page.tsx:262-399, 577-891`) into `src/app/jobs/[id]/use-fetch-queue.ts`.
**Review corrections:** effort is **10-14h, not 6-8** — it's the most race-sensitive code in the app, not "verbatim-extractable". It uses function-refs reassigned *during render* (`page.tsx:750-751`) so `setInterval` callbacks see latest closures; the `{onCandidateUpdate,onJobReload}` callback shape invites re-render/interval-churn loops if identities aren't stabilised. **Requires hook-level tests written BEFORE the refactor** (fake timers: poll cadence, PENDING/PROCESSING timeouts, cancel mid-POST, visibility-hidden, unmount cleanup) — tsc + manual smoke is not enough. Land on a quiet base (after Steps 1-3 settle).

### Step 5 — C4: per-critical-module coverage ratchet
Per-file thresholds in `vitest.config.ts` at *current* coverage for the already-tested critical libs (`score-utils`, `library`, `linkedin`, `identity-merge`, `org-access`, `fetch-profile-orchestrator`). NOT global. Needs `@vitest/coverage-v8` (Q3). Cheap insurance; do after C3 so the new hook is captured.

## CUT (with reasons)
- **Full SQL rewrite of getLibraryStats** — HIGH risk, hollow verification today; do C2-lite instead, gate the rewrite on measurement + a parity test.
- **C5 `ReferenceCheck.orgId`** — no leak (access enforced transitively, `session.ts:89-110`), no read path depends on it, no feature pending; the author listed four reasons not to. If ever done, it must go through `apply-schema-changes.mjs` (not Prisma migrate — the box doesn't migrate via Prisma) as a nullable add + NOT-VALID FK + backfill.
- **C6 dead-code sweep** — no recruiter value, and blast radius is understated: `ts-prune`/`knip` miss dynamic imports (`mammoth`, error-reporting, Sentry configs), out-of-graph `.mjs`/`appliance`/`scraper-worker` consumers, and Next route exports. A wrong deletion passes `next build` but 500s a route or breaks a cron. Not worth it now.
- Virtualizing the 50-capped job list; RSC-ifying the page; splitting `candidate-card.tsx`; global coverage thresholds; `src/lib` regroup — all gold-plating.

## Open decisions for the PO
- **Q1 (Step 1):** OK to raise `CONCURRENCY` to 6 and measure? Any known Anthropic rate-limit ceiling I should respect on this box?
- **Q4 (Step 2):** OK to add a temporary timing log / run `EXPLAIN ANALYZE` on the real ~14k DB to decide whether the full getLibraryStats rewrite is ever worth it? (C2-lite proceeds regardless.)
- **Q3 (Step 5):** OK to add `@vitest/coverage-v8` devDep?
- **Q5 (ceiling):** if only the cheap wins land this cycle → Steps 1 + 2 (both ~1h) and stop; push C1-backstop/C3/C4 to a follow-up. Confirm, or say "do it all".
