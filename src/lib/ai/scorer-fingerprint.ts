import { createHash } from "crypto";
import {
  SCORING_OVERALL_RULE,
  SCORING_CATEGORY_RULES,
} from "./prompts/scoring";

/**
 * A content hash of the scoring rubric.
 *
 * Why this exists: buildScoreCacheKey hashes the profile, the role, the salary,
 * the location, the weights and the recruiter-corrections version — everything
 * that feeds a score EXCEPT the rubric that actually produces it. So improving
 * the rubric changed nothing: every candidate stayed a cache hit and kept the
 * verdict the old rubric gave. The over-qualification rule shipped in d848c24
 * and was still invisible on ~16,000 stored scores days later, because
 * SCORE_CACHE_VERSION is a hand-edited string and nobody remembered to touch it.
 *
 * Deriving the version from the rubric's own text removes the remembering.
 * Edit the rubric and the fingerprint changes by itself, so the next scoring run
 * re-judges instead of replaying a stale verdict.
 *
 * SERVER ONLY. This must never be imported from src/lib/utils.ts, which client
 * components pull in for `cn` — that would ship the entire scoring rubric to the
 * browser. The fingerprint is threaded into buildScoreCacheKey as an input by
 * server-side callers, the same way correctionsVersion is.
 */

let cached: string | null = null;

export function scorerFingerprint(): string {
  if (cached !== null) return cached;
  // Only the rubric text participates. The JSON shape constant is deliberately
  // excluded: reformatting the response envelope doesn't change any judgement,
  // and invalidating every score in the system is far too expensive to spend on
  // a cosmetic edit.
  const payload = [SCORING_OVERALL_RULE, SCORING_CATEGORY_RULES].join("\n\n");
  cached = createHash("sha256").update(payload).digest("hex").slice(0, 12);
  return cached;
}

/** Test seam — the fingerprint is memoised for the process lifetime. */
export function __resetScorerFingerprintCache(): void {
  cached = null;
}
