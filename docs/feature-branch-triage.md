# Feature-branch triage — `claude/review-recruitment-deployment-Hxuem`

~10k lines / ~11 new Prisma models beyond `main`, mostly ungated. `main` already
cherry-picked the scraper backend from it. This doc stages the rest into
independently-shippable slices, ordered safest-first. Each stage is a separate
green-light.

## Invariants for every stage
- **Feature flag defaults OFF** — merging never changes prod behavior until the
  flag is flipped in Railway.
- **New `@@unique` constraints are created in `scripts/apply-schema-changes.mjs`
  (raw SQL, Prisma's exact index name), NEVER left to `prisma db push`** — db
  push refuses to add a unique constraint without `--accept-data-loss`, which
  the startup script doesn't pass. That's what took prod down on 2026-05-29.
- **Additive schema only** (nullable columns, new tables; no drops/renames).
- **No module-load crashes on missing env vars** — guard Stripe/Resend calls so
  a missing key degrades gracefully instead of throwing at startup/healthcheck.
- **Verify before push**: `tsc --noEmit`, `next lint`, `vitest run`, then watch
  the Railway deploy go green.

## Stages

### Stage 1 — Clients / Submissions / Placements (CRM) — LOW RISK, HIGH VALUE
- Models: `Client`, `Submission`, `Placement` (additive).
- Pages: `/clients`, `/clients/[id]`, `/placements`, `submit-to-client-modal`.
- External needs: none. Flag: `FEATURES_CRM_ENABLED`.
- The dashboard already anticipates a `placements` shape. Do first.

### Stage 2 — Reminders + Candidate Tags — LOW RISK
- Models: `Reminder`, `CandidateTag`, `CandidateTagAssignment` (`@@unique([orgId,label])` → migration script).
- Dashboard already renders a "reminders due today" banner.
- External needs: none. Flag: `FEATURES_REMINDERS_ENABLED`.

### Stage 3 — Email infra (Resend) — ENABLER, DORMANT
- New dep `resend`; env `RESEND_API_KEY`. Guard all sends so missing key = no-op.
- Ships dormant; user adds the key to activate.

### Stage 4 — White-label theming — MEDIUM
- `/settings/white-label`, `white-label-styles.tsx`. Flag: `FEATURES_WHITE_LABEL_ENABLED`.
- Relevant before the 2nd-org onboarding.

### Stage 5 — Billing / Subscriptions (Stripe) — HIGH RISK, EXTERNAL
- `Subscription` model; env `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_GROWTH`, `STRIPE_PRICE_AGENCY`.
- Webhook handler crashes without keys → must be guarded + flag-gated.
- Needs a real Stripe account + test-mode validation. Its own mini-project.

### Stage 6 — Smart layer: NLP + Archetypes + Market-trends + Placement-predictor — EXPERIMENTAL
- Models: `Archetype`, `ArchetypePlacement`, `CandidateFingerprint`.
- Libs: `tfidf`, `skills-graph`, `career-signals`, `ai-router`, archetype clustering, market-trends, placement-predictor.
- Some call AI (cost) + auto-run. Gate each; validate cost/behavior before enabling.

## Reconcile or DROP (do not merge)
- `ApiKey` model + `api-keys.ts` — a third scraper-auth mechanism. Main uses
  `SCRAPER_SECRET` (header) + `ScraperApiToken` (bearer). Redundant.
- `/register` self-serve signup — security/tenancy review required before exposure.
- A merge must KEEP main's `ScraperApiToken` model (the branch deleted it).

## Known conflicts with current main (from the scraper/SEEK work)
`prisma/schema.prisma`, `src/lib/feature-flags.ts`, `src/lib/identity-merge.ts`,
`src/lib/scraper-ingestion.ts`, `tsconfig.json`. Per-stage cherry-picking
sidesteps most of these.
