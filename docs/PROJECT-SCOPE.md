# RecruitMe — Project Scope, Current State & Running Costs

*Prepared 2026-06-04; last updated 2026-06-22 — adds **Pulse** (SEEK CV-update alerts), **per-user activity + AI-cost/failure tracking**, and **inline-editable candidate contact details & links**, on top of the 2026-06-15 production activation of CRM, tags + reminders, white-label theming, identity merge-review, and the insight-ranked talent flywheel. Figures from live production data where measured; estimates flagged.*

---

## 1. What it is

RecruitMe is a recruiter-facing SaaS that sources, scores, and manages candidates for open roles. A recruiter creates a **job** (pastes a JD → AI parses it into structured must-haves / nice-to-haves / seniority / location / salary), then **finds candidates** from three sources — an internal **talent pool** (~15k profiles), **LinkedIn**, and **SEEK Talent Search** — and the system **AI-scores** each candidate against the role, producing a ranked shortlist with a written rationale per candidate.

Multi-tenant (org-scoped); currently one organisation (placeMe IT) with a 5-person recruiter team. Deployed on Railway; live discovery runs through a self-hosted mini-PC scraper.

---

## 2. Current state (what's built & working)

**Scale (live, 2026-06-22):** 16,284 candidates · 983 AI-scored · 827 with AI-extracted insight-facts · ~13.5k CVs stored (encrypted at rest) · 14 jobs · 5 active Pulse watches (76 profile-update hits surfaced) · 5 users in 1 org.

### Tech stack
- **App:** Next.js 15 / React 19 / TypeScript, Prisma ORM, PostgreSQL 18 — hosted on **Railway** (auto-deploy from GitHub `main`).
- **AI:** Anthropic Claude — **Haiku 4.5** for parsing & snippet scoring (cheap), **Sonnet 4.6** for full-profile scoring (quality). Cost-tracked per call with a daily spend cap.
- **Scraper:** self-hosted mini-PC ("the box") running a persistent logged-in browser (Patchright) for LinkedIn + SEEK; reached over Tailscale. Single-worker by design (ban-avoidance).
- **Storage:** CVs in an S3-compatible bucket (`t3.storageapi.dev`), **AES-256-GCM encrypted at rest**, original sender format preserved.

### Features shipped & working
- **JD analysis** — Claude parses a pasted JD into structured requirements + search expansion + title variants.
- **Multi-source candidate search** — internal pool (Postgres full-text + AI ranking), live LinkedIn scrape, live SEEK Talent Search scrape. Library-first (cheap pool results instant; live sources on demand).
- **AI scoring** — per-candidate match score (0–100) with must-have coverage, category breakdown, and a recruiter summary; provisional (snippet) vs full-profile scoring; per-org configurable weights; cached so unchanged candidates aren't re-billed.
- **SEEK Talent Search** — ingests result cards as candidates (credit-safe: harvests free card data, no per-profile credit spend), now **sorted by "Date updated"** so the freshest movers lead the results. *Validated 2026-06-04; recency sort 2026-06-17.*
- **LinkedIn discovery** — people-search → profiles scraped → ingested + scored. *(Fixed 2026-06-15: a stale hardcoded NZ geo-filter parameter that LinkedIn had silently stopped honouring was making **every** LinkedIn search return "No results found" — verified on the box, then removed. Results are NZ-biased via the logged-in account; the app re-narrows by the requested location.)*
- **CRM — clients / submissions / placements** *(live)* — client records, "submit candidate to client" from a job, placement tracking with fee/guarantee/invoice + auto-reminders. Finishes the previously half-built CRM; all create paths org-FK-validated.
- **Candidate tags + reminders** *(live)* — colour-coded tags (create / assign / manage at `/settings/tags`) and a reminders bell with due/overdue tracking (follow-up · guarantee-check · client-feedback · custom).
- **White-label theming** *(live)* — per-org brand colour (inert until an org sets one; computes a distinct hover shade + luminance-darkens too-light colours so button text stays readable).
- **Identity merge-review** *(live)* — recruiter-facing panel on the candidate page to confirm or split duplicate-person merges (same email / phone / name surfaced across sources), over the org-scoped, tombstone-safe merge/unmerge routes.
- **Talent pool / flywheel** *(live, insight-ranked)* — every search enriches the pool; future searches serve those candidates instantly. **Insight-ranked search is now on**: 812 candidate profiles carry AI-extracted structured facts (primary stack / titles held / domains) that nudge library-search ranking — a bounded re-rank (own-org-scoped, a no-op for any candidate without an insight, never reorders across the FTS top results by more than a few places).
- **Candidate management** — library, per-job pipelines (shortlist/contacted/etc.), CV upload + text extraction, identity dedup across sources (LinkedIn / SEEK / JobAdder), screening data, recruiter notes, CSV export.
- **CV handling** — extraction from PDF/Word/RTF, encryption at rest, original-format preservation.
- **Ops** — on-box health dashboard (CPU/RAM/disk/temp, scraper status), cost attribution + daily spend cap, PII redaction on the seller heartbeat, CI real-DB test gate, error reporting.
- **Security & data-safety floor** *(shipped 2026-06-15)* — CV encryption now fails closed (refuses to mint a new key when encrypted CVs exist, so a missing key can't silently orphan them); cross-org candidate-tag read/write leak closed; four AI-cost-attribution gaps closed (spend now always billed to the right org); Sentry PII scrubber so candidate names/emails/profile text don't leave the app; Llama-offload default flipped off (the box can't score, so a credit-out now fails cleanly instead of hanging).
- **Live JobAdder feed** — the operator's JobAdder candidate data (~13k profiles) is available live and on demand, drawn from the operator's own JobAdder account, and kept current in the platform.
- **Pulse — SEEK profile-update alerts** *(live)* — a recruiter defines a "watch" (boolean query + location + run interval); the box re-runs it on SEEK on a schedule and surfaces candidates who've **updated their SEEK profile** into a live, terminal-style feed and the reminders bell, with the profile linked. Credit-safe (card harvest only), recency-sorted (newest movers first), and each watch/hit shows who set it up. A box timer drives the schedule; the watch always notifies from when it's created.
- **Per-user activity + AI-cost/failure tracking** *(live)* — the admin dashboard attributes every action (search / score / parse / capture) to the user who did it and which job, with a per-user breakdown — plus an **AI-failure view** so the operator can see who hit an out-of-credit / rate-limit wall, and when. Built for the now-multi-user team.
- **Inline-editable candidate fields** *(live)* — LinkedIn / JobAdder / SEEK links and phone / email / location are now editable directly on the candidate page (add, correct, or clear), each with a matching brand icon. Previously these were display-only.

### Known constraints / debt
- **Two parallel search systems** — now largely converged onto one durable, resumable multi-source run (job-scoped, live-streaming). The legacy job-search path is mostly retired; final dead-code cleanup is the remaining item — see roadmap §3.
- SEEK candidates are **snippet-level** (name/role/company/location); full-profile enrichment is a separate, credit-gated action (scraper exists, not auto-fired). *(Fixed 2026-06-15: "Score all" now scores these thin LinkedIn/SEEK finds as a low-confidence estimate instead of silently skipping them.)*
- ~16.3k candidates, **983 scored** — large unscored backlog. Scoring is **manual + on-demand** by design (recruiter clicks *Score all* or per-card) and cost-capped; finds are not auto-scored on import/discovery. *(Score-all now auto-resumes if a long run's connection drops, picking up where it left off rather than restarting.)*
- **No AI fallback** — production is 100% Claude-dependent (no working local model on Railway *or* the box). If the Anthropic credit balance runs out or Claude is unavailable, all AI — scoring **and** insight extraction — hard-fails with no graceful degradation. Operationally: keep the Anthropic balance topped up.
- Single scraper worker (no redundancy); the box must stay online for live discovery.
- Scraper still authenticates via a shared secret (org-binding token cutover incomplete).
- **SEEK session needs periodic manual re-login** — SEEK logs in through Auth0 + a Cloudflare Turnstile human-check and actively expires automated sessions, so the box's SEEK login has to be refreshed by a person every day or two (it can't be automated past the human check). The app softens this — a self-healing auth circuit and a rolling session re-save stretch the interval and auto-recover the instant a valid session returns — but can't fully remove it. Live SEEK search + Pulse pause until it's refreshed (one click in the on-box control dashboard). A fix to persist the Auth0 token for longer-lived sessions is in progress.

---

## 3. Future implementations (roadmap)

*The authoritative, sequenced plan to take the app to feature-complete + self-running lives in `docs/completion-plan.md` (7 phases, built from a verified 6-dimension audit). The items below are the strategic summary.*

**A. Search architecture consolidation** *(planned, documented in `docs/search-architecture-plan.md`)* — collapse the two parallel search systems into one **federated dispatcher + pluggable source adapters** (pool/LinkedIn/SEEK/+future), one durable result model, and a **live-streaming results UI** (results appear as they're scraped). Makes adding a new source trivial and removes the current fragility. ~6 phases, each independently shippable.

**B. SEEK full-profile enrichment** — one-click, credit-aware deep-fetch of a chosen SEEK candidate's full profile (the scraper exists; needs wiring + a credit guard).

**C. Scoring at scale** — score the unscored backlog; background/batch scoring; richer re-score-on-change.

**D. Talent flywheel — later phases** — the **read-path (insight-ranked search) is now live + backfilled (812 profiles)**. Remaining: background discovery that continuously enriches the pool (cost-gated); profile freshness / re-fetch of stale profiles; raising the insight coverage as the pool grows.

**E. Candidate UX polish** — **shipped** (email/screening/file-count surfacing, import-batch grouping, source badges, plus **inline-editable LinkedIn/JobAdder/SEEK links + phone/email/location** and matching brand icons). Remaining: candidate-card density declutter.

**F. Hardening** — complete the scraper org-binding token cutover; **persist the SEEK Auth0 token so the session auto-renews** (removes the periodic manual re-login — see constraints §2); multi-worker / redundancy if scrape volume grows; observability.

**G. SEEK credit visibility** *(scoped, parked)* — surface the SEEK credit balance + burn-rate in-app (the balance is readable from SEEK's usage page; searches are credit-free, so the meter tracks profile-reveal spend). Awaiting go-ahead on depth.

*Priority order is the operator's call; A unblocks the most future work.*

---

## 4. Running costs per month

| Item | Cost / month | Basis |
|---|---|---|
| **Claude API (Anthropic)** | **~$15–40** | Mostly cheap Haiku (parsing, snippet scoring, insight extraction). With Sonnet scoring full profiles (~$0.05/score) cost rises with scoring volume; **hard-capped at $5/day** (≈ $150/mo ceiling) by the spend guard. Realistic steady-state ~$20–40. One-off: the talent-flywheel insight backfill (812 profiles, Haiku) cost **~$4** total. ⚠️ No fallback — if this balance hits zero, all AI stops (see constraints §2). |
| **Railway** (app + Postgres + egress) | **$25** | Hosting: always-on Next app + Postgres (5 GB volume) + bandwidth. Operator-confirmed figure. |
| **CV storage** (S3 / t3.storageapi.dev) | **~$1–3** | ~13.5k encrypted CVs (~8–12 GB est.) at S3-compatible rates + light egress. |
| **Mini-PC scraper** (electricity) | **~$3–6** | Low-power i3 mini-PC 24/7 at NZ power rates. Internet = existing home line; Tailscale = free tier. |
| **Domain** | **$0** | Railway subdomain (`*.up.railway.app`). Custom domain would add ~$1–2/mo. |
| **Platform infra subtotal** | **~$45–75 / month** | Everything RecruitMe itself costs to run (recurring). |
| | | |
| **Mini-PC hardware** (one-off) | **$150 once** | The mini-PC itself — already purchased; one-time capital cost, not recurring (≈ $4–6/mo amortised over 2–3 yrs). |
| | | |
| **SEEK Talent Search** | *operator's existing subscription* | External recruiting tool (the box logs into the operator's SEEK account). Significant but pre-existing; per-search/profile credits apply — the app is built to be credit-safe. |
| **LinkedIn** | *operator's existing account* | Scraper uses the operator's logged-in LinkedIn; no extra app cost. |

**Bottom line:** the RecruitMe *platform* runs at roughly **$45–75/month** in direct infrastructure + AI cost (plus a one-off **$150** mini-PC, already purchased), on top of the operator's existing SEEK/LinkedIn/JobAdder subscriptions. The single largest and most variable line is the Claude API, which is bounded by the daily spend cap and scales with how much scoring is done.

---

## 5. Tech-stack summary (for a developer handoff)

- **Frontend/Backend:** Next.js 15 (App Router), React 19, TypeScript, Tailwind.
- **Data:** PostgreSQL 18 + Prisma; Postgres full-text search (FTS) for the talent pool.
- **AI:** Anthropic SDK (Claude Haiku 4.5 + Sonnet 4.6); structured scoring pipeline with caching + cost tracking + spend caps.
- **Scraping:** Node/TypeScript worker on a mini-PC, Patchright (patched Chromium), one persistent session per platform; polls the app's job queue (Postgres-backed `ScrapeJob`, priority + dedup).
- **Infra:** Railway (CI real-DB gate on deploy), Tailscale (box networking), S3-compatible blob storage (encrypted CVs).
- **Repo:** GitHub `baeley-canning/RecruitMe`, deploy = push to `main`.
