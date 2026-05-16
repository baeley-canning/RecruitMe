import { type ScoreBreakdown } from "./scoring";
import { assessLocationFit } from "./location";
import type { ScoringWeights } from "./scoring-config";

/**
 * Derive all Prisma candidate update fields from a v2 ScoreBreakdown.
 * Shared by the single-score route, score-all route, and search route.
 */
export function deriveUpdateData(breakdown: ScoreBreakdown): Record<string, unknown> {
  // matchScore is ALWAYS a number — never null. At sourcing stage the
  // recruiter is deciding who to progress to the next funnel stage (CV /
  // phone interview). They need a score even on partial LinkedIn captures
  // so they can rank candidates. The breakdown's profile_capture_warning
  // stays as informational metadata so the UI can surface "low confidence
  // — partial profile" alongside the score, not in place of it.
  return {
    matchScore:     breakdown.overall,
    scoreBreakdown: JSON.stringify(breakdown),
    // Legacy matchReason — kept for radar chart and old-format cards
    matchReason: JSON.stringify({
      summary:   breakdown.recruiter_summary,
      reasoning: breakdown.recruiter_summary,
      dimensions: {
        skills:    breakdown.categories.skill_fit.score,
        title:     breakdown.categories.title_fit.score,
        domain:    (breakdown.categories.domain_fit?.score ?? breakdown.categories.industry_fit?.score ?? 50),
        location:  breakdown.categories.location_fit.score,
        seniority: breakdown.categories.seniority_fit.score,
      },
      // v2: use grounded reasons_for/against; v1 fallback: requirement names
      strengths: breakdown.reasons_for?.length
        ? breakdown.reasons_for
        : breakdown.must_have_coverage
            .filter((c) => c.status === "confirmed" || c.status === "likely")
            .map((c) => c.requirement),
      gaps: breakdown.reasons_against?.length
        ? breakdown.reasons_against
        : breakdown.must_have_coverage
            .filter((c) => c.status === "missing" || c.status === "negative")
            .map((c) => c.requirement),
    }),
  };
}

// Default location_fit weight from scoring-config. Used to scale the
// out-of-area penalty so a recruiter who explicitly de-prioritises location
// doesn't get score-blasted by a hardcoded penalty that ignores their tuning.
const DEFAULT_LOCATION_FIT_WEIGHT = 0.08;

export function applyLocationFitOverride(
  breakdown: ScoreBreakdown,
  candidateLocation: string | null | undefined,
  targetLocation: string | null | undefined,
  locationRules?: string | null,
  isRemote?: boolean,
  weights?: ScoringWeights,
): ScoreBreakdown {
  const assessment = assessLocationFit(candidateLocation, targetLocation, locationRules);
  if (!assessment) return breakdown;

  const categories = {
    ...breakdown.categories,
    location_fit: {
      ...breakdown.categories.location_fit,
      score: assessment.score,
      evidence: assessment.evidence,
    },
  };

  const reasonsAgainst = assessment.score < 75
    ? [assessment.evidence, ...breakdown.reasons_against.filter((reason) => reason !== assessment.evidence)].slice(0, 4)
    : breakdown.reasons_against;

  const recruiterSummary = assessment.score < 45
    ? `${assessment.evidence} ${breakdown.recruiter_summary}`.trim()
    : breakdown.recruiter_summary;

  // Start from the existing breakdown.overall — preserves Claude's holistic score.
  let overall = breakdown.overall;

  // Scale the penalty severity by how much weight the recruiter put on location.
  // Default weight (0.08) → full penalty as before. Lower weight → milder; higher
  // weight → harsher. weightRatio is clamped [0.2, 2.0] so an extreme tuning
  // (location_fit=0.02 ×0.25 of default) still penalises a tiny bit, and an
  // explicit boost (0.16, 2× default) doesn't go infinite.
  const locationWeight = weights?.location_fit ?? DEFAULT_LOCATION_FIT_WEIGHT;
  const weightRatio = Math.max(0.2, Math.min(2.0, locationWeight / DEFAULT_LOCATION_FIT_WEIGHT));

  // Apply an out-of-area multiplicative penalty when the job is not remote and
  // location fit is poor. Base multiplier 0.6→1.0; weightRatio scales how much
  // of the 1−base penalty actually applies.
  if (!isRemote && assessment.score < 50) {
    const baseMultiplier = 0.6 + (assessment.score / 50) * 0.4; // 0.6..1.0
    const adjustedMultiplier = 1 - (1 - baseMultiplier) * weightRatio;
    overall = Math.max(0, Math.round(overall * adjustedMultiplier));
  }

  // Hard-cap at 50 only when location matters at default-or-higher weight.
  // Recruiters who explicitly de-prioritise location skip this cap.
  if (!isRemote && assessment.score < 50 && overall > 50 && weightRatio >= 1.0) {
    overall = 50;
  }

  // For snippet-quality data, location override must not push the score above the
  // data-quality cap that was already applied in buildScoreBreakdown.
  if (breakdown.data_quality === "snippet" && overall > breakdown.overall) {
    overall = breakdown.overall;
  }

  return {
    ...breakdown,
    categories,
    reasons_against: reasonsAgainst,
    recruiter_summary: recruiterSummary,
    overall,
  };
}

// ─── Canonical score-tier bucketing ───────────────────────────────────────
//
// Before this consolidation the codebase had six different breakpoint sets
// disagreeing on where "strong" stopped and "weak" began (75/45, 80/65/50,
// 80/60/40, 70/40). Picked 80/65/50 for "match" because that's what
// ScoreBadge (used by candidate-card.tsx) was already rendering — and the
// candidate-card is the call site the recruiter looks at most, so its tiers
// are the ones they consider "right". The library card was using 80/60/40;
// a 60-64 match becomes "weak" (warning) instead of "fair" (accent), which
// is a slightly stricter mid-tier shift — no candidate moves strong→weak.
//
// "match" and "fetchPriority" share 80/65/50 (already aligned in fetch-priority.ts
// and FetchPriorityBadge). "acceptance" uses 70/40 (only call site is
// AcceptanceBadge, which has three semantic levels).
//
// Location fit (75/45) is intentionally NOT a ScoreKind — it's bespoke per the
// task scope and stays in locationFitBadge.

export type ScoreTier = "strong" | "fair" | "weak" | "poor";
export type ScoreKind = "match" | "acceptance" | "fetchPriority";

export function scoreTier(score: number, kind: ScoreKind = "match"): ScoreTier {
  if (kind === "acceptance") {
    // AcceptanceBadge has three semantic levels (high/medium/low). Map them
    // into the 4-tier vocabulary by leaving "poor" unused.
    if (score >= 70) return "strong";
    if (score >= 40) return "fair";
    return "weak";
  }
  // match + fetchPriority share the same canonical 80/65/50 breakpoints.
  if (score >= 80) return "strong";
  if (score >= 65) return "fair";
  if (score >= 50) return "weak";
  return "poor";
}

export function scoreTierColor(tier: ScoreTier): string {
  // Tailwind classes mirror the ScoreBadge (canonical) tier colours.
  switch (tier) {
    case "strong": return "bg-success-subtle text-success";
    case "fair":   return "bg-accent-subtle text-accent";
    case "weak":   return "bg-warning-subtle text-warning";
    case "poor":   return "bg-surface-hover text-text-secondary";
  }
}

export function scoreTierLabel(tier: ScoreTier): string {
  switch (tier) {
    case "strong": return "Strong";
    case "fair":   return "Fair";
    case "weak":   return "Weak";
    case "poor":   return "Poor";
  }
}
