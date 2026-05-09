/**
 * Recruiter-visible "evaluation" string for a search session.
 *
 * Lives in lib/ rather than the search route so it's importable from tests
 * — Next.js forbids arbitrary exports from a route file.
 *
 * Outputs one of:
 *   FAIL — search hit a hard error or returned nothing
 *   WARNING — search ran but quality is suspect (high reject rate, too few
 *            candidates, oddly-high or oddly-low average score)
 *   OK — looks fine
 *
 * The WARNING message includes distinctive anchors (up to 4) so recruiters
 * know what the gate was looking for. If a future regex change drops
 * distinctive anchor extraction, the WARNING goes generic — see the
 * route-level test that locks this hint.
 */
export function buildSearchEvaluation(opts: {
  collected: number;
  avgScore: number | null;
  totalExamined: number;       // all raw profiles before ANY filtering
  candidatesRejected: number;  // rejected at source gate only
  totalFiltered: number;       // all filters combined (source gate + seniority + overseas + name)
  sawRetryableSearchFailure: boolean;
  distinctiveAnchors?: string[]; // surfaced in WARNING so recruiters know what was missing
}): string {
  const { collected, avgScore, totalExamined, totalFiltered, sawRetryableSearchFailure, distinctiveAnchors } = opts;
  const rejectionRate = totalExamined > 0 ? totalFiltered / totalExamined : 0;

  if (collected === 0 && sawRetryableSearchFailure)
    return "FAIL — Search APIs rate-limited. Wait a few minutes then Search Again — any candidates already imported won't duplicate.";
  if (collected === 0)
    return "FAIL — No candidates found. Try: broader location (e.g. 'New Zealand' instead of a specific city), Re-analyse to refresh search terms, or add more skills to the job description.";
  if (rejectionRate >= 0.80 && totalExamined >= 10) {
    const anchorHint = distinctiveAnchors && distinctiveAnchors.length > 0
      ? ` Looking for: ${distinctiveAnchors.slice(0, 4).join(", ")} — none found in most snippets.`
      : "";
    return `WARNING — ${Math.round(rejectionRate * 100)}% of search results filtered out before scoring.${anchorHint} The role's required skills may be too narrow for the available pool — try Re-analyse, then Search Again`;
  }
  if (collected <= 2)
    return `WARNING — only ${collected} candidate${collected !== 1 ? "s" : ""} found. Try a broader search location or Re-analyse the JD with more context`;
  if (avgScore !== null && avgScore >= 88)
    return `WARNING — average score ${avgScore}% is unusually high. The role may have had no requirements when candidates were last scored — click Re-score all`;
  if (avgScore !== null && avgScore < 28)
    return `WARNING — average score ${avgScore}%; search found profiles but they don't match requirements well. Check anchor terms or add more JD detail`;
  return `OK — ${collected} candidate${collected !== 1 ? "s" : ""} found, average score ${avgScore ?? "n/a"}%`;
}
