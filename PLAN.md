# RecruitMe — State of the App & Roadmap

_Last updated: June 2026_

---

## What's Working Well

The core workflow is solid end-to-end:

- **JD parsing** → structured brief (Sonnet), must-haves, nice-to-haves, salary, location, seniority, skill notes, AI-generated `anchor_terms`
- **Candidate search** — local talent-library boolean FTS (Postgres `to_tsquery`, GIN-indexed) + live LinkedIn/SEEK discovery via the self-hosted scraper worker (the SERP replacement, `SCRAPER_DISCOVERY_ENABLED`); PDL for optional enrichment. Unified signal matching, AI-driven specialist anchors, word-boundary matching, no-location penalty for non-remote roles. (Legacy SerpAPI/Bing providers remain in code but are no longer the primary path; GitHub Search was removed.)
- **Scoring** — the DEFAULT is a free, deterministic **Fit score** (keyword coverage of the job's must-haves/nice-to-haves against the candidate's stored profile/CV; no AI, shown with receipts). **AI scoring** is opt-in (Score / Re-score): a 6-category breakdown, must-have coverage with importance weighting (incl. `likely_historical`), acceptance prediction, job-level configurable weights (per-org default), Claude with a local Ollama chat-failover. When Claude is exhausted, AI scoring fails cleanly and the deterministic Fit score still works — there is NO mini-PC score queue (the box score-offload + GPT/OpenAI failover were removed).
- **LinkedIn capture** — browser extension auto-captures + fetches `/details/experience/`, `/details/skills/`, `/details/certifications/`, `/details/education/` for full profile data
- **Talent pool** — cross-job profile reuse, freshness checks, similarity detection
- **Pipeline** — full status lifecycle (new → shortlisted → offer → hired/declined)
- **Outreach & docs** — personalised LinkedIn messages, rejection emails, offer letters, reference checks, candidate profile documents
- **Multi-tenancy** — orgs, per-org rate limits and scoring weights, owner admin panel
- **Scoring settings** — editable radar chart UI at /settings sets the per-org default; individual jobs can override it (`job.scoringWeights`, resolved via `getJobScoringWeights`). Wired through all scoring paths.
- **Re-analyse diff** — shows what changed between JD parses (must-haves, anchors, title, salary)
- **Stale score indicator** — amber dot on score badge when profile updated since last score
- **Sentry** — error tracking wired (activate with `NEXT_PUBLIC_SENTRY_DSN` env var)
- **Reliability** — 90s AI timeout, retry with exponential backoff on rate limits, streaming score-all progress

---

## Outstanding Items

### JobAdder

No API access on the current JobAdder plan. Instead, JobAdder candidates are **scraped into a dedicated archive DB on the mini-PC and mirrored into RecruitMe's library** (~13.5k candidates imported). A future API tier could add push-back (shortlist → JobAdder with score + notes) + webhook status sync.

### Short-term (days)

**SEEK Hirer API**
Pull applicants from SEEK job postings directly into RecruitMe, auto-score on import. (SEEK *discovery* via the scraper already exists; this is the official applicant-pull API.)

**Admin analytics dashboard**
Owner-only view: searches per org per day, AI calls, profiles captured, score distributions. All usage events are recorded — just never surfaced.

**Gmail / Outlook OAuth**
Send outreach emails directly from the app. Currently copy-paste only.

### Maintenance / Debt

- **Brute-force login protection is in-memory** — resets on server restart. Move to DB for multi-instance resilience.
- **CandidateFile blob store** — CVs are AES-256-GCM encrypted; an S3-compatible (Cloudflare R2) offload is implemented (`BLOB_S3_*`) and **inert until configured**. Default remains encrypted base64 in Postgres; flip the env on to offload new uploads.
- **Self-hosted scraper worker** — runs on a mini-PC (LinkedIn/SEEK discovery + profile scrapes), polls Railway outbound. Uses HTML selectors that can break on LinkedIn/SEEK redesigns; `/api/health` now monitors worker liveness via stale-job detection.

---

## How the Score Is Calculated

| Dimension | Default weight |
|-----------|---------------|
| Must-have coverage | 36% |
| Skill fit | 22% |
| Seniority fit | 10% |
| Domain fit | 10% |
| Location fit | 8% |
| Title fit | 8% |
| Nice-to-have fit | 6% |

Weights are editable per-org at `/settings`. Changes take effect on next re-score.

**Critical gate:** if a 1.5× importance must-have (C++, security clearance, work rights) is confirmed missing on a full profile, the overall score is capped at 50% regardless of other dimensions.

**`likely_historical`** — new status (amber ⟳ badge) for skills that exist in past history but candidate has clearly moved to a different primary stack. Scores 35 points vs 65 for plain "likely".

---

## Integration Status

| Integration | Status | Value |
|-------------|--------|-------|
| JobAdder | No API on current plan — scraped into a separate archive DB on the mini-PC, mirrored into the library (~13.5k imported) | Active (scrape path) |
| LinkedIn / SEEK discovery | Self-hosted scraper worker (the SERP replacement) — live people search → library | Active |
| Local AI (Ollama/Llama) | Mini-PC Ollama — Claude fallback + flag-gated score-offload | Active |
| SEEK Hirer API (applicant pull) | Not started | High |
| LinkedIn (official API) | Don't bother | Low — too locked down |
| Gmail / Outlook | Not started | Medium |
| Sentry | Installed, needs DSN env var | Active now |
