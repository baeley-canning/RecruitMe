# Market-Ready Plan

Goal: take RecruitMe from "works brilliantly for one agency" to "another agency
pays for it and succeeds without the founder in the room."

Written 2026-07-04. Current state: feature-complete for internal use (jobs, JD
parsing, pipeline, 13.7k-candidate library, LinkedIn/SEEK/JobAdder sourcing,
durable search, Pulse watches, deterministic Fit scoring + opt-in AI, CV
encryption, CRM, multi-org data model). Deployed on Railway; scraper worker on
a dedicated mini-PC.

---

## The two structural blockers (decide before building anything)

### B1. Single-account, single-box sourcing
All LinkedIn/SEEK/JobAdder scraping runs through ONE set of credentials on ONE
mini-PC on residential internet. For a second tenant this means: their searches
spend our SEEK credits, run under our LinkedIn identity, and their harvested
data flows through our hardware. Not sellable as-is.

**Options** (can be phased):
- **A. BYO-box agent (recommended):** package the scraper worker as an
  installable agent (the box already proves the model: systemd services,
  watchdogs, control-plane dashboard). Customer supplies a mini-PC/NUC + their
  own SEEK/LinkedIn/JobAdder logins. Their credentials, their credits, their
  IP, their data path. We already have per-box auth tokens partially built
  (scraper-auth supports org-bound principals).
- **B. Scraping-free tier first:** new tenants get library + CV import + manual
  add + JobAdder REST API. Scraping is a later add-on via option A. Fastest to
  market; the Fit-score + library workflow is already a complete product
  without scraping.
- **C. Hosted scraping pool:** we run per-tenant browser sessions on our infra.
  Rejected for v1 — highest legal exposure, highest ops burden, detection risk
  concentrates on our IPs.

### B2. Legal posture (needs a professional, not code)
- Selling scraping of LinkedIn/SEEK as a product feature = commercial-scale ToS
  breach; different risk class from internal use.
- Holding candidate PII for multiple companies triggers NZ Privacy Act 2020
  obligations (IPP: collection, security, access/correction, retention).
- Deliverables: ToS, Privacy Policy, customer DPA, data-retention policy,
  candidate access-request procedure. One lawyer engagement, ~week turnaround.

---

## Phase 0 — Decisions (owner, ~1 week, parallel with Phase 1 start)

| # | Decision | Recommendation |
|---|----------|----------------|
| 0.1 | First customers | Boss's agency as flagship + 2–3 friendly NZ boutique agencies as paid pilots |
| 0.2 | Sourcing model for new tenants | Option B now, option A (BYO-box) as the upsell |
| 0.3 | Pricing shape | Per-seat/month + metered AI (cost attribution per org already built) + optional BYO-box add-on |
| 0.4 | Legal engagement | Book it now; it gates public marketing, not the build |
| 0.5 | Name/brand | "RecruitMe" is heavily used elsewhere; pick a brandable name + domain before any public page |

## Phase 1 — Table stakes for a paying tenant (~2–3 weeks build)

1. **Accounts & auth**
   - Invite-based signup (org admin invites teammates), password reset,
     email verification. Transactional email only (Resend/Postmark) — auth
     mail, NOT Pulse digests (explicitly out of scope, owner decision).
   - Session hardening: rotate NEXTAUTH_SECRET handling, revoke-on-password-change,
     optional TOTP 2FA for org admins.
2. **Billing**
   - Stripe: subscription per org (seats), usage records from the existing
     per-org AI cost attribution, spend caps already enforced in-app.
   - Grace/lockout states (read-only on non-payment, never data deletion).
3. **Tenant isolation gate (trust is the product)**
   - Dedicated adversarial multi-agent review: every route/export/CV/photo/
     search/insight is org-scoped; attempt cross-org reads with minted sessions.
   - Rotate the shared SCRAPER_SECRET model to per-box org-bound tokens
     (half-built in scraper-auth; worker needs token support — currently the
     known caveat "do NOT drop SCRAPER_SECRET").
4. **Ops we can promise out loud**
   - Backups: locate/rotate the age private key (open finding from the May
     audit), automate an off-site restore TEST monthly, document RPO/RTO.
   - Move the stuck-search sweep to a Railway cron (survives box death).
   - Uptime monitoring + public-ish status page (even a simple one).
   - Finish residuals: boxdash middleware rebuild (IP-forge fix), remove stale
     localhost DATABASE_URL from box app.env.
5. **AI account hygiene**
   - Anthropic org account with billing alerts + auto-top-up floor (a credit-out
     currently downs all tenant AI at once; the deterministic-first scoring has
     already reduced the blast radius).

## Phase 2 — Onboarding without the founder (~2 weeks)

1. New-org wizard: create org → invite team → paste first JD (parse) → import
   CVs (bulk upload exists) → first Fit-scored shortlist. Target: stranger to
   scored shortlist in 15 minutes, no human help.
2. Empty states that teach (each screen's blank state explains the loop:
   JD → source → Fit score → AI re-score top N → shortlist → placement).
3. Seeded demo org (fake but realistic data) for sales demos + screenshots.
4. Help/docs site grown from the existing boss-overview PDF; short Loom-style
   walkthrough videos.
5. Data import paths: CSV candidate import; JobAdder REST for tenants who have
   API access (our own scrape-based archive stays internal-only).

## Phase 3 — Go-to-market

1. **Case study = placeMe.** Real numbers: library size, time-to-shortlist
   before/after, AI cost per hire, SEEK credit savings from card-harvest-only.
2. **Pilot offer:** 2–3 agencies, discounted, white-glove onboarding, weekly
   feedback call. Success criteria defined up front (e.g. a placement made from
   an app-sourced shortlist within 60 days).
3. **The differentiated pitch:**
   - NZ-native sourcing (SEEK-aware, NZ locations, JobAdder-friendly).
   - **Deterministic Fit scores with receipts** — every score shows exactly
     which must-haves matched; AI is an explicit, metered second opinion.
     Competitors sell "AI magic"; we sell auditable judgment + controlled cost.
   - Your data stays yours (per-org isolation, BYO sourcing credentials,
     at-rest CV encryption).
4. Simple marketing site (one page: pitch, screenshots, pilot CTA) — gated on
   0.4 legal + 0.5 name.

## Post-revenue ideas (parked deliberately)

- Client-facing shortlist export (branded PDF) — pdf lib already in the stack.
- Candidate data-request/consent tooling (will be asked by larger agencies).
- Per-org SEEK credit budget dashboard.
- Mobile/responsive polish pass.
- Reporting pack: placements funnel, source effectiveness, recruiter activity.
- Regional expansion (AU: seek.com.au host support already parameterised).

## Sequencing summary

Week 1: Phase 0 decisions + legal booked + Phase 1.4 ops items (backups/cron/residuals).
Weeks 2–3: accounts + billing + isolation gate.
Weeks 4–5: onboarding wizard + demo org + docs.
Week 6: pilot outreach with case-study numbers.

The single most important build item is the tenant-isolation gate; the single
most important non-build item is the legal/scraping decision. Everything else
is ordinary work.
