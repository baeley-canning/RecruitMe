# RecruitMe — State of the App & Roadmap

_Last updated: May 2026_

---

## What's Working Well

The core workflow is solid end-to-end:

- **JD parsing** → structured brief with must-haves, nice-to-haves, salary, location, seniority
- **Candidate search** via SerpAPI / Bing / PDL with smart filtering and deduplication
- **AI scoring** — 6-category breakdown, must-have coverage with importance weighting, acceptance prediction
- **LinkedIn capture** — browser extension auto-captures and scores; fallback server-side scraper for public profiles
- **Talent pool** — cross-job profile reuse, freshness checks, similarity detection
- **Pipeline** — full status lifecycle (new → shortlisted → offer → hired/declined)
- **Outreach & docs** — personalised LinkedIn messages, rejection emails, offer letters, reference checks, candidate profile documents
- **Multi-tenancy** — orgs, per-org rate limits, owner admin panel
- **Scoring quality** — C++ / primary-language gate, must-have importance weighting, full-profile critical cap at 50%

---

## Current Weaknesses

### Reliability
| Issue | Impact | Effort |
|-------|--------|--------|
| Silent failures in modal actions (outreach, offer letter, rejection email) | User doesn't know it failed | Low |
| No retry/backoff on SerpAPI, Bing, or Anthropic calls | Transient errors lost permanently | Medium |
| LinkedIn server-side scraper breaks silently when structure changes | Empty profiles, 422 errors | Medium |
| AI calls have no timeout protection — long inputs can hang | Bad UX, potential hung requests | Low |
| Empty profileText passed to scoring AI without validation | Garbled/junk scores possible | Low |

### Observability
- No structured logging — errors only visible in Railway deploy logs
- No error tracking (no Sentry or equivalent)
- Usage events recorded but never surfaced to admin

### Missing UX
- Score-all has no progress indicator — big jobs appear frozen
- Candidate library has no search/filter
- Job "on-hold" status exists in the DB but no UI to use it
- No admin analytics (searches run, profiles captured, AI spend per org)

---

## Roadmap

### Tier 1 — Quick wins (1–2 days each)

**1. Fix silent modal failures**
All AI modal actions (outreach, offer letter, rejection email, reference summary) swallow errors. Add visible error states so the user knows to retry.

**2. Score-all progress indicator**
The bulk rescore endpoint runs blind. Add a simple polling mechanism or streaming response so there's a live "Scoring 12 of 29…" counter.

**3. Candidate library search**
Full-text search across name, headline, location, and profile text in the global library. Single DB query with `ILIKE`.

**4. Input validation before AI calls**
Guard `scoreCandidateStructured`, `predictAcceptance`, and `extractCandidateInfo` against empty/whitespace-only profile text before the API call fires.

**5. Timeouts on AI calls**
Wrap all `chat()` calls in `AbortSignal.timeout(30_000)` — currently a single slow request can hang indefinitely.

---

### Tier 2 — Medium effort (3–5 days each)

**6. JobAdder integration** _(waiting on credentials)_
Priority once API access arrives. Plan:
- Pull jobs from JobAdder into RecruitMe (create job from JobAdder posting)
- Push shortlisted candidates back to JobAdder pipeline with score + profile notes
- Webhook for status sync (candidate progresses in JobAdder → reflects in RecruitMe)

**7. SEEK Hirer API integration**
Most impactful after JobAdder for the NZ market:
- Pull applicants from a SEEK job posting directly into RecruitMe
- Auto-score on import — replaces manual CV-paste workflow for advertised roles
- Bidirectional: post a job to SEEK from within the app

**8. Error tracking (Sentry)**
One-line integration. Captures all unhandled exceptions, API failures, and slow requests with full context. Surfaces things that Railway logs miss.

**9. Admin analytics dashboard**
Owner-only view: searches per org per day, AI calls, profiles captured, score distributions. Currently all usage events are recorded but never shown anywhere.

**10. Retry with exponential backoff**
Wrap SerpAPI, Bing, PDL, and Anthropic calls in a shared retry helper (3 attempts, 1s/2s/4s backoff). Transient 429s and timeouts currently drop silently.

---

### Tier 3 — Bigger features (1–2 weeks each)

**11. Email integration (Gmail / Outlook OAuth)**
Send outreach emails and offer letters directly from within the app instead of copy-paste into Gmail. Track open/reply status. Would make outreach genuinely actionable rather than just template generation.

**12. Calendar / interview scheduling**
Basic Calendly-style link generation or Google Calendar integration. After shortlisting, send a scheduling link directly from the candidate card.

**13. Structured feedback loop**
When a candidate is hired or declined, capture why — feeds back into scoring calibration. Over time, the scoring model improves based on actual hire outcomes from your org's data.

**14. Bulk CSV import with auto-scoring**
Upload a spreadsheet of LinkedIn URLs → extension captures all of them in sequence → scores on completion. Useful when a client sends a long list of names.

**15. Notification layer**
Email or Slack digest: "3 new high-scoring candidates found overnight", "Profile fetch completed for X", "Reference check returned for Y". Currently everything requires actively opening the app.

---

## Integration Priorities Summary

| Integration | Status | Value | Recommendation |
|-------------|--------|-------|----------------|
| JobAdder | Applied, waiting | Very high | Build immediately on credential receipt |
| SEEK Hirer API | Not started | High | Next after JobAdder |
| LinkedIn API (official) | Not applied | Low | Don't bother — too locked down |
| Gmail / Outlook | Not started | Medium | After SEEK |
| Sentry | Not started | High | Do this week — zero risk |

---

## Tech Debt Worth Addressing

- **LinkedIn scraper selectors** are hardcoded and will silently break when LinkedIn updates their DOM. Should add a health-check endpoint that verifies the scraper returns usable data.
- **CandidateFile stores base64 in Postgres** — fine at low scale, needs S3/R2 migration before storing large volumes of CVs.
- **Brute-force protection is in-memory** — resets on server restart. Move to Redis or the DB for multi-instance resilience.
- **Test coverage** is good on scoring/search logic but thin on the AI generation functions (outreach, offer letter, etc).

---

## Bottom Line

The app is genuinely useful and production-quality for the core search → score → shortlist loop. The scoring improvements (must-have weighting, C++ gate, no rescore cache) made this week are meaningful. The next highest-value work is reliability (silent failures, timeouts, error tracking) followed by the JobAdder integration — that's the one that turns this from a standalone sourcing tool into something that slots into a recruiter's existing workflow.
