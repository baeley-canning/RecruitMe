# RecruitMe — Profile-Update Alerts (SEEK CV-update watcher)

*Draft for review — 2026-06-16. Owner-requested feature. No code written yet; this is the plan to take to the boss.*

---

## 1. The idea (plain version)

A recruiter sets up a **watched search** — a boolean, a location, and a *"notify me about updates from this date"* cutoff — and RecruitMe quietly re-runs it on a chosen schedule. Whenever someone **matching that boolean updates their CV on SEEK** (new role, refreshed profile) on/after the cutoff, it shows up in a **live feed** in the app and pings the reminders bell. The recruiter never has to go digging — the fresh, relevant updates come to them.

The win for a recruiter: an updated CV is a buy-signal (someone tidying their profile is often quietly looking). Being first to a candidate who just refreshed their profile is real edge.

---

## 2. Why this is cheap and genuinely feasible

Confirmed against SEEK's live Talent Search UI (placeMe IT account) **and** the existing scraper code — every piece we need is already there:

- **SEEK exposes exactly the right controls.** Talent Search has a **"Last updated" filter** (left sidebar) and a **"Date updated" sort** (Relevance / Date updated + Relevance / Date updated / Date created), and **every result card shows an "Updated … ago" line**. So "recently-updated, matching this boolean" is a first-class query on SEEK.
- **It's credit-free.** We only *harvest result cards* (name / headline / location / SEEK profile URL) — never auto-open a profile. SEEK card listing costs **zero credits**; only opening a full profile spends them, and we don't do that automatically. (`scraper-worker/src/index.ts:391-396, 424-427`)
- **We reuse almost everything.** The SEEK search-form scraper, the `SavedSearch` model, the credit-safe card harvest, the search-run result storage, the reminders bell, and the box-dashboard's terminal UI style all already exist. The genuinely new pieces are small (a scheduler, a couple of scraper tweaks, the feed UI).
- **No LinkedIn ban problem.** This rides SEEK's *search* (which we're licensed to use and which is credit-safe), not repeated LinkedIn profile views. LinkedIn is deferred (its cards carry no update-date; see §10).

---

## 3. What the recruiter configures (a "watched search")

One small setup form — the boolean and its companions together:

| Field | Meaning |
|---|---|
| **Boolean query** | e.g. `.net AND (senior OR lead)` — the existing boolean box, AND/OR/NOT supported. |
| **Location** | SEEK region (the autocomplete we already drive), or "All NZ". |
| **Notify from** | A date. We only alert on candidates updated **on/after** this date. Defaults to *today* ("watch from now on"); **backdatable** to catch recent updates (e.g. last 30 days). Absolute cutoff by default. |
| **Run every** | The check interval — fully settable per watch: **45 min, 3 hours, twice a day, daily, etc.** Some watches are hot, some are "whenever". |
| **On / off** | Pause a watch without deleting it. |

A watch can be seeded from an existing saved search ("watch this search") or created fresh.

---

## 4. How it runs (the mechanism)

Each time a watch is due:
1. Enqueue a **credit-free SEEK search** = boolean + location + **"Last updated" filter** (set to the coarsest window covering the "notify from" date) + **sort = Date updated**.
2. Harvest the result cards (name / headline / location / SEEK profile URL / **"Updated X ago"**).
3. **Threshold precisely** against the watch's "notify from" date using each card's update value — so the chosen date is honoured exactly even though SEEK's filter buckets are coarse (day/week/month).
4. **Diff against what we've already flagged** for this watch (by SEEK profile ID). Anyone new → a feed entry + a bell ping. We flag a person **once per update**, never repeatedly while they sit inside the window.
5. Stamp `lastRunAt`; schedule the next run per the interval.

Cost per run: **$0 credits** (card harvest only). No profile opens, no AI required (no scoring unless the recruiter chooses to act on a hit).

---

## 5. The live feed (the "live feeling")

A **terminal-style live feed** — reusing the box-dashboard's mono aesthetic — that streams update-hits as they land. Each row:

```
14:02  ●  Ronald Peralta — Senior .Net Developer @ Westpac · Auckland, NZ
          updated 2h ago · watch: ".net AND senior" · [open ↗]
13:47  ●  xiaoya zhao — .Net Developer @ Tomahawk · Auckland, NZ
          updated today · watch: ".net AND senior" · [open ↗]
```

- **Live-updating** (Server-Sent Events, same pattern the box-dashboard already uses) so new hits appear without a refresh — the "live" feel.
- **`[open ↗]` links the person.** If we already have them in RecruitMe (matched by SEEK URL), it links to their in-app candidate page (free, richer). Otherwise it deep-links to their SEEK profile — note that *opening it on SEEK* is a normal, credit-costing recruiter action on SEEK's side (their choice, identical to using SEEK directly); we never auto-open.
- Filter the feed by watch; mark items seen.
- The **reminders bell** also gets a compact "N new profile updates" so it's caught even if the feed isn't open. In-app only — no email (none exists, and a single in-office operator lives in the app).

---

## 6. Architecture — reuse vs. new

**Reuse (already in the codebase):**
- `SavedSearch` model + saved-search routes (`prisma/schema.prisma:596-613`).
- SEEK search scraper, form-submit + card harvest (`scraper-worker/src/scrapers/seek-search.ts`).
- Credit-safe SEEK branch — harvest, never auto-open (`scraper-worker/src/index.ts:391-427`).
- `enqueueSearchJob` with in-flight dedupe (`src/lib/scrape-queue.ts:74-143`).
- Search-run result storage to diff against (`src/lib/search-run.ts`).
- Reminders bell for the ping (`src/components/reminders/reminder-bell.tsx`).
- SSE + terminal UI pattern (`src/app/box-dashboard/page.tsx`, `/api/box-dashboard/stream`).
- Cron-secret route pattern to copy (`src/app/api/admin/search-runs/sweep/route.ts`).

**New (small, well-scoped):**
1. **Watch state** — extend `SavedSearch` (or a `WatchedSearch` table) with `watched`, `notifyFrom` (date), `intervalMinutes`, `lastRunAt`, `nextRunAfter`, `active`, plus a `flaggedProfileIds` set (or a small `ProfileUpdateHit` table — preferred, it doubles as the feed's data + dedupe ledger).
2. **Scraper tweaks (3):** select the **Date-updated** sort; apply the **Last-updated** filter; **parse the "Updated X ago"** line off each card (today we read only name/headline/location).
3. **Scheduler** — the one genuinely new bit of infra (no cron exists today): a cron-secret route `POST /api/watches/run-due` that picks watches whose `nextRunAfter < now`, enqueues their SEEK search under a **dedicated monitoring cap**, and reschedules them. Driven by a Railway scheduled job (or a box timer).
4. **Hit detection + feed** — after a watch's search completes, threshold by date, diff by profile ID, write `ProfileUpdateHit` rows, emit to the SSE feed + bell.
5. **UI** — the watched-search setup form + the live feed page. Flag-gated (`FEATURES_PROFILE_WATCH_ENABLED`, default off; depends on reminders being on).

---

## 7. Cost & cadence guardrails

- **Credits:** $0 — card harvest only.
- **Scrape budget:** SEEK + LinkedIn searches share one daily cap (default 200). A watch at "every 45 min" = ~32 runs/day; a few hot watches could eat the budget and starve discovery. **Mitigation:** a dedicated *monitoring* sub-cap (e.g. ≤40 watch-runs/day, env-configurable) separate from discovery, and a sane floor on the interval (e.g. min 30 min). Per-watch dedupe means re-runs are cheap and idempotent.
- **AI:** none, unless the recruiter chooses to score/enrich a hit (their deliberate, capped action).
- **Ban risk:** low — it's the same credit-safe SEEK search we already run, just on a timer.

---

## 8. Phased build (each flag-gated, smallest-valuable-first)

- **Phase 1 — Watch config + manual "Check now".** Add the watch fields + the 3 scraper tweaks (Date-updated sort, Last-updated filter, parse the update line). A "Check now" button runs the search and lists new-since-`notifyFrom`. No automation yet. Proves the mechanism + signal quality at ~zero cost/risk.
- **Phase 2 — The live feed + bell ping.** `ProfileUpdateHit` rows, the SSE terminal feed, profile links, dedupe, bell badge.
- **Phase 3 — The scheduler.** The cron route + monitoring cap + per-watch interval, so it's truly "set and forget".
- **Phase 4 (optional) — Polish.** Per-watch feed filters, "seen/snooze", a dashboard widget, and (later, if its UI allows) a LinkedIn equivalent.

---

## 9. Open decisions / suggested defaults

1. **"Notify from" semantics** — absolute cutoff ("from Jun 16 onward") *(recommended, matches the ask)* vs. rolling window ("last N days"). Easy to offer both; default absolute.
2. **Min interval / monitoring cap** — suggest **min 30 min**, **≤40 watch-runs/day** shared across all watches, configurable. Protects discovery.
3. **Feed vs. bell emphasis** — both, but is the live feed a full page (`/updates`), a panel on the dashboard, or both? (Recommend a dedicated page + a bell badge.)
4. **Link target** — in-app candidate page when we already hold them, else deep-link to SEEK *(recommended)*.
5. **Scheduler host** — Railway scheduled job vs. a box systemd timer hitting the cron route. (Either; Railway is simpler and always-on.)

---

## 10. Out of scope / honest limits

- **LinkedIn** — deferred. Its search cards carry no update-date, and detecting an update means re-viewing profiles (credit/ban exposure). Revisit only if LinkedIn's UI offers a SEEK-style recency filter.
- **Email/push** — not built (no mail infra); in-app feed + bell only. Fine for a single in-office operator; revisit if the team grows or wants off-hours alerts.
- **"Updated" ≠ "actively job-hunting"** — a CV refresh is a strong-ish signal, not a guarantee. SEEK's separate **"Approachable"** filter (open to opportunities) could be layered in later for higher precision.
- **Coarse SEEK filter buckets** — SEEK's "Last updated" windows are day/week/month; we get exactness by thresholding on the per-card date ourselves, so this is handled, not a limit.

---

**Bottom line:** cheap (credit-free), low-risk (rides the licensed, credit-safe SEEK search we already run), and mostly assembled from parts RecruitMe already has. The only real new infra is a small scheduler. Phases 1–2 deliver the visible value (configure a watch → see updates stream into a live feed) before we automate in Phase 3.
