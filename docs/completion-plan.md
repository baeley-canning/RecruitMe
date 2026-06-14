# RecruitMe — Completion Plan ("done, no more coding")

_Authored 2026-06-14 from a 6-dimension parallel code audit (features, search/scoring, scraper/box, security, UI/UX, tests/CI/ops). Every claim verified against code on branch `s-tier-hardening`, not just memory._

## What "done" means here

Software is never literally "zero code forever" — LinkedIn/SEEK will change their markup and break scrapers, dependencies need security patches, anti-bot challenges need a human to click "log in". So **completion = the app needs no code for normal operation, and the unavoidable exceptions are isolated, alerted, and one-tap.** Concretely, six gates:

1. **Data-safe** — no scenario silently loses data forever (CV key escrowed, backups off-platform + restore-tested).
2. **Correct & secure** — no cross-org leaks, no unmetered AI spend, no PII leaking to logs.
3. **Functionally complete** — every feature is either finished + reachable, or deleted. LinkedIn search actually returns results.
4. **Self-running** — failures page you (alerting + uptime), the box self-heals the common faults, and the only manual act left is the unavoidable anti-bot re-login (already one click in the box dashboard).
5. **Locked** — tests + CI + branch protection catch regressions so deploys can't silently break search/scoring/auth/tenancy.
6. **Honest deploy path** — schema changes go through real migrations, not a destructive raw-DDL script that runs on every boot.

Estimated effort to all six gates: **~22–30 working days** (owner chose to FINISH every dormant feature rather than cut any — see Phase 3). Phases are ordered by irreversibility and risk, not by ease.

**Owner decisions (2026-06-14):** Finish CRM · Finish ALL dormant features (reminders+tags, white-label, insight/flywheel, identity-merge UI) · JobAdder = one-time bulk import is enough (no ongoing scrape leg).

---

## Memory corrections (do first — these mislead future work)

The audit found the persistent notes diverge from code. Fix these notes so we stop planning against fiction:

- **Phase-C insight ranking is NOT shipped.** `src/lib/talent-search/*` has zero references to `ProfileInsight`/`factsJson`. Memory `talent-flywheel` claims it's "SHIPPED & LIVE" — false. The flag `RECRUITME_PROFILE_INSIGHT_RANKING` was removed entirely.
- **`LLAMA_SCORE_OFFLOAD` defaults ON in code + README**, despite memory `llama-score-offload` saying it was disabled. When Claude credits run out, scoring currently routes to a box that (per memory) can't do it → 4–5 min hang instead of a clean failure. **This is a live discrepancy to fix, not just a doc.**
- **SEEK works now.** Memory `search-architecture-plan` says "SEEK has never run (0 candidates)" — stale. SEEK is wired end-to-end and a validated run took it 0→98 real candidates.
- **Phase E (candidate UX) is ~90% shipped**, not pending. Plan `tidy-orbiting-avalanche.md` is essentially done (email everywhere, screening-summary card, source badges, import-batch filter, JobAdder button). Only E3's file-chip-on-job-card half remains.
- **Several pages are orphaned** (`/clients`, `/placements`, `/settings/white-label`) — not in the sidebar nav. `github-search` page no longer exists.

---

## Phase 0 — Stop irreversible data loss (DO FIRST) · ~1 day

Nothing else matters if a key loss bricks 13k CVs.

| # | Item | Effort | Notes |
|---|------|--------|-------|
| 0.1 | **Escrow `CV_ENCRYPTION_KEY` off-platform** (password manager + printed/sealed copy). Document the location. | S | Lose it → all 13,464 AES-GCM CVs permanently unreadable. |
| 0.2 | **Escrow the box's age *private* key** (or confirm it exists off-box). | S | Encrypted backups you can't decrypt = no backups. |
| 0.3 | **Make CV encryption fail-closed** when `CV_ENCRYPTION_KEY` is unset (stop the silent auto-mint of a *mismatched* Setting key in `cv-encryption.ts:71-88`). | S | Closes a silent-corruption window. |
| 0.4 | **Confirm Railway Postgres automated backups are ON** + add a scheduled off-platform `pg_dump` (to R2/another provider) + run **one** restore drill. | M | 14.5k candidates/jobs/scores live only here. |
| 0.5 | **Confirm `jobadder_archive` is backed up off-box** + decryptable + one restore drill. | M | Box-only DB, source of truth for JobAdder. |
| 0.6 | **Enable R2 bucket versioning** (or second-region copy) for the CV bucket. | S | Single bucket, single region today. |

---

## Phase 1 — Correctness & security must-dos · ~1–2 days

All small; must land before any feature flag is flipped or the DB cutover happens.

| # | Item | Effort | Severity |
|---|------|--------|----------|
| 1.1 | **Fix candidate-tags cross-org leak** — `/api/candidates/[id]/tags` GET+PUT have no org check and accept arbitrary `tagIds`. Add candidate-org verification + constrain tagIds to caller org. | S | HIGH (flag-masked today, blocks reminders/CRM flip) |
| 1.2 | **Close 4 AI cost-attribution gaps** (one PR): `extractCandidateInfo`, capture-path `predictAcceptance` (`linkedin-capture.ts:606`), reference Q&A, shortlist-summary — all record cost to the null-org bucket, bypassing spend caps. | S | MED |
| 1.3 | **Sentry `beforeSend` PII scrubber** + `sendDefaultPii:false` across all 4 Sentry configs — candidate names/profileText/email/phone can currently ship to Sentry (NZ Privacy Act). | S | MED |
| 1.4 | **Fix `LLAMA_SCORE_OFFLOAD`** — flip code default to `false`, reconcile README, confirm prod env var. | S | MED (prevents credit-out hang) |
| 1.5 | **Enable "wait for CI" / branch protection on `main`** so a red CI actually blocks the deploy (today it doesn't). | S | HIGH (makes the existing gate real) |

---

## Phase 2 — The one big functional hole: LinkedIn search returns 0 · ~1 day (scraper)

The app pipeline is correct and durable; the box's people-search harvester pulls **0 cards** every run (stale DOM selectors or a 240s timeout firing pre-render). LinkedIn is the marquee live source — "Search talent" silently yields only library+SEEK until this is fixed.

| # | Item | Effort | Notes |
|---|------|--------|-------|
| 2.1 | **One-shot debug capture** in `scraper-worker/src/scrapers/linkedin-search.ts` — screenshot + HTML dump to *see* what renders before theorising. Then fix selectors/timeout. | M | Don't guess the cause (no-gaslighting rule). |
| 2.2 | **Broaden the scraper legs too** when the precise query is empty — pass `broadenedTo` keywords to the LinkedIn/SEEK enqueue, not just the library FTS (`multi/route.ts:166-177`). | S | |
| 2.3 | **Click-test the durable UX end-to-end** (close tab → reopen → completed live scrape). | S | The proof the convergence is real. |

---

## Phase 3 — Finish every dormant feature · ~7–11 days

**Owner chose to finish all of these (cut nothing).** Each must end up finished + reachable + with its latent security gap closed. This is the largest phase. Build each as a self-contained slice: schema (if needed) → API hardening → UI → nav → test.

| # | Feature | What "finished" requires | Effort |
|---|---------|--------------------------|--------|
| 3.1 | **Phase E3** (file chip on job card) | Render `FileSummaryChip` on the candidate-card collapsed row (one import + one JSX line). | S |
| 3.2 | **CRM** (clients/submissions/placements) | Add Clients+Placements to nav; build `/placements/new` + `/placements/[id]`; mount the submit-to-client modal in the job flow; add `GET /api/jobs/[id]/submissions`; **validate FK ownership on create** (placements/submissions reference in-org candidate/job/client only — security L1). | L |
| 3.3 | **Reminders + Tags** | Add `orgId` to `CandidateTagAssignment` (+ backfill); **fix the cross-org tag read+write leak** (security H1 — folds in here); build tag chips on candidate cards + a tag manager; build a reminder bell/widget + dashboard surfacing; validate reminder FK ownership (security L1). | L |
| 3.4 | **White-label** | Mount `<WhiteLabelStyles>` in the root layout; make the stylesheets actually consume the brand CSS vars; render `brandName`/`logoUrl`/`footerText` where they belong; link the settings page from the settings index; remove the dead `/settings/billing` link. | L |
| 3.5 | **Insight extractor + Phase C flywheel** | Build the read/ranking path (`searchLibrary` reads `ProfileInsight.factsJson`, blends into ranking); run the one-time backfill (~$5-10, owner-gated); re-introduce a ranking on/off control. | M + backfill cost |
| 3.6 | **Identity merge/unmerge UI** | Build a recruiter-facing merge-review panel that lists Tier-2/3 fuzzy-duplicate clusters and calls the existing merge/unmerge routes; wire it behind the existing flag, then enable. | M-L |

> Because we're **finishing** (not cutting), the security items H1 (3.3) and L1 (3.2) move from "do before flag flip" into the build itself — they're prerequisites for turning each feature on.

---

## Phase 4 — UI completion & polish · ~1–2 days

| # | Item | Effort | Impact |
|---|------|--------|--------|
| 4.1 | **Surface Clients/Placements in `NAV_ITEMS`** (if kept) — or remove the pages (if cut in Phase 3). Sidebar layouts were already added this session. | S | High |
| 4.2 | **Fix the last light-mode pills** → `bg-warning-subtle text-warning` (`placements/page.tsx:47,125`, `clients/[id]/page.tsx:108`). | S | Med |
| 4.3 | **Style `global-error.tsx`** in dark tokens (mirror `not-found.tsx`) — today an unhandled crash = white screen. | S | Med |
| 4.4 | **Apply `CardLoadError`** to the silent `.catch(()=>{})` fetches on dashboard/clients/placements (primitive already exists) — removes infinite-spinner-on-failure. | S-M | Med |
| 4.5 | **Declutter the candidate card right column** — up to ~10 chips/row today. Consolidate the two ProvenancePills, demote Confidence/FetchPriority/Insight + redundant status-dots to the drawer, fixed-width score slot for column alignment (`candidate-card.tsx:1146-1305`). | M | **High** (most-used screen; needs a design pass first) |
| 4.6 | Minor: `aria-label` on icon-only clears, tokenize stray `bg-[#3a3a3c]` (8×) and hex in score-radar/weights-editor. | S | Low |

---

## Phase 5 — Hands-off ops & reliability · ~2–3 days

This is what turns "works when watched" into "self-running."

| # | Item | Effort | Why |
|---|------|--------|-----|
| 5.1 | **Capture box infra as code** — commit the systemd units (`recruitme-scraper`, `recruitme-wifi-watchdog`, `recruitme-boxdash`, backup timer), Caddy route, and a `box-setup.md` into `scraper-worker/deploy/`. | M | Today the box can't be rebuilt without your memory. Highest leverage for unattended ops. |
| 5.2 | **Push alert on challenge / dead session** — when `/api/health` goes `degraded` or a `_challenge:` trips the breaker, notify (email/Telegram). | M | Converts "silently dead for hours" into "ping → tap the dashboard login button." The main thing between current state and hands-off. |
| 5.3 | **External uptime monitor** (healthchecks.io / UptimeRobot, free) polling `/api/health`, alerting on red or `degraded:true`. | S | Nobody polls the excellent health probe from outside today. |
| 5.4 | **Fix the orphaned `/api/heartbeat`** path (box posts "I'm down" to a route that doesn't exist) — build the receiver + alert, or repoint to the monitor. | S | Box-offline (WiFi-stall-prone) is currently invisible. |
| 5.5 | Persist daily caps across restart; verify wifi-watchdog is live. | S | Optional robustness. |

> _JobAdder ongoing scrape leg is OUT (owner: one-time bulk import is enough). The selector dry-run + CV-mirror route are not in scope._

---

## Phase 6 — The cutover: schema-pipeline collapse · ~1 day · scheduled deliberately

The single biggest data-integrity risk in the deploy path: `start-production.mjs` runs a 1000+-line raw-DDL script (with `DELETE FROM "Candidate"/"CandidateFile"/"CandidateIdentity"` dedupe) → `prisma db push --accept-data-loss` → re-applies the script, **on every deploy**. `prisma/migrations/` exists but is dead.

| # | Item | Effort |
|---|------|--------|
| 6.1 | Squash a baseline migration from a prod dump, `migrate resolve --applied`, switch `start:prod` to `migrate deploy`, delete the raw DDL script + `db push --accept-data-loss`. | L |

> Must land as one deliberate, gated change (tsc + lint + real-DB smoke). Memory correctly flags it to land *with* the DB cutover so the first boot doesn't run the destructive path.

---

## Phase 7 — Lock it: tests, CI, monitoring = the "no more coding" guarantee · ~2–3 days

Without this, future deploys can silently break the core and you'd only find out from a user.

| # | Item | Effort | Blast radius if skipped |
|---|------|--------|-------------------------|
| 7.1 | **Auth flow tests** (`auth.ts`: valid login, bad password, session role) — currently zero. | M | Broken login locks everyone out / opens a hole, CI green. |
| 7.2 | **Extend real-DB smoke to cross-org isolation** on candidate/job/search-run/scraper-queue (only the library path is real-DB-verified today; the rest is mock-verified). | M | Tenant data leak via unbound `orgId` ships undetected. |
| 7.3 | **AI scoring contract test** — recorded fixture pins the Claude response→parse path so a prompt/format drift fails CI. | M | Silent scoring regression admits wrong candidates. |
| 7.4 | **Replace stale `deploy-gate.sh`** (targets the retired box) with a short Railway deploy + rollback runbook. | S | Confusion / false sense of a gate. |
| 7.5 | **Version-control the backup scripts** so they're reviewable and can't silently rot. | S | Off-repo backup logic breaks with no diff. |

---

## The honest caveat — what will still need code, ever

After all seven phases, the app is set-and-forget for normal operation. The **only** code that should ever be needed:

1. **Scraper DOM drift** — LinkedIn/SEEK change their HTML; selectors break. Phase 5 alerting tells you when; the fix is localized to one scraper file.
2. **Dependency security patches** — periodic, mechanical.
3. **Anti-bot re-login** — not code; one tap in the box dashboard when a challenge appears (unavoidable by design).

Everything else — searching, scoring, importing, scraping, backups, monitoring — runs without you touching code.

---

## Decisions — RESOLVED (2026-06-14)

1. **CRM** → **Finish** (3.2).
2. **Dormant features** → **Finish all** — reminders+tags (3.3), white-label (3.4), insight/flywheel (3.5), identity-merge UI (3.6). Nothing cut.
3. **JobAdder scraping** → **Off.** One-time bulk import is enough; Phase 5.6 dropped.

## Suggested execution order

0 → 1 → 2 (close irreversibility + the one functional hole + the security floor) → **3** (the big build: finish all features, each as schema→API-harden→UI→nav→test) → 4 (UI polish + nav) → 5 (hands-off ops) → 6 (schema cutover, gated) → 7 (lock with tests/CI). Phases 0/1/2 are days; Phase 3 is the bulk; 4–7 close it out.
