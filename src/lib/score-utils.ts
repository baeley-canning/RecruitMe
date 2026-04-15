import type { ScoreBreakdown } from "./scoring";

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
        skills:     breakdown.categories.skill_fit.score,
        experience: breakdown.categories.seniority_fit.score,
        industry:   breakdown.categories.industry_fit.score,
        location:   breakdown.categories.location_fit.score,
        seniority:  breakdown.categories.seniority_fit.score,
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
