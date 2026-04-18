// ─── Structured scoring types and pure functions ───────────────────────────────
// No AI, no DB, no side effects — everything here is deterministic.
// The AI populates raw category scores + coverage + reasons.
// These functions compute overall, pcts, evidence coverage, and confidence.
//
// v1 → v2 changelog:
//   - Added nice_to_have_fit and keyword_alignment scoring categories
//   - Added nice_to_have_coverage (NiceToHaveStatus[])
//   - Added reasons_for, reasons_against, missing_evidence
//   - Added evidence_coverage_score (% of requirements with explicit textual evidence)
//   - Weight formula rebalanced to accommodate 7 categories

// ─── Status types ──────────────────────────────────────────────────────────────

export type MustHaveCoverageStatus = "confirmed" | "likely" | "missing" | "negative" | "unknown";
export type NiceToHaveCoverageStatus = "confirmed" | "likely" | "absent";
export type DataQuality = "full_profile" | "snippet" | "minimal";
export type ConfidenceLevel = "high" | "medium" | "low";

// ─── Evidence item types ───────────────────────────────────────────────────────

/** One must-have requirement with coverage status and textual evidence. */
export interface MustHaveStatus {
  requirement:  string;
  status:       MustHaveCoverageStatus;
  /** Direct quote or paraphrase from the profile, or "Not mentioned" */
  evidence:     string;
}

/** One nice-to-have requirement with simpler 3-state coverage. */
export interface NiceToHaveStatus {
  requirement:  string;
  status:       NiceToHaveCoverageStatus;
  evidence:     string;
}

// ─── Score structures ──────────────────────────────────────────────────────────

export interface CategoryScore {
  score:    number; // 0–100
  weight:   number; // category's contribution weight (for display only)
  evidence: string; // one sentence grounding the score
}

/** v2 ScoreBreakdown — fully self-contained, all computed fields included. */
export interface ScoreBreakdown {
  version: 2;

  /** Deterministic overall: weighted sum of categories + must_have_pct contribution. */
  overall: number;

  /**
   * Evidence coverage score: % of all requirements (must + nice-to-have) where the
   * AI found EXPLICIT textual evidence (status === "confirmed").
   * Separate from confidence — a high-scoring candidate can have low evidence coverage
   * if most matches are inferred rather than quoted from the profile.
   */
  evidence_coverage_score: number;

  categories: {
    skill_fit:         CategoryScore;
    location_fit:      CategoryScore;
    seniority_fit:     CategoryScore;
    title_fit:         CategoryScore;
    industry_fit:      CategoryScore;
    nice_to_have_fit:  CategoryScore;
    keyword_alignment: CategoryScore;
  };

  /** Per-requirement coverage for every must-have listed in the role. */
  must_have_coverage: MustHaveStatus[];

  /** Deterministic weighted average of must-have coverage. */
  must_have_pct: number;

  /** Per-requirement coverage for up to 6 nice-to-haves. */
  nice_to_have_coverage: NiceToHaveStatus[];

  /** Deterministic simple average of nice-to-have coverage. */
  nice_to_have_pct: number;

  /** Up to 4 grounded positive signals from the profile. */
  reasons_for: string[];

  /** Up to 4 grounded concerns or gaps. */
  reasons_against: string[];

  /**
   * 2–4 specific pieces of missing information that would materially change the score.
   * e.g. "Years of experience not stated", "No mention of React Native despite being a must-have"
   */
  missing_evidence: string[];

  confidence: {
    level:   ConfidenceLevel;
    score:   number;     // 0–100
    reasons: string[];   // human-readable explanation of confidence level
  };

  data_quality: DataQuality;

  /** 1–2 sentences, plain English, no jargon. Derived from structured output, not freeform. */
  recruiter_summary: string;
}

// ─── Category weights — v2 (must sum to 1.0) ───────────────────────────────────

export const CATEGORY_WEIGHTS_V2 = {
  skill_fit:         0.24,
  location_fit:      0.14,
  seniority_fit:     0.14,
  title_fit:         0.10,
  industry_fit:      0.08,
  nice_to_have_fit:  0.05,
  keyword_alignment: 0.05,
  // must_have_pct contributes 0.20
} as const;
// Check: 0.24+0.14+0.14+0.10+0.08+0.05+0.05 = 0.80; plus must_have_pct*0.20 = 1.00 ✓

export const MUST_HAVE_WEIGHT_V2 = 0.20;

// ─── Point tables ───────────────────────────────────────────────────────────────

const MUST_HAVE_POINTS: Record<MustHaveCoverageStatus, number> = {
  confirmed: 100,
  likely:    65,
  missing:   0,
  negative:  0,
  unknown:   0,
};

const NICE_TO_HAVE_POINTS: Record<NiceToHaveCoverageStatus, number> = {
  confirmed: 100,
  likely:    60,
  absent:    0,
};

// ─── Pure computation functions ─────────────────────────────────────────────────

/**
 * Weighted coverage of all must-have requirements.
 * Returns 100 when the role has no must-haves (nothing to fail).
 */
export function computeMustHavePct(coverage: MustHaveStatus[]): number {
  if (coverage.length === 0) return 100;
  const total = coverage.reduce((sum, c) => sum + MUST_HAVE_POINTS[c.status], 0);
  return Math.round(total / coverage.length);
}

/**
 * Simple average coverage of nice-to-have requirements.
 * Returns 50 (neutral) when the role has no nice-to-haves.
 */
export function computeNiceToHavePct(coverage: NiceToHaveStatus[]): number {
  if (coverage.length === 0) return 50;
  const total = coverage.reduce((sum, c) => sum + NICE_TO_HAVE_POINTS[c.status], 0);
  return Math.round(total / coverage.length);
}

/**
 * Evidence coverage score: % of all requirements (must + nice) where the AI found
 * EXPLICIT textual evidence (status === "confirmed"). Inferred ("likely") and
 * not-found ("missing"/"unknown"/"absent") do not count.
 *
 * This measures how auditable the score is, not how good the candidate is.
 */
export function computeEvidenceCoverageScore(
  mustHaveCoverage:    MustHaveStatus[],
  niceToHaveCoverage:  NiceToHaveStatus[]
): number {
  const total = mustHaveCoverage.length + niceToHaveCoverage.length;
  if (total === 0) return 0;

  const explicit =
    mustHaveCoverage.filter((c) => c.status === "confirmed").length +
    niceToHaveCoverage.filter((c) => c.status === "confirmed").length;

  return Math.round((explicit / total) * 100);
}

/**
 * Classify data quality from raw profile character count.
 */
export function classifyDataQuality(charCount: number): DataQuality {
  if (charCount >= 2000) return "full_profile";
  if (charCount >= 200)  return "snippet";
  return "minimal";
}

/**
 * Compute overall score from all 7 category scores + must-have coverage %.
 * v2 weight formula:
 *   skill_fit*0.24 + location_fit*0.14 + seniority_fit*0.14 + title_fit*0.10
 *   + industry_fit*0.08 + nice_to_have_fit*0.05 + keyword_alignment*0.05
 *   + must_have_pct*0.20
 */
export function computeOverallScore(
  categories: ScoreBreakdown["categories"],
  mustHavePct: number
): number {
  const weighted =
    categories.skill_fit.score         * CATEGORY_WEIGHTS_V2.skill_fit +
    categories.location_fit.score      * CATEGORY_WEIGHTS_V2.location_fit +
    categories.seniority_fit.score     * CATEGORY_WEIGHTS_V2.seniority_fit +
    categories.title_fit.score         * CATEGORY_WEIGHTS_V2.title_fit +
    categories.industry_fit.score      * CATEGORY_WEIGHTS_V2.industry_fit +
    categories.nice_to_have_fit.score  * CATEGORY_WEIGHTS_V2.nice_to_have_fit +
    categories.keyword_alignment.score * CATEGORY_WEIGHTS_V2.keyword_alignment +
    mustHavePct                        * MUST_HAVE_WEIGHT_V2;

  return Math.min(100, Math.max(0, Math.round(weighted)));
}

/**
 * Compute confidence level and score.
 * Deterministic — the AI does not produce this. Based on:
 *   - Profile data quality (char count)
 *   - How many must-haves have unknown vs confirmed evidence
 *   - Whether any must-haves were actively contradicted (negative)
 */
export function computeConfidence(
  profileCharCount: number,
  mustHaveCoverage: MustHaveStatus[]
): ScoreBreakdown["confidence"] {
  const reasons: string[] = [];
  const quality = classifyDataQuality(profileCharCount);

  // Base confidence from data quality
  let score: number;
  if (quality === "full_profile") {
    score = 70;
    reasons.push("Full profile text available");
  } else if (quality === "snippet") {
    score = 45;
    reasons.push("Only a short snippet — some signals may be undetectable");
  } else {
    score = 20;
    reasons.push("Very little profile data — score is largely speculative");
  }

  // Penalise for unknown coverage
  const total        = mustHaveCoverage.length;
  const unknownCount = mustHaveCoverage.filter((c) => c.status === "unknown").length;
  const missingCount = mustHaveCoverage.filter((c) => c.status === "missing").length;
  const negativeCount = mustHaveCoverage.filter((c) => c.status === "negative").length;

  if (total > 0) {
    const unknownFrac = unknownCount / total;
    if (unknownFrac > 0.5) {
      score -= 20;
      reasons.push(
        `${unknownCount} of ${total} must-haves couldn't be verified — insufficient profile data`
      );
    } else if (unknownFrac > 0.25) {
      score -= 10;
      reasons.push(`${unknownCount} must-have(s) not clearly confirmable from the profile`);
    }

    if (missingCount > 0) {
      score -= missingCount * 8;
      reasons.push(
        `${missingCount} must-have(s) not mentioned — may be present but unverifiable`
      );
    }

    if (negativeCount > 0) {
      score -= negativeCount * 15;
      reasons.push(
        `${negativeCount} must-have(s) actively contradicted by the profile`
      );
    }
  }

  score = Math.min(100, Math.max(0, score));

  const level: ConfidenceLevel =
    score >= 70 ? "high" :
    score >= 40 ? "medium" :
    "low";

  return { level, score, reasons };
}

/**
 * Assemble a complete v2 ScoreBreakdown from AI-provided raw data.
 * All derived fields are computed here — the AI never produces the final score.
 */
export function buildScoreBreakdown(params: {
  categories:           ScoreBreakdown["categories"];
  must_have_coverage:   MustHaveStatus[];
  nice_to_have_coverage: NiceToHaveStatus[];
  reasons_for:          string[];
  reasons_against:      string[];
  missing_evidence:     string[];
  recruiter_summary:    string;
  profileCharCount:     number;
}): ScoreBreakdown {
  const mustHavePct        = computeMustHavePct(params.must_have_coverage);
  const niceToHavePct      = computeNiceToHavePct(params.nice_to_have_coverage);
  const overall            = computeOverallScore(params.categories, mustHavePct);
  const evidenceCoverage   = computeEvidenceCoverageScore(
    params.must_have_coverage,
    params.nice_to_have_coverage
  );
  const confidence         = computeConfidence(params.profileCharCount, params.must_have_coverage);
  const dataQuality        = classifyDataQuality(params.profileCharCount);

  return {
    version:                 2,
    overall,
    evidence_coverage_score: evidenceCoverage,
    categories:              params.categories,
    must_have_coverage:      params.must_have_coverage,
    must_have_pct:           mustHavePct,
    nice_to_have_coverage:   params.nice_to_have_coverage,
    nice_to_have_pct:        niceToHavePct,
    reasons_for:             params.reasons_for.slice(0, 4),
    reasons_against:         params.reasons_against.slice(0, 4),
    missing_evidence:        params.missing_evidence.slice(0, 4),
    confidence,
    data_quality:            dataQuality,
    recruiter_summary:       params.recruiter_summary,
  };
}
