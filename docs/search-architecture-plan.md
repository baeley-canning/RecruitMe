# Candidate Search & Discovery — Architecture Plan

**Status:** Proposed · **Author:** session 2026-06-03 (agent-researched) · **Scope:** the job-level + global candidate search/discovery system

This plan replaces the band-aids accumulated while debugging "search doesn't use LinkedIn/SEEK" with a single, future-proofed design. It is **phased so every step ships independently without breaking search** — no big-bang rewrite.

---

## 1. Why (the problems we're fixing)

The system grew two parallel search stacks that drifted apart. Verified problems (file:line evidence in the codebase):

| # | Problem | Evidence |
|---|---------|----------|
| P0 | **Two incompatible result models.** Legacy job search writes `SearchSession` (ephemeral, JSON `importedIds`, lost on navigation); the newer multi-source + global search write `SearchRun`/`SearchRunResult` (durable, org-scoped). They never reference each other. | `search/route.ts` (SearchSession) vs `search/multi/route.ts` + `api/search/route.ts` (SearchRun) |
| P1 | **Two UIs, one of which is a dead end.** `search-card.tsx` (the prominent "Step 2 / Find Candidates" box → `/search`) had its live discovery gutted when SerpAPI was removed; `unified-search-modal.tsx` ("Search talent" → `/search/multi`) is the working one. Users naturally use the dead one. | `search-card.tsx`, `unified-search-modal.tsx` |
| P2 | **SEEK is half-baked.** It's enqueued + scraped into `Candidate.seekUrl`, but **never indexed in `searchTsv`** and **not handled in `/search/multi/import`**, so SEEK profiles harvest into the pool and then never surface. | `scraper-ingestion.ts`, `library.ts` FTS, `multi/import/route.ts` |
| P3 | **"Library-first" is stated but not enforced** — and was recently inverted so live sources fire regardless of pool fill. The intent ("serve cache, reach out only for the gap, but always *offer* live") is muddled. | `multi/route.ts` libraryShortfall + liveRequested |
| P4 | **Fire-and-forget discovery with no visibility** in the legacy path — the scraper is enqueued but no job IDs are returned, so the user can't see it working (the async-no-feedback anti-pattern). | `search/route.ts` POST `void enqueueSearchJob(...)` |
| P5 | **Search-time provisional gating drops candidates pre-import**, so relaxing requirements later can't recover them. | `search/route.ts` `hasSpecialistSourceSignal` |
| P6 | **Dead/zombie code**: SerpAPI no-op tasks + unused constants; PDL kept as a legacy fallback nothing drives. | `search/route.ts` `executeSearchTask*`, `SERPAPI_*`, `searchPDLProfiles` |
| P7 | **Dedup/identity logic duplicated** across ingestion, aggregation, and a `(jobId, linkedinUrl)` unique constraint — they can disagree. | `scraper-ingestion.ts`, `talent-search/aggregate.ts` |
| P8 | **Adding a source is hard** — each source is hand-wired into multiple routes. There is no source abstraction. | (whole system) |

---

## 2. Target architecture

Treat this as a **federated search over heterogeneous, capability-differentiated sources** — one query model, one result stream, many adapters. Adding source #5 should be "write one adapter + declare its capabilities," nothing else.

```
                         DiscoveryRequest
              { query, location, jobId, orgId, sources[] }
                                │
                    ┌───────────▼────────────┐
                    │   Discovery Dispatcher  │  src/lib/discovery/dispatcher.ts
                    │  - reads capability     │
                    │    flags per source     │
                    │  - enforces budgets     │
                    │  - fans out             │
                    └───────────┬─────────────┘
            ┌───────────────────┼─────────────────────┐
            ▼                   ▼                     ▼
   PoolAdapter (sync)   LinkedInAdapter (async)  SeekAdapter (async, $credits)
   FTS over pool        enqueueSearchJob p=100   enqueueSearchJob p=100
   instant results      → ScrapeJob → worker     → ScrapeJob → worker
            │                   │                     │
            └───────────────────┼─────────────────────┘
                                ▼
                    ┌────────────────────────┐
                    │   SearchRun (durable)   │  one result model
                    │   + SearchRunResult[]   │  dedup by canonical identity
                    └───────────┬─────────────┘
                                ▼
              SSE stream  /api/search-runs/[id]/stream
              (instant pool rows + live rows as they scrape,
               per-source status pills)
                                ▼
                    One search UI (job + global)
```

### 2.1 Source adapter interface

```ts
// src/lib/discovery/source.ts
export interface CandidateSource {
  id: "pool" | "linkedin" | "seek";          // + future
  capabilities: {
    mode: "sync" | "async";                    // pool=sync, scrape=async
    cost: "free" | "credits" | "compute";      // seek=credits
    rateLimit?: { rps: number; dailyCap: number };
    freshness: "live" | "cached";
    canFilterLocation: boolean;                // pool=true, scrape=server-side query
  };
  /** sync sources resolve directly; async sources enqueue + return job handles */
  run(req: DiscoveryRequest, ctx: DiscoveryCtx):
    Promise<{ results: NormalizedCandidate[]; liveJobs: LiveJob[] }>;
}
```

**Capability flags are load-bearing**: the dispatcher uses them to decide *before* dispatch whether to auto-fire (free+sync), require explicit intent (credits), and how the UI renders (sync→instant, async→status pill). The UX, the cost governance, and the routing all read the same flags.

### 2.2 One result model

Collapse onto **`SearchRun` + `SearchRunResult`** (already durable + org-scoped + per-source status columns + dedup by `mergeKey`). A run carries an optional `jobId` so job-scoped and global searches share one model. **Delete `SearchSession`** once the legacy route is migrated. Results become durable + reusable across jobs (fixes P0).

### 2.3 One UI

Merge `search-card` + `unified-search-modal` into a single `<CandidateSearch>` driven by the dispatcher:
- Source toggles rendered **from capability flags** (Library always; LinkedIn free → default on; SEEK credits → default off, labelled with cost).
- **Instant** pool rows render immediately; **live** rows stream in via SSE with per-source status pills ("LinkedIn: searching… 14 found", "SEEK: needs re-auth").
- No more "use the other button." One search, everywhere (fixes P1).

### 2.4 Streaming (replace polling + fire-and-forget)

Add `GET /api/search-runs/[id]/stream` (SSE) — RecruitMe already runs SSE for the box-dashboard, so the pattern exists. The run page subscribes; the scraper PATCH-ingest path notifies the run; the SSE layer pushes new `SearchRunResult` rows + status. This replaces both the legacy 3s polling and the invisible fire-and-forget (fixes P4). Polling remains a documented fallback.

> **Stack note:** the research's reference stack is BullMQ + Redis pub/sub. We intentionally **keep the existing Postgres-backed `ScrapeJob` queue** — it already implements priority, in-flight dedup, the two-part live/background claim, and `searchRunId` correlation. Redis/BullMQ is recorded as a *future* option if scrape volume outgrows Postgres polling; it is **not** required for this plan. We adopt the *patterns* (idempotency, jittered backoff, dedup, TTL cleanup, streaming) on the infra we have.

---

## 3. Cross-cutting concerns (best-practice targets)

- **Identity resolution — one tiered resolver** (`src/lib/discovery/identity.ts`), used by both ingestion and aggregation: (1) canonical profile URL (strip query/locale/`mwlite`, lowercase host, vanity slug), (2) email/phone, (3) fuzzy name + company + normalized location. **Link, don't destructively merge** — keep provenance + per-source re-fetch (fixes P7).
- **Scoring — score the normalized representation, cache by hash.** Keep the existing `buildScoreCacheKey` (profileText + role + salary + location + weights + correctionsVersion) and the two-phase model split (snippet→Haiku, full profile→Sonnet, shipped `7227d1a`). Add model version to the cache key. Never re-score on read if the hash is unchanged (fixes P5/P8 — and move source-gating *post-import* so relaxing requirements can recover candidates).
- **Cost & rate governance — at the dispatcher, from capability flags.** Free+sync (pool) auto-runs; credit sources (SEEK) require explicit toggle; daily caps via the existing usage/spend tracking. Worker: human-like rate + **jittered** exponential backoff (un-jittered backoff is now a detectable bot signature). Keep the single-logged-in-browser worker — the governance lever is rate/behaviour, not proxy rotation.
- **Freshness — stale-while-revalidate.** Serve cached profiles instantly; re-fetch in the background. Volatility-aware TTLs (title/company churn faster than name). Demand-driven re-crawl (re-fetch engaged/often-changing profiles, not the whole pool on a timer) — and **budget-gate the flywheel** so background enrichment can't exhaust scraping headroom or SEEK credits.

---

## 4. Phased delivery (each phase ships + is verified independently)

**Phase 0 — Cleanup + SEEK surfacing (low risk, high clarity).** *Directly fixes the user's pain.*
- Delete SerpAPI dead code (`executeSearchTask*`, `SERPAPI_*` constants, the no-op task queue). Decide PDL: keep behind a clearly-labelled flag or remove.
- **Index `seekUrl` in `searchTsv`** + handle `seekUrl` in `/search/multi/import` so SEEK-scraped profiles actually surface (fixes P2).
- Document current behaviour in code comments.

**Phase 1 — Source adapter layer (refactor, zero behaviour change).**
- Extract pool / linkedin / seek logic behind `CandidateSource` + capability flags. Both existing routes call the adapters. Tests pin behaviour unchanged.

**Phase 2 — Unify the result model.**
- Migrate the legacy `/search` to write `SearchRun`/`SearchRunResult` (with `jobId`) instead of `SearchSession`. Deprecate `SearchSession`. One durable, reusable result store (fixes P0).

**Phase 3 — Dispatcher + unified UI.**
- Introduce the dispatcher; merge the two search UIs into `<CandidateSearch>` with capability-driven toggles. Retire the dead legacy box (fixes P1).

**Phase 4 — Streaming.**
- SSE for live run results + per-source status pills; replace legacy polling + fire-and-forget (fixes P4).

**Phase 5 — Governance + freshness.**
- Dispatcher-level budgets, stale-while-revalidate re-fetch, demand-driven re-crawl, jittered worker backoff.

**Phase 6 — Consolidate identity + scoring.**
- One identity resolver shared by ingestion + aggregation; verify score-cache invalidation + post-import gating (fixes P5/P7/P8).

**Sequencing rationale:** Phase 0 fixes the visible bug (SEEK never surfaces) and removes confusion immediately. Phases 1–2 are the structural backbone (adapters + one result model) that everything else builds on. 3–4 are the UX payoff. 5–6 are hardening. Stop after any phase and the system is strictly better than today.

---

## 5. What this explicitly deletes / deprecates
- SerpAPI remnants (dead). PDL (deprecate unless a key is actively used).
- `SearchSession` model (after Phase 2).
- The duplicate dedup/scoring/gating code paths (after Phases 1 & 6).
- The "use the other search button" UX (after Phase 3).

## 6. Non-goals (deliberately out of scope)
- Redis/BullMQ migration (the Postgres queue suffices; revisit only on volume).
- Proxy rotation (conflicts with the logged-in single-browser worker).
- New paid data sources (the adapter layer makes adding them trivial later).

## 7. References
Researched 2026-06: federated-search hybrid (cached + live) UX; adapter + common-data-model for pluggable sources; SSE-over-queue streaming with per-source status; BullMQ idempotency/dedup/jittered-backoff patterns (applied to the Postgres queue); tiered entity resolution (exact-URL → email/phone → fuzzy) with link-not-merge; hash-keyed score caching with stale-while-revalidate freshness; budget-gated paid sources + jitter as anti-bot-detection. Full agent research notes available on request.
