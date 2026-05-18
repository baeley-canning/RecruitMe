# Scoring Pipeline

How a candidate's match score is produced, end-to-end.

## Files

| File | Role |
|------|------|
| `scoring.ts` | Pure math — weights, point tables, caps, confidence |
| `ai.ts` → `scoreCandidateStructured()` | Claude Sonnet call that populates all inputs |
| `score-utils.ts` → `applyLocationFitOverride()` | Post-processing: location fit override |
| `scoring-config.ts` | Per-org weight storage and normalisation |

## Flow

```
profileText + parsedRole + salary + weights
       │
       ▼
scoreCandidateStructured()          ← Sonnet (ai.ts)
       │
       │  Produces for each must-have:
       │    status: confirmed | equivalent | likely | likely_historical | missing | negative | unknown
       │    evidence: direct quote or "Not mentioned"
       │
       │  Produces 6 category scores (0–100):
       │    skill_fit, location_fit, seniority_fit, title_fit, domain_fit, nice_to_have_fit
       │
       ▼
buildScoreBreakdown()               ← pure fn (scoring.ts)
       │
       │  computeMustHavePct()  — weighted average of must-have coverage
       │    Weights: C++ = 1.5×, security clearance = 1.5×, general skills = 1.0×
       │    Points by quality:
       │      confirmed      → full=100  snippet=100  minimal=100
       │      equivalent     → full=100  snippet=85   minimal=70
       │      likely         → full=65   snippet=55   minimal=45
       │      likely_historical → full=35 snippet=25  minimal=20  (skill is real but not current)
       │      missing        → full=0    snippet=5    minimal=0
       │      negative       → 0 always
       │      unknown        → full=0    snippet=30   minimal=10
       │
       │  computeOverallScore() — weighted sum
       │    must_have_pct × 0.36  (configurable per org)
       │    skill_fit     × 0.22
       │    seniority_fit × 0.10
       │    domain_fit    × 0.10
       │    location_fit  × 0.08
       │    title_fit     × 0.08
       │    nice_to_have  × 0.06
       │
       │  Data quality caps:
       │    snippet (<500 chars)   → cap 54
       │    snippet (500+ chars)   → cap 65
       │    minimal                → cap 40
       │    full profile           → no cap
       │
       │  Critical gate — compounds per unconfirmed 1.5× must-have:
       │    snippet: 1 unconfirmed → cap 45; 2 → 37; 3 → 29; 4+ → 20
       │    full profile: any confirmed-missing 1.5× must-have → cap 50
       │
       │  Cap is surfaced in reasons_against when applied
       │
       ▼
applyLocationFitOverride()          ← pure fn (score-utils.ts)
       │
       │  Overrides location_fit score based on known NZ city distances
       │  Applies a multiplier penalty for overseas/wrong-city on non-remote roles
       │  Snippet cap is respected: location override cannot boost a snippet above
       │  its pre-override overall score
       │
       ▼
Final ScoreBreakdown stored on candidate
```

## Provisional (snippet) scoring

When only a LinkedIn snippet is available (pre-fetch), `buildProvisionalSearchScore()`
in `search/route.ts` runs instead of the full AI scoring. It:

- Maps signal matches to `"likely"` (found) or `"missing"` (not found in snippet)
- Work-rights requirements use `"unknown"` if not NZ-based (genuine uncertainty)
- Applies the same point tables and caps as the full scorer
- Score is labeled "provisional" in `recruiter_summary`

## Configurable weights

Each org can customise the 7 dimension weights at `/settings`.
Stored in the `Setting` table as `SCORING_WEIGHTS_V1:{orgId}`.
Changes take effect on next re-score — existing scores use the weights active when scored.
