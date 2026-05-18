# RecruitMe — State of the App & Roadmap

_Last updated: May 2026_

---

## What's Working Well

The core workflow is solid end-to-end:

- **JD parsing** → structured brief (Sonnet), must-haves, nice-to-haves, salary, location, seniority, skill notes, AI-generated `anchor_terms`
- **Candidate search** via SerpAPI / Bing / PDL with unified signal matching, AI-driven specialist anchors, word-boundary matching, no-location penalty for non-remote roles
- **AI scoring** — 6-category breakdown, must-have coverage with importance weighting (including `likely_historical`), acceptance prediction, per-org configurable weights, full Sonnet model
- **LinkedIn capture** — browser extension auto-captures + fetches `/details/experience/`, `/details/skills/`, `/details/certifications/`, `/details/education/` for full profile data
- **Talent pool** — cross-job profile reuse, freshness checks, similarity detection
- **Pipeline** — full status lifecycle (new → shortlisted → offer → hired/declined)
- **Outreach & docs** — personalised LinkedIn messages, rejection emails, offer letters, reference checks, candidate profile documents
- **Multi-tenancy** — orgs, per-org rate limits and scoring weights, owner admin panel
- **Scoring settings** — editable radar chart UI at /settings, per-org, wired through all scoring paths
- **Re-analyse diff** — shows what changed between JD parses (must-haves, anchors, title, salary)
- **Stale score indicator** — amber dot on score badge when profile updated since last score
- **Sentry** — error tracking wired (activate with `NEXT_PUBLIC_SENTRY_DSN` env var)
- **Reliability** — 90s AI timeout, retry with exponential backoff on rate limits, streaming score-all progress

---

## Outstanding Items

### Waiting on External

**JobAdder integration** _(credentials applied for)_
Priority once API access arrives:
- Pull jobs from JobAdder into RecruitMe
- Push shortlisted candidates back with score + notes
- Webhook for status sync

### Short-term (days)

**SEEK Hirer API**
Pull applicants from SEEK job postings directly into RecruitMe, auto-score on import. Most impactful NZ-specific integration after JobAdder.

**Admin analytics dashboard**
Owner-only view: searches per org per day, AI calls, profiles captured, score distributions. All usage events are recorded — just never surfaced.

**Gmail / Outlook OAuth**
Send outreach emails directly from the app. Currently copy-paste only.

### Maintenance / Debt

- **Brute-force login protection is in-memory** — resets on server restart. Move to DB for multi-instance resilience.
- **CandidateFile stores base64 in Postgres** — fine now, needs S3/R2 migration before large CV volumes.
- **Server-side LinkedIn scraper** — uses hardcoded HTML selectors that break when LinkedIn updates. No health check exists.

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
| JobAdder | Applied, waiting | Very high |
| SEEK Hirer API | Not started | High |
| LinkedIn (official API) | Don't bother | Low — too locked down |
| Gmail / Outlook | Not started | Medium |
| Sentry | Installed, needs DSN env var | Active now |
