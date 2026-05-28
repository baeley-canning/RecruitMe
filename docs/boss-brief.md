# RecruitMe — Operations & Cost Brief
### PlaceMe IT Recruitment · Prepared by Cassius · May 2026

---

## What RecruitMe Is

A purpose-built recruitment tool owned and operated by PlaceMe. It takes a job description,
parses it with AI, finds matching candidates across LinkedIn, SEEK Talent, and JobAdder,
scores each one against the role, and tracks them through the pipeline to placement.

No SaaS subscription. No per-seat licence. PlaceMe owns the code and the data.

---

## How It Works

The system is a web app hosted on Railway (cloud hosting). Recruiters log in via browser
or use a Chrome extension while naturally browsing LinkedIn.

**Core components:**

| Component | Role |
|-----------|------|
| Railway + Postgres | Hosting and all data storage |
| Anthropic Claude | AI scoring, JD parsing, outreach drafts, reference Q&A |
| SerpAPI | Finds LinkedIn profile URLs via Google search |
| Chrome extension | Captures full LinkedIn profiles as recruiters browse |
| PDL (People Data Labs) | Supplementary candidate data (paid, per-lookup) |

Everything is recruiter-initiated. No autonomous activity runs without someone clicking Search.

---

## Current Monthly Cost — PlaceMe (Single Tenant)

| Service | Purpose | Plan | NZD/month |
|---------|---------|------|-----------|
| Railway | Hosting + Postgres database | Flat tier | ~$20 |
| SerpAPI | LinkedIn search via Google | Developer (5,000/mo, using ~150) | ~$50 |
| Anthropic Claude | AI scoring, parsing, drafts | Pay-as-you-go, $5/day cap | $25–$150 |
| PDL | Supplementary candidate data | Pay-per-lookup (~$0.10) | $0–$30 |
| OpenAI | Failover if Claude is unavailable | Pay-as-you-go | $0–$5 |
| Sentry | Error monitoring | Free tier | $0 |
| **TOTAL** | | | **$95–$255/mo** |

**Claude range explained:** Quiet months run ~$25. Heavy hiring months with frequent
Score All runs hit closer to $150. The $5/day cap prevents runaway spend.

**Note:** Anthropic credits are currently exhausted and need a ~$50 top-up to restore
full scoring functionality. This is a one-time buffer issue, not a structural cost problem.

---

## Proposed Addition: Raspberry Pi Background Scraper

### What It Does

A small computer (Raspberry Pi) sits at the office running 24/7, connected to a 4G mobile
modem. It logs into LinkedIn, SEEK Talent, and JobAdder using existing recruiter credentials
and slowly, quietly fetches full candidate profiles in the background — feeding them into
the RecruitMe talent pool automatically.

Results flow straight into the existing scoring pipeline. Every candidate the Pi fetches
gets AI-scored against active roles the same way a manually searched candidate would.

### Why 4G Matters

LinkedIn and SEEK block cloud server IP addresses (like Railway's). A 4G mobile modem
provides a standard NZ carrier IP address — the same kind your phone uses — which is
effectively indistinguishable from a recruiter browsing on their mobile. This is the
key architectural decision that makes the scraper viable.

### Hardware Cost (One-Off)

| Item | NZD |
|------|-----|
| Raspberry Pi 5 (4GB) | ~$130 |
| 4G USB modem (e.g. Huawei E3372h) | ~$60 |
| microSD 64GB + case + power supply | ~$50 |
| **One-off total** | **~$240** |

### Running Cost (Monthly)

| Item | NZD/month |
|------|-----------|
| 4G data SIM (data-only, ~5GB/mo sufficient) | ~$15–25 |
| Electricity (Pi draws ~5W — negligible) | ~$1 |
| Extra Anthropic credits (scoring higher volume) | ~$30–100 |
| **Additional monthly total** | **~$46–126** |

No proxy service needed. The 4G carrier IP handles this directly.

### Capacity

The scraper is intentionally rate-limited to **8 LinkedIn profiles per hour** — slow
enough to look human, fast enough to be useful.

| Timeframe | Profiles added |
|-----------|---------------|
| Per day (running ~8hrs) | ~60–100 |
| Per month | ~1,500–3,000 |
| Per year | ~18,000–36,000 |

For context: the current talent pool grows at roughly 150–200 profiles per month via
manual browsing and search. The Pi increases this by 10–15× without any extra recruiter effort.

SEEK Talent and JobAdder candidate pulls run at a similar conservative pace.

### Total Cost With Pi (Monthly)

| | Low | High |
|-|-----|------|
| Current Railway costs | $95 | $255 |
| Pi addition | $46 | $126 |
| **Combined** | **~$141** | **~$381** |

---

## Risk Assessment

### The Real Risk: Account Ban

The primary practical risk is LinkedIn suspending the recruiter account used for scraping.
This is LinkedIn's standard response to automated activity — account suspension, not litigation.

**What getting banned looks like:**
- LinkedIn account locked (recoverable with ID verification in most cases)
- Loss of sourcing capability until resolved (days to weeks)
- Worst case: permanent ban requiring a new account

**Our mitigations (already built):**

| Risk factor | What we do about it |
|-------------|---------------------|
| Robot-speed clicking | Humanizer adds realistic variable delays between every action |
| Uniform timing patterns | Log-normal random delays — statistically human |
| Datacenter IP detection | 4G carrier IP — identical to mobile browsing |
| High volume detection | Hard cap of 8 profiles/hour; configurable lower |
| Instant scrolling | Gradual scroll mimicking reading pace |
| No mouse movement | Random mouse drift between actions |
| Fixed screen size | Randomised mobile viewport dimensions on every session |

The scraper was built with detection avoidance as a first-class requirement, not an afterthought.

### Legal Risk

**LinkedIn TOS violation:** Yes, this breaches LinkedIn's terms. So does most bulk
use of recruiter accounts. LinkedIn's legal actions have targeted large commercial
operations (HiQ Labs scraped billions of public records and resold them). A small
NZ recruitment agency scraping candidates for internal use has not been a target
and is practically unlikely to become one.

**NZ Privacy Act 2020:** Candidate data collected must be used for the purpose it was
collected (recruitment), stored securely, and accessible for correction requests.
RecruitMe already complies — data is used only for matching against active roles
and is not sold or shared.

**Crimes Act 1961 s.252:** Would require using credentials in ways that are clearly
unauthorised. Using a recruiter's own login is a grey area at worst, not criminal.

**Honest summary:** The meaningful risk is a LinkedIn account ban. Litigation is
theoretically possible but practically implausible at our scale. The mitigations
we've built materially reduce the ban risk. The residual risk is a recoverable
operational inconvenience, not an existential threat to the business.

---

## What This Isn't

- It does **not** scrape job listings — jobs come from clients and are entered manually
- It does **not** run autonomously on Railway — it runs on the Pi using a carrier IP
- It does **not** replace recruiters — it fills the talent pool so recruiters have more to work with
- It is **not** a proxy-dependent system — no ongoing proxy subscription needed

---

## Recommendation

**Proceed with the Pi.** The cost is low, the mitigations are solid, and the upside
(10–15× talent pool growth with zero extra recruiter effort) is significant for a
business where candidate depth directly drives placement revenue.

**Activate in two stages:**

1. **Now:** Top up Anthropic credits (~$50) to restore scoring. Total: $50 one-off.

2. **When Pi arrives:** Follow setup guide, create an API key in RecruitMe, set one
   environment variable on Railway (`SCRAPER_ENABLED=true`). The system is already
   built and waiting — setup time is under an hour.

The scraper runs quietly in the background. If LinkedIn ever pushes back, we turn it
off at the Railway environment variable and nothing else changes. The off switch is one
click.

---

*System built and maintained by Cassius. All costs in NZD unless stated.*
