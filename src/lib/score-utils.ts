import { computeOverallScore, type ScoreBreakdown } from "./scoring";
import { assessLocationFit } from "./location";

/**
 * Derive all Prisma candidate update fields from a v2 ScoreBreakdown.
 * Shared by the single-score route, score-all route, and search route.
 */
export function deriveUpdateData(breakdown: ScoreBreakdown): Record<string, unknown> {
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
        industry:  breakdown.categories.industry_fit.score,
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

export function applyLocationFitOverride(
  breakdown: ScoreBreakdown,
  candidateLocation: string | null | undefined,
  targetLocation: string | null | undefined,
  locationRules?: string | null,
  isRemote?: boolean,
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

  let overall = computeOverallScore(categories, breakdown.must_have_pct);

  // Apply an out-of-area penalty when the job is not remote and location fit is poor.
  // Scales from ×0.6 (completely out of area) to ×1.0 (at the 50-point threshold).
  if (!isRemote && assessment.score < 50) {
    const multiplier = 0.6 + (assessment.score / 50) * 0.4;
    overall = Math.max(0, Math.round(overall * multiplier));
  }

  // Hard-cap at 50 only for candidates who are genuinely out-of-area (score < 50
  // means > 150 km away). Commutable candidates (score 55–80) keep their full score.
  if (!isRemote && assessment.score < 50 && overall > 50) {
    overall = 50;
  }

  return {
    ...breakdown,
    categories,
    reasons_against: reasonsAgainst,
    recruiter_summary: recruiterSummary,
    overall,
  };
}
