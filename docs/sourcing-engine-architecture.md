# Sourcing Engine Architecture

_Draft — 2026-07-13. Direction set with Codex oversight. Supersedes the earlier
`pdl-backfill-plan.md` (the "buy a giant data provider" framing was wrong for NZ)._

---

## The shape

**Make the box the engine. Make the app make that engine visible, controllable,
and reliable. Use vendor APIs only to fill gaps the box + your library can't.**

```
┌─────────────────────────┐     ┌──────────────────────────┐     ┌───────────────────────┐
│  Mini-PC = ENGINE       │     │  RecruitMe cloud = BRAIN │     │  Vendor APIs = BACKUP │
│  (live work)            │     │  (orchestration)         │     │  (selective gap-fill) │
│                         │     │                          │     │                       │
│  LinkedIn search        │◀────│  creates jobs for box    │     │  PDL: identify/enrich │
│  SEEK search            │     │  stores results          │     │  Proxycurl: structure │
│  JobAdder scrape/import │────▶│  dedupes identities      │────▶│    a LinkedIn URL     │
│  profile capture        │     │  ranks vs roles          │     │  Apollo/ContactOut:   │
│  freshness re-checks     │     │  shows progress          │     │    contact details    │
│  watched searches/Pulse │     │  imports selected        │     │  SERP/SearXNG: find a │
│  light Ollama extract   │     │  scoring/notes/outreach  │     │    URL box missed     │
└─────────────────────────┘     └──────────────────────────┘     └───────────────────────┘
```

Why this beats a generic global platform **for NZ specifically**: candidate volume
is smaller and more scrapeable; the JobAdder archive is proprietary; SEEK/LinkedIn
*freshness* matters more than global database *size*; watched searches keep
re-running; and we enrich only the **shortlist**, not every random profile.

---

## Box queues — target vs. what exists today

Codex's flat queue names map onto the current **two-axis** model
(`ScrapeJob.kind` × `ScrapeJob.platform`, plus routing tags). Most already exist:

| Codex queue | Today | State |
|---|---|---|
| `search_linkedin` | `kind=search, platform=linkedin` | ✅ exists |
| `search_seek` | `kind=search, platform=seek` | ✅ exists |
| `fetch_linkedin_profile` | `kind=profile, platform=linkedin` | ✅ exists |
| `fetch_seek_profile` | `kind=profile, platform=seek` | ✅ exists |
| `watch_search` | `kind=search, platform=seek, requestedBy=watch:<id>, priority=50` | ✅ exists (rides on `search`) |
| `jobadder_sync` | `kind=profile, platform=jobadder` (ad-hoc harvest) | ⚠️ partial — no *scheduled/orchestrated* sync |
| `refresh_known_profile` | freshness is tracked (`profileCapturedAt`, dashboard "needs fetch" index) but **nothing re-fetches** | ❌ missing as a queue |
| `light_ai_extract` | `OLLAMA_OFFLOAD_TASKS=cv_clean,info_extract,refs_questions` runs **in-app** via Ollama chat-failover, not as a box job | ◐ different mechanism, works |

**Decision: keep the two-axis `kind × platform` model — do not flatten to 8 named
queues.** It already expresses the matrix and the priority/dedup/fairness logic in
`claimScrapeJobs` is built around it. We add the *missing kinds*, not a new
taxonomy.

### Real gaps to close (in priority order)

1. **`refresh_known_profile`** — the highest-value missing piece. We already know
   *which* library profiles are stale (`profileCapturedAt` age) but never re-fetch
   them. A new `kind=refresh` (or a scheduled enqueue of `kind=profile` for
   stale-and-known URLs, priority low/background) keeps the library fresh on its
   own — the flywheel's missing return stroke. **Library-safe by construction:**
   it re-fetches URLs we already hold and fill-only merges (same ingestion path),
   never deletes.
2. **`jobadder_sync` orchestration** — promote the ad-hoc JobAdder harvest to a
   scheduled, resumable sync with visible progress (like Pulse's scheduler).
3. **Engine visibility & control** — per-queue depth + age + last success/failure,
   and owner controls (trigger a refresh sweep, pause a queue). The Admin
   **Appliance status** card (shipped) is step one; this extends it per-queue.

---

## The result record — target vs. real fields

Codex: each result becomes `identity · source evidence · freshness · confidence ·
role match · action state`. Mapped to what exists:

| Facet | Field today | State |
|---|---|---|
| candidate identity | `CandidateIdentity` (per-org, URL-keyed) | ✅ |
| source evidence | `Candidate.source` + `CandidateIdentityAlias.source` (per contact key) | ✅ |
| freshness timestamp | `profileCapturedAt`, watch `updatedAtBucket` | ✅ |
| confidence score | — | ❌ **missing** |
| role match | `matchScore` (AI) / deterministic Fit | ✅ |
| import/action state | `Candidate.status` lifecycle | ✅ |

**One real gap: `confidence`** — how sure are we this record is (a) the right
person and (b) accurate. Cheap first version: a derived confidence from signals we
already have (has full profileText? capture recency? multiple corroborating
sources? verified contact key?) — no new scraping, just a scoring function over
existing fields, surfaced as a small badge. Vendor enrichment (below) raises it.

---

## Vendor APIs = selective backups (the corrected PDL story)

Not "pay for a giant data provider." Each vendor answers **one specific question,
on demand, on the shortlist** — never a bulk backfill of the whole library:

| Vendor | Question it answers | When we call it |
|---|---|---|
| **PDL** | "Can we identify / enrich this person?" | Shortlisted identity missing profile data |
| **Proxycurl / Coresignal** | "Can we structure this LinkedIn URL?" | Box couldn't capture a profile the recruiter needs |
| **Apollo / ContactOut / RocketReach** | "Can we find contact details?" | Shortlisted candidate with no email/phone |
| **SERP / SearXNG** | "Can we find a profile URL the box missed?" | Search came up thin; find URLs to feed the box |

**Trigger discipline:** enrichment fires on **explicit recruiter action on the
shortlist** (or a small, budgeted auto-fill on shortlisting) — never on every
profile that scrolls past. This caps spend and keeps the library the primary
source of truth.

### Library-safety invariants (apply to ALL enrichment writes)

Carried over unchanged — the moat is the existing library:

1. **Same identity anchor** — enrichment resolves through the existing
   `CandidateIdentity` find-or-create on `(orgId, linkedinUrl/seekUrl)`; updates a
   person, never duplicates.
2. **Fill-only, never clobber** — writes only currently-empty fields. Recruiter
   edits, captured `profileText`, and uploaded CVs always win. CVs never touched.
3. **Provenance-tagged + reversible** — vendor-written rows/fields tagged with
   `source` (`pdl` etc.) + an enriched-at stamp, so any batch reverts in one
   scoped delete (the `purge-jobadder-imports` pattern). No one-way doors.
4. **Idempotent + preview-first** — re-runs are no-ops; show "would enrich N,
   cost C credits" before any write.
5. **No destructive migration** — additive nullable columns only; no prod `db
   push`.

---

## Recommended build order

Each slice is independently shippable, additive, and library-safe:

1. **`refresh_known_profile`** — closes the flywheel; pure library win; zero vendor
   spend. *(Biggest bang, lowest risk.)*
2. **Engine visibility per-queue** — extend the Appliance card into a real control
   surface (per-queue depth/age/last-result; trigger a refresh sweep). Makes the
   engine "visible + controllable" per Codex.
3. **`confidence` on the result record** — derived from existing signals; surfaced
   as a badge; feeds ranking transparency.
4. **Enrichment as shortlist gap-fill** — start with PDL Person Enrichment behind a
   preview + budget, on explicit shortlist action, guarded by the invariants above.
   Proxycurl / Apollo / SERP added as separate, individually-gated tools after.

Scoring / matchScore / ranking stay untouched throughout. The box stays the
engine; vendors stay backups.
