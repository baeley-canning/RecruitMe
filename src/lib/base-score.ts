import { buildProvisionalSearchScore, type SearchSnippet } from "./provisional-scoring";
import {
  extractSignalsFromRequirement,
  signalMatchesText,
  normalizeSignalText,
} from "./requirement-signals";
import { getJobTargetLocation } from "./job-target-location";
import { deriveUpdateData } from "./score-utils";
import type { ParsedRole } from "./ai";
import type { ScoringWeights } from "./scoring-config";

/**
 * Deterministic, no-AI "base score".
 *
 * Every candidate on a parsed job gets one (see GET /api/jobs/[id]) so the list
 * never shows "—" before anyone spends an AI token. It reuses the SAME
 * buildProvisionalSearchScore the live LinkedIn/SEEK import uses, so a library
 * row scores identically whether it arrived via a search run or sat unscored.
 *
 * It is explicitly a floor, not a verdict: tagged scoredBy="heuristic" (the UI
 * shows a "Base" pill, never "Claude"/"Llama"), data_quality stays "snippet",
 * and it leaves profileTextHash untouched — so a later AI "Re-score all" is
 * never treated as cached and cleanly overrides it.
 */

/** scoredBy marker for the deterministic base score. */
export const HEURISTIC_SCORED_BY = "heuristic" as const;

// buildProvisionalSearchScore stays import-light and takes its signal helpers
// injected. We pass the shared requirement-signals implementations (the same
// ones the provisional-scoring unit tests wire) so the base score matches the
// search-import score for the same candidate.
const SIGNAL_DEPS = {
  requirementSignals: extractSignalsFromRequirement,
  hasSignal: signalMatchesText,
  normaliseText: normalizeSignalText,
};

export interface BaseScoreCandidate {
  name: string;
  headline: string | null;
  location: string | null;
}

export interface BaseScoreJob {
  location: string | null;
  location2: string | null;
  isRemote: boolean;
}

/**
 * Build the Prisma update fields for a candidate's base score: matchScore +
 * scoreBreakdown + matchReason (via deriveUpdateData). Deliberately does NOT
 * touch profileTextHash, so an AI re-score is never cache-skipped.
 */
export function baseScoreUpdateData(
  candidate: BaseScoreCandidate,
  job: BaseScoreJob,
  parsedRole: ParsedRole,
  weights: ScoringWeights | undefined,
): { matchScore: number; scoreBreakdown: string; matchReason: string } {
  const snippet: SearchSnippet = {
    name: candidate.name,
    headline: candidate.headline,
    snippet: null, // library / SEEK snippet rows carry no full profile text
  };
  const breakdown = buildProvisionalSearchScore(
    snippet,
    parsedRole,
    candidate.location,
    getJobTargetLocation(job, parsedRole) ?? "",
    parsedRole.location_rules,
    job.isRemote,
    weights,
    SIGNAL_DEPS,
  );
  breakdown.scoredBy = HEURISTIC_SCORED_BY;
  return deriveUpdateData(breakdown) as {
    matchScore: number;
    scoreBreakdown: string;
    matchReason: string;
  };
}
