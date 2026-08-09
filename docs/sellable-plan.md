# RecruitMe → Sellable

_Plan written 2026-07-28. Opinionated on purpose: decisions made, not options surveyed._

---

## Thesis

**You are not building a recruiting platform. You are selling a sourcing appliance
with a cloud brain.**

The customer buys a box that plugs into *their own* SEEK/LinkedIn subscriptions,
quietly builds *their* private candidate graph, and tells them the moment someone
in their patch moves. RecruitMe-the-website is the brain and the UI; it never
touches a customer credential.

That framing resolves three problems at once:

| Problem | How the framing solves it |
|---|---|
| **Tenancy** — one mini-PC can't serve N customers | Each customer has their own box. No shared bottleneck. |
| **Legal** — scraping with someone's credentials | It's *their* licensed SEEK/LinkedIn access, on *their* hardware, automated for them. Vastly better story than central scraping. |
| **Price** — why pay? | Hardware + setup justifies a real number, and it displaces LinkedIn Recruiter seats (~$12k/yr each). |

The decision is already 70% made in the repo — it just wasn't finished.

---

## What you already have (the part that's underrated)

- `appliance/` — packer image build, firstboot wizard, LUKS disk encryption,
  control-agent, updater, pool-sync, heartbeat. **A shippable hardware appliance.**
- `admin-portal/` — a **fleet monitor**: boxes POST heartbeats, you see fleet
  health, queue commands (restart, force re-auth), revoke a box. This is the
  BYO-box control plane, already written.
- Per-org **scraper tokens** — a box is cryptographically pinned to one org and
  can only ever touch that org's data.
- ~16k candidate library, identity merging, JobAdder archive (proprietary).
- **Pulse** — the wedge. Nobody in NZ does candidate-movement alerting.
- RBAC with default-deny on every paid action.
- Box control surface: live browser view + login launchers over Tailscale.

This is far more product than "not worth paying for" implies. What's missing is
**trust, finish, and a way to take money** — in that order.

---

## Phase 0 — Trust (2 weeks) · _do this first, it's the actual blocker_

In one day of genuinely looking we found a 9-day silent Pulse outage, a write
path that destroyed a 100k-char profile (and would have hit ~7,000 more), false
"candidate moved" alerts, and a silently-broken PDL integration. None of that is
exotic — it's the absence of verification. **A paying customer's first bad week
is a refund and a bad reference in a market of ~200 agencies.**

1. **Alerting that reaches a human.** `/api/health` already computes the truth
   (db / scraper / pulse / ai / blob / cv). Add an off-box watchdog that polls it
   and pushes to Slack/Telegram webhook on `ok:false` or `degraded` persisting
   >15 min. _(Webhook, not email — email digests are explicitly unwanted here.)_
2. **Prove the backups.** A restore drill into a scratch DB, documented, with the
   age key location written down. Untested backups are decoration.
3. **Post-deploy smoke that drives real flows** — not just `tsc` + unit tests:
   create a job, run a library search, score a candidate, assert results. Wire
   into `scripts/deploy-gate.sh`.
4. **Fix the appliance security criticals** (from `docs/CODE-AUDIT-2026-06-15.md`)
   — these are blockers for hardware leaving your house:
   - **Unsigned root-level auto-updates.** `appliance/updater/update.sh` falls
     through to "no verification" because cosign is never installed by the packer
     build. Anyone who can serve or MITM the update origin gets **root on every
     deployed box**. Install cosign in the image; sign releases; fail closed.
   - **Firstboot wizard binds `0.0.0.0:80`** with UFW open — any LAN device can
     race the installer to set admin credentials. Bind loopback + one-time
     pairing code.
   - **box-dashboard routes have no session auth**, only an IP gate parsed from a
     spoofable `X-Forwarded-For`. Add a real session check as defence-in-depth.

**Exit criteria:** an outage pages you within 15 minutes; a restore has actually
been performed; no unsigned code can run as root on a customer box.

---

## Phase 1 — Finish the appliance (3–4 weeks)

5. **Session-expiry as a first-class event.** SEEK now demands MFA on re-auth, so
   re-login is inherently human. Make that a *managed* moment: detect the circuit
   opening, alert immediately (Phase 0), and give a one-click "re-login" flow in
   the box dashboard (largely exists) plus a **proactive "session expires soon"**
   warning rather than discovering it 9 days later.
6. **Provisioning runbook, end to end:** build image → flash → ship → customer
   plugs in → firstboot pairing code → box appears in fleet monitor → they log
   into SEEK/LinkedIn once via the live view → green. Time it. It must be under
   30 minutes with no SSH.
7. **Fleet monitor productionised** — `admin-portal` gets: per-box health, last
   heartbeat, auth status per platform, remote restart, revoke, and version. You
   should be able to answer "is Acme's box healthy?" in 5 seconds.
8. **Box self-healing** — auto-restart on wedged scraper, WiFi reassoc on the
   known MCS0 stall, disk/queue watchdogs. Every support call you don't take is
   margin.

**Exit criteria:** you can ship a box to an agency you've never met and have them
running the same day, and you can see its health remotely.

---

## Phase 2 — Delete (2 weeks) · _this is what makes the rest possible_

You cannot maintain 71k lines solo while also selling. Cut hard:

| Delete | Why | Est. |
|---|---|---|
| **Legacy `/api/jobs/[id]/search/route.ts`** (1,627 lines) | ⚠️ **NOT yet deletable — corrected 2026-07-28.** An earlier claim here that it had "no UI references" was wrong (the grep missed the template-literal form). `saved-searches-card.tsx:117` still POSTs to it, and `org-isolation.test.ts` imports its GET. **Prerequisite:** migrate Saved Searches onto `/search/multi` first, then delete. | 1,600 lines, gated |
| **`SearchSession` model** | Two parallel result models (the plan's P0). Bigger than first scoped: **10+ files** read it (dashboard, search-quality, maintenance, talent-pool, search-funnel, library, search-sessions). Consolidate onto `SearchRun` in that order, deleting the model last | ~300 lines + schema |
| **Electron shell** | A web app doesn't need a desktop wrapper. Zero customer asked for it; it's a build target, a security surface, and a maintenance tax | whole `electron/` |
| **Ollama offload remnants** | `LLAMA_SCORE_OFFLOAD` is gone; `OLLAMA_OFFLOAD_TASKS` is a half-path. Either commit or cut | ~200 lines |
| **SerpAPI / Bing provider code** | Dead since the scraper replaced SERP | ~300 lines |
| **CRM (clients / placements)** | **Decide:** it's flag-gated and half-built. Either it's part of the pitch (then finish it) or it's a distraction (then cut it). Do not ship it half-done — a broken tab costs more trust than a missing one | either way |

Also: break up `jobs/[id]/page.tsx` (2,610 lines) and `candidate-card.tsx`
(1,936). Not vanity — every bug today took longer to find because of them.

**Exit criteria:** one search model, one result model, ~8–10k fewer lines, and a
codebase you can still reason about in six months.

---

## Phase 3 — Take money (2 weeks)

9. **Stripe**: plans, checkout, billing portal, dunning. Metering rides on the
   `UsageEvent` table you already write to.
10. **Plan enforcement** reuses the RBAC capability layer already shipped —
    capabilities become plan-derived as well as owner-granted, so an over-quota
    org degrades gracefully instead of erroring.
11. **Self-serve org creation + box pairing** (signup is invite-only today).
12. **Trial** — 14 days on library + PDL only (no box), so a prospect can feel it
    before hardware ships.

### Packaging (proposed)

| | |
|---|---|
| **Appliance** | $1,500 one-off, or $150/mo rental (includes replacement) |
| **Platform** | $499/mo per agency, up to 3 seats; +$99/seat |
| **Pulse** | included — it's the hook, not an upsell |
| **AI scoring / enrichment** | metered credits above a monthly allowance |

Anchor: one LinkedIn Recruiter seat is ~$12k/yr. You're asking ~$6k/yr for the
agency and displacing search time across the whole team.

---

## Phase 4 — Make the value undeniable (ongoing, start now)

13. **Be customer zero for a month.** Track: candidates surfaced you wouldn't
    have found, Pulse alerts → real conversations, placements influenced, hours
    saved. If you can't produce that number, no prospect will feel it — and if
    you can, it's simultaneously your pitch, your pricing justification, and your
    reliability soak test.
14. **Lead with Pulse.** It's the daily habit. Make it the landing surface, not a
    side tab. "Three people in your patch updated their CV this week" is the
    email-free notification that brings someone back every morning.
15. **A value dashboard the customer sees** — not vanity metrics, but "RecruitMe
    surfaced 214 candidates and flagged 37 movers this month."

---

## Explicitly NOT doing

- **Not becoming an ATS.** You lose to JobAdder/Bullhorn on depth and it's not
  where the differentiation is. Integrate, don't replace.
- **Not sending email** (outreach delivery, Pulse digests). Generation yes,
  delivery no — deliverability is a business in itself.
- **Not central scraping at scale.** That's the legal cliff. The box model exists
  precisely to avoid it.
- **Not multi-region / not a mobile app / not white-label** until there are ten
  paying agencies asking.

---

## Risks worth naming

1. **Pulse is the wedge *and* the fragile part.** It depends on SEEK Talent
   Search access that now enforces MFA. Mitigation: managed re-auth (Phase 1),
   proactive expiry alerts, and honest positioning — "assisted", not "unattended".
2. **Legal.** Even on BYO-box, automating a SEEK/LinkedIn session may breach ToS.
   A lawyer must scope this *before* the first paid customer, against the
   appliance model specifically.
3. **Support load.** Hardware in the wild. Phase 1's self-healing and fleet
   monitor are what keep this from eating every week.
4. **Solo maintainer.** Phase 2's deletions are not optional — they're the
   difference between shipping and drowning.

---

## Sequence

```
Weeks 1–2   Phase 0  Trust        (alerting, backups, smoke, appliance security)
Weeks 3–6   Phase 1  Appliance    (provisioning, fleet, self-heal, re-auth UX)
Weeks 5–6   Phase 2  Delete       (overlaps Phase 1 — cutting while building)
Weeks 7–8   Phase 3  Money        (Stripe, plans, self-serve, trial)
Ongoing     Phase 4  Value        (start being customer zero in week 1)
```

**~8 weeks to a product you can sell to an agency that isn't you** — and
essentially none of it is new features.

## Start here

Phase 0, items 1–3: alerting, a proven restore, and a real smoke gate. All code,
zero spend, and each one directly prevents a class of failure that actually
happened this week.
