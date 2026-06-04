# RecruitMe — Project Scope, Current State & Running Costs

*Prepared 2026-06-04. Figures from live production data where measured; estimates flagged.*

---

## 1. What it is

RecruitMe is a recruiter-facing SaaS that sources, scores, and manages candidates for open roles. A recruiter creates a **job** (pastes a JD → AI parses it into structured must-haves / nice-to-haves / seniority / location / salary), then **finds candidates** from three sources — an internal **talent pool** (~15k profiles), **LinkedIn**, and **SEEK Talent Search** — and the system **AI-scores** each candidate against the role, producing a ranked shortlist with a written rationale per candidate.

Multi-tenant (org-scoped), single primary operator today. Deployed on Railway; live discovery runs through a self-hosted mini-PC scraper.

---

## 2. Current state (what's built & working)

**Scale (live):** 14,961 candidates · 808 AI-scored · ~13,500 with CVs stored (encrypted at rest) · 9 active jobs.

### Tech stack
- **App:** Next.js 15 / React 19 / TypeScript, Prisma ORM, PostgreSQL 18 — hosted on **Railway** (auto-deploy from GitHub `main`).
- **AI:** Anthropic Claude — **Haiku 4.5** for parsing & snippet scoring (cheap), **Sonnet 4.6** for full-profile scoring (quality). Cost-tracked per call with a daily spend cap.
- **Scraper:** self-hosted mini-PC ("the box") running a persistent logged-in browser (Patchright) for LinkedIn + SEEK; reached over Tailscale. Single-worker by design (ban-avoidance).
- **Storage:** CVs in an S3-compatible bucket (`t3.storageapi.dev`), **AES-256-GCM encrypted at rest**, original sender format preserved.

### Features shipped & working
- **JD analysis** — Claude parses a pasted JD into structured requirements + search expansion + title variants.
- **Multi-source candidate search** — internal pool (Postgres full-text + AI ranking), live LinkedIn scrape, live SEEK Talent Search scrape. Library-first (cheap pool results instant; live sources on demand).
- **AI scoring** — per-candidate match score (0–100) with must-have coverage, category breakdown, and a recruiter summary; provisional (snippet) vs full-profile scoring; per-org configurable weights; cached so unchanged candidates aren't re-billed.
- **SEEK Talent Search** — now ingests result cards as candidates (credit-safe: harvests free card data, no per-profile credit spend). *Validated 2026-06-04.*
- **LinkedIn discovery** — NZ-constrained search → profiles scraped → ingested + scored.
- **Talent pool / flywheel** — every search enriches the pool; future searches serve those candidates instantly.
- **Candidate management** — library, per-job pipelines (shortlist/contacted/etc.), CV upload + text extraction, identity dedup across sources (LinkedIn / SEEK / JobAdder), screening data, recruiter notes, CSV export.
- **CV handling** — extraction from PDF/Word/RTF, encryption at rest, original-format preservation.
- **Ops** — on-box health dashboard (CPU/RAM/disk/temp, scraper status), cost attribution + daily spend cap, PII redaction on the seller heartbeat, CI real-DB test gate, error reporting.
- **Live JobAdder feed** — the operator's JobAdder candidate data (~13k profiles) is available live and on demand, drawn from the operator's own JobAdder account, and kept current in the platform.

### Known constraints / debt
- **Two parallel search systems** (legacy job-search vs newer multi-source) not yet unified — see roadmap §3.
- SEEK candidates are **snippet-level** (name/role/company/location); full-profile enrichment is a separate, credit-gated action (scraper exists, not auto-fired).
- ~14k candidates, **808 scored** — large unscored backlog (scoring is on-demand + cost-capped).
- Single scraper worker (no redundancy); the box must stay online for live discovery.
- Scraper still authenticates via a shared secret (org-binding token cutover incomplete).

---

## 3. Future implementations (roadmap)

**A. Search architecture consolidation** *(planned, documented in `docs/search-architecture-plan.md`)* — collapse the two parallel search systems into one **federated dispatcher + pluggable source adapters** (pool/LinkedIn/SEEK/+future), one durable result model, and a **live-streaming results UI** (results appear as they're scraped). Makes adding a new source trivial and removes the current fragility. ~6 phases, each independently shippable.

**B. SEEK full-profile enrichment** — one-click, credit-aware deep-fetch of a chosen SEEK candidate's full profile (the scraper exists; needs wiring + a credit guard).

**C. Scoring at scale** — score the unscored backlog; background/batch scoring; richer re-score-on-change.

**D. Talent flywheel — later phases** — background discovery that continuously enriches the pool (cost-gated); profile freshness / re-fetch of stale profiles.

**E. Candidate UX polish** — already largely shipped (email/screening/file-count surfacing, import-batch grouping, source badges); remaining refinements.

**F. Hardening** — complete the scraper org-binding token cutover; multi-worker / redundancy if scrape volume grows; observability.

*Priority order is the operator's call; A unblocks the most future work.*

---

## 4. Running costs per month

| Item | Cost / month | Basis |
|---|---|---|
| **Claude API (Anthropic)** | **~$15–40** | Measured **$13.37 over the last 30 days** (865 calls, ~3.7M tokens) — but that was mostly cheap Haiku. With Sonnet now scoring full profiles (~$0.05/score) cost rises with scoring volume; **hard-capped at $5/day** (≈ $150/mo ceiling) by the spend guard. Realistic steady-state ~$20–40. |
| **Railway** (app + Postgres + egress) | **~$15–25** | Hobby plan ($5 base + metered usage): always-on Next app + Postgres (5 GB volume, ~1 GB used) + bandwidth. Estimate. |
| **CV storage** (S3 / t3.storageapi.dev) | **~$1–3** | ~13.5k encrypted CVs (~8–12 GB est.) at S3-compatible rates + light egress. |
| **Mini-PC scraper** (electricity) | **~$3–6** | Low-power i3 mini-PC 24/7 at NZ power rates. Internet = existing home line; Tailscale = free tier. |
| **Domain** | **$0** | Railway subdomain (`*.up.railway.app`). Custom domain would add ~$1–2/mo. |
| **Platform infra subtotal** | **~$35–65 / month** | Everything RecruitMe itself costs to run. |
| | | |
| **SEEK Talent Search** | *operator's existing subscription* | External recruiting tool (the box logs into the operator's SEEK account). Significant but pre-existing; per-search/profile credits apply — the app is built to be credit-safe. |
| **LinkedIn** | *operator's existing account* | Scraper uses the operator's logged-in LinkedIn; no extra app cost. |

**Bottom line:** the RecruitMe *platform* runs at roughly **$35–65/month** in direct infrastructure + AI cost, on top of the operator's existing SEEK/LinkedIn subscriptions. The single largest and most variable line is the Claude API, which is bounded by the daily spend cap and scales with how much scoring is done.

---

## 5. Tech-stack summary (for a developer handoff)

- **Frontend/Backend:** Next.js 15 (App Router), React 19, TypeScript, Tailwind.
- **Data:** PostgreSQL 18 + Prisma; Postgres full-text search (FTS) for the talent pool.
- **AI:** Anthropic SDK (Claude Haiku 4.5 + Sonnet 4.6); structured scoring pipeline with caching + cost tracking + spend caps.
- **Scraping:** Node/TypeScript worker on a mini-PC, Patchright (patched Chromium), one persistent session per platform; polls the app's job queue (Postgres-backed `ScrapeJob`, priority + dedup).
- **Infra:** Railway (CI real-DB gate on deploy), Tailscale (box networking), S3-compatible blob storage (encrypted CVs).
- **Repo:** GitHub `baeley-canning/RecruitMe`, deploy = push to `main`.
