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
  /** Full stored evidence when we hold it — profileText and/or CV text.
   *  Feeding this in is the difference between "scored on a headline" and a
   *  real deterministic fit check: must-have/nice-to-have keyword coverage
   *  runs over the whole text, and the breakdown says so honestly
   *  (evidenceKind "profile"). Omit/null for true snippet-only rows. */
  evidenceText?: string | null;
}

/** Cap the evidence fed to signal matching. Regex matching over normalised
 *  text is fast, but profileText+cvText can reach 100KB+ on JobAdder rows;
 *  40k chars comfortably covers any real CV/profile's signal content. */
const EVIDENCE_TEXT_CAP = 40_000;

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
  const evidence = candidate.evidenceText?.trim() ? candidate.evidenceText.slice(0, EVIDENCE_TEXT_CAP) : null;
  const snippet: SearchSnippet = {
    name: candidate.name,
    headline: candidate.headline,
    snippet: evidence, // full profile/CV when held; null for snippet-only rows
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
    { evidenceKind: evidence ? "profile" : "snippet" },
  );
  breakdown.scoredBy = HEURISTIC_SCORED_BY;
  return deriveUpdateData(breakdown) as {
    matchScore: number;
    scoreBreakdown: string;
    matchReason: string;
  };
}
