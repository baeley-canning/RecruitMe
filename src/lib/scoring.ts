// ─── Structured scoring types and pure functions ───────────────────────────────
// No AI, no DB, no side effects — everything here is deterministic.
// The AI populates raw category scores + coverage + reasons.
// These functions compute overall, pcts, evidence coverage, and confidence.
//
// v2 → v3 changelog:
//   - Must-have weight raised from 0.28 → 0.36 (skills over location)
//   - Location weight cut from 0.14 → 0.08
//   - Seniority weight cut from 0.14 → 0.10
//   - Snippet point table: missing=5, unknown=30, likely=55 (unknown raised from 15 — absence of evidence ≠ absence)
//   - Per-requirement importance weights (WordPress/CMS/RightToWork = 1.5×)
//   - Degree importance weights: regulated profession=1.5×, technical field degree=1.3×, general degree=1.1×
//   - "equivalent" status: requirement satisfied via experience (full=100, snippet=85, minimal=70); not "unconfirmed"
//   - Critical gate: unconfirmed 1.5× must-have on snippet hard-caps to 45; "equivalent" does not trigger gate
//   - Snippet cap raised from 55 to 70 (snippets are genuinely informative), minimal at 40
//   - Search route applies 30% floor for snippet data so provisional results surface
//   - Search route locationFitScore cutoff only fires when candidateLocation is known
//   - Knockout criteria merged into must_haves for scoring so they affect the coverage score

// ─── Status types ──────────────────────────────────────────────────────────────

export type MustHaveCoverageStatus = "confirmed" | "equivalent" | "likely" | "likely_historical" | "missing" | "negative" | "unknown";
export type NiceToHaveCoverageStatus = "confirmed" | "likely" | "absent";
export type DataQuality = "full_profile" | "snippet" | "minimal";
export type ConfidenceLevel = "high" | "medium" | "low";

// ─── Evidence item types ───────────────────────────────────────────────────────

export interface MustHaveStatus {
  requirement:  string;
  status:       MustHaveCoverageStatus;
  evidence:     string;
}

export interface NiceToHaveStatus {
  requirement:  string;
  status:       NiceToHaveCoverageStatus;
  evidence:     string;
}

// ─── External weight config (optional — falls back to CATEGORY_WEIGHTS_V2) ─────
export type { ScoringWeights } from "./scoring-config";
import type { ScoringWeights } from "./scoring-config";

// ─── Score structures ──────────────────────────────────────────────────────────

export interface CategoryScore {
  score:    number;
  weight:   number;
  evidence: string;
}

export interface ScoreBreakdown {
  version: 2;
  overall: number;
  evidence_coverage_score: number;
  categories: {
    skill_fit:          CategoryScore;
    location_fit:       CategoryScore;
    seniority_fit:      CategoryScore;
    title_fit:          CategoryScore;
    domain_fit:         CategoryScore;
    nice_to_have_fit:   CategoryScore;
    // Legacy fields — present on old DB records, absent on new ones
    industry_fit?:      CategoryScore;
    keyword_alignment?: CategoryScore;
  };
  must_have_coverage:   MustHaveStatus[];
  must_have_pct:        number;
  nice_to_have_coverage: NiceToHaveStatus[];
  nice_to_have_pct:     number;
  reasons_for:          string[];
  reasons_against:      string[];
  missing_evidence:     string[];
  confidence: {
    level:   ConfidenceLevel;
    score:   number;
    reasons: string[];
  };
  data_quality:      DataQuality;
  recruiter_summary: string;
}

// ─── Category weights — v3 (must sum to 1.0) ───────────────────────────────────
// Must-have coverage is now 36%: can you do the job matters most.
// Location cut to 8%: being nearby should not carry a weak profile.

export const CATEGORY_WEIGHTS_V2 = {
  skill_fit:        0.22,
  location_fit:     0.08,
  seniority_fit:    0.10,
  title_fit:        0.08,
  domain_fit:       0.10, // replaces industry_fit(0.04) + keyword_alignment(0.06)
  nice_to_have_fit: 0.06,
  // must_have_pct contributes 0.36
} as const;
// Check: 0.22+0.08+0.10+0.08+0.10+0.06 = 0.64; plus must_have_pct*0.36 = 1.00 ✓

export const MUST_HAVE_WEIGHT_V2 = 0.36;

// ─── Point tables ───────────────────────────────────────────────────────────────
// For full profiles: absence is a real zero.
// For snippets: "missing" and "unknown" mean "not yet proven" — very low credit.
// "likely" is still worth something, but not a free ride.

const MUST_HAVE_POINTS_BY_QUALITY: Record<DataQuality, Record<MustHaveCoverageStatus, number>> = {
  full_profile: {
    confirmed:         100,
    equivalent:        100, // satisfies via experience — treated identically to confirmed
    likely:             65,
    likely_historical:  35, // skill is real but not current — candidate has moved to a different stack
    missing:             0,
    negative:            0,
    unknown:             0,
  },
  snippet: {
    confirmed:         100,
    equivalent:         85,
    likely:             55,
    likely_historical:  25,
    missing:             5,
    negative:            0,
    unknown:            30,
  },
  minimal: {
    confirmed:         100,
    equivalent:         70,
    likely:             45,
    likely_historical:  20,
    missing:             0,
    negative:            0,
    unknown:            10,
  },
};

const NICE_TO_HAVE_POINTS: Record<NiceToHaveCoverageStatus, number> = {
  confirmed: 100,
  likely:    60,
  absent:    0,
};

// ─── Importance weights ────────────────────────────────────────────────────────
// Per-requirement multiplier derived from the requirement text itself.
// Critical skills that cannot be compensated for by location or title get 1.5×.
// Soft behavioural traits that don't differentiate on their own get 0.7×.

export function getMustHaveImportance(requirement: string): number {
  const r = requirement.toLowerCase();
  // Critical — cannot be compensated for by location or title alone
  if (/wordpress|content management system|\bcms\b/i.test(r))                return 1.5;
  if (/right to work|work rights|nz citizen|nz resident|\bvisa\b|work in new zealand/i.test(r)) return 1.5;
  if (/security clearance|clearance eligibility|security vetting|secret vetting|confidential vetting|\bsv\b|\bcv\b|nzsis|national security clearance|baseline clearance|secret clearance/i.test(r)) return 1.5;
  // Regulated-profession qualifications: degree is a legal/professional prerequisite
  if (/\b(chartered accountant|cpa|ca qualification|cfa)\b/i.test(r))        return 1.5;
  if (/\b(registered nurse|nursing registration|nzrn|nursing council)\b/i.test(r)) return 1.5;
  if (/\b(engineering degree|civil engineering|structural engineering)\b.*\b(degree|qualification)\b/i.test(r)) return 1.5;
  if (/\b(law degree|llb|legal qualification|bar admission)\b/i.test(r))     return 1.5;
  if (/\b(medical degree|mbchb|mbbs|nzmc registration)\b/i.test(r))         return 1.5;
  // Technical degrees where field relevance matters
  if (/\b(degree|bachelor|master|phd|doctorate)\b.{0,30}\b(computer science|software|information technology|data science|cybersecurity|electrical engineering)\b/i.test(r)) return 1.3;
  if (/\b(computer science|software engineering|information technology)\b.{0,30}\b(degree|qualification)\b/i.test(r)) return 1.3;
  // General degree requirement — more important than soft skills but field is flexible
  if (/\b(bachelor'?s?\s+degree|master'?s?\s+degree|university degree|tertiary qualification|relevant degree)\b/i.test(r)) return 1.1;
  if (/\bdegree\b|\bdiploma\b/i.test(r) && !/equivalent|or equivalent|preferred/i.test(r)) return 1.1;
  // Very important technical requirements
  if (/\bux\b|user experience|design principle|web design|ux.{0,10}design|design.{0,10}develop/i.test(r)) return 1.3;
  if (/\bperformance test|load test|jmeter|loadrunner|gatling|neoload\b/i.test(r)) return 1.3;
  // Primary/rare technologies — if explicitly required and confirmed missing on a full profile,
  // no amount of location/domain/seniority alignment rescues the candidate.
  if (/\bc\+\+\b/i.test(r)) return 1.5;
  if (/\bsybase\b|\bcobol\b|\bmainframe\b/i.test(r)) return 1.5; // legacy/rare: absence is a blocker
  if (/\bangular\b|\.net|asp\.net|c#|azure|kubernetes|aks|api design|ci\/cd|pipeline/i.test(r)) return 1.3;
  if (/\bitil\b|\bitsm\b|service management|incident management|change management|problem management|requirements|process mapping|business analysis/i.test(r)) return 1.2;
  if (/concept to launch|full.{0,5}site|full.{0,5}build|full website|ownership|end.to.end/i.test(r)) return 1.2;
  if (/shopify|squarespace|woocommerce/i.test(r))                            return 1.2;
  if (/front.?end|back.?end|full.?stack/i.test(r))                          return 1.1;
  // Soft traits — useful but cannot rescue a weak technical profile
  if (/goal.orient|deadline|desire to learn|attention to detail|collaborate|communication|team/i.test(r)) return 0.7;
  return 1.0;
}

// ─── Pure computation functions ─────────────────────────────────────────────────

export function classifyDataQuality(charCount: number): DataQuality {
  if (charCount >= 2000) return "full_profile";
  if (charCount >= 200)  return "snippet";
  return "minimal";
}

export function computeMustHavePct(
  coverage: MustHaveStatus[],
  dataQuality: DataQuality = "full_profile"
): number {
  if (coverage.length === 0) return 100;
  const pointTable = MUST_HAVE_POINTS_BY_QUALITY[dataQuality];

  let totalPoints = 0;
  let totalWeight = 0;
  for (const c of coverage) {
    const importance = getMustHaveImportance(c.requirement);
    totalPoints += pointTable[c.status] * importance;
    totalWeight += importance;
  }

  return Math.round(totalPoints / totalWeight);
}

export function computeNiceToHavePct(coverage: NiceToHaveStatus[]): number {
  if (coverage.length === 0) return 50;
  const total = coverage.reduce((sum, c) => sum + NICE_TO_HAVE_POINTS[c.status], 0);
  return Math.round(total / coverage.length);
}

export function computeEvidenceCoverageScore(
  mustHaveCoverage:    MustHaveStatus[],
  niceToHaveCoverage:  NiceToHaveStatus[]
): number {
  const total = mustHaveCoverage.length + niceToHaveCoverage.length;
  if (total === 0) return 0;
  const explicit =
    mustHaveCoverage.filter((c) => c.status === "confirmed" || c.status === "equivalent").length +
    niceToHaveCoverage.filter((c) => c.status === "confirmed").length;
  return Math.round((explicit / total) * 100);
}

export function computeOverallScore(
  categories: ScoreBreakdown["categories"],
  mustHavePct: number,
  weights?: ScoringWeights
): number {
  // Backward compat: old records stored industry_fit + keyword_alignment instead of domain_fit.
  // Use industry_fit as the direct domain proxy — cleaner than the weighted formula which
  // introduced rounding drift when keyword_alignment was absent. Legacy candidates score
  // within ~2pts of their original; clicking Re-score will compute domain_fit properly.
  const domainScore = categories.domain_fit?.score ??
    categories.industry_fit?.score ??
    50;

  const w = weights ?? CATEGORY_WEIGHTS_V2;
  const mustHaveW = weights ? weights.must_have : MUST_HAVE_WEIGHT_V2;

  const weighted =
    categories.skill_fit.score        * w.skill_fit +
    categories.location_fit.score     * w.location_fit +
    categories.seniority_fit.score    * w.seniority_fit +
    categories.title_fit.score        * w.title_fit +
    domainScore                       * w.domain_fit +
    categories.nice_to_have_fit.score * w.nice_to_have_fit +
    mustHavePct                       * mustHaveW;

  return Math.min(100, Math.max(0, Math.round(weighted)));
}

export function computeConfidence(
  profileCharCount: number,
  mustHaveCoverage: MustHaveStatus[]
): ScoreBreakdown["confidence"] {
  const reasons: string[] = [];
  const quality = classifyDataQuality(profileCharCount);

  // Base reflects how much raw data is available to make an assessment.
  let score: number;
  if (quality === "full_profile") {
    score = 70;
    reasons.push("Full profile text available");
  } else if (quality === "snippet") {
    score = 48;
    reasons.push("Partial profile — some must-haves may not be fully verifiable");
  } else {
    score = 15;
    reasons.push("Minimal data — score is largely speculative");
  }

  const total = mustHaveCoverage.length;
  if (total > 0) {
    const supportedCount = mustHaveCoverage.filter(
      (c) => c.status === "confirmed" || c.status === "equivalent" || c.status === "likely"
    ).length;
    const unknownCount  = mustHaveCoverage.filter((c) => c.status === "unknown").length;
    const negativeCount = mustHaveCoverage.filter((c) => c.status === "negative").length;

    // "unknown" = genuine uncertainty — we cannot assess this at all.
    // "missing" / "negative" = clear assessments; they affect the score but not confidence.
    const unknownFrac = unknownCount / total;
    if (unknownFrac > 0.5) {
      score -= 30;
      reasons.push(`${unknownCount} of ${total} must-haves unverified — insufficient data`);
    } else if (unknownFrac > 0.25) {
      score -= 10;
      reasons.push(`${unknownCount} must-have(s) not confirmable from profile`);
    } else if (unknownCount > 0) {
      score -= 5;
    }

    // Bonus for strong, low-uncertainty coverage.
    const supportedFrac = supportedCount / total;
    if (supportedFrac >= 0.75 && unknownCount <= 1 && negativeCount === 0) {
      const bonus = quality === "full_profile" ? 15 : quality === "snippet" ? 8 : 0;
      if (bonus > 0) {
        score += bonus;
        reasons.push(`${supportedCount} of ${total} must-haves confirmed or likely`);
      }
    }

    if (negativeCount > 0) {
      score -= negativeCount * 35;
      reasons.push(`${negativeCount} must-have(s) contradicted by the profile`);
    }
  }

  score = Math.min(100, Math.max(0, score));

  const level: ConfidenceLevel =
    score >= 70 ? "high" :
    score >= 40 ? "medium" :
    "low";

  return { level, score, reasons };
}

export function buildScoreBreakdown(params: {
  categories:            ScoreBreakdown["categories"];
  must_have_coverage:    MustHaveStatus[];
  nice_to_have_coverage: NiceToHaveStatus[];
  reasons_for:           string[];
  reasons_against:       string[];
  missing_evidence:      string[];
  recruiter_summary:     string;
  profileCharCount:      number;
  weights?:              ScoringWeights;
}): ScoreBreakdown {
  const dataQuality   = classifyDataQuality(params.profileCharCount);
  const mustHavePct   = computeMustHavePct(params.must_have_coverage, dataQuality);
  const niceToHavePct = computeNiceToHavePct(params.nice_to_have_coverage);
  const rawOverall    = computeOverallScore(params.categories, mustHavePct, params.weights);

  // Base cap by data quality: snippets/partial captures are leads, not confirmed matches.
  let cap =
    dataQuality === "snippet"
      ? params.profileCharCount < 500 ? 54 : 65
      : dataQuality === "minimal" ? 40 : 100;

  // Critical gate for snippets/minimal: if any 1.5× must-have is unconfirmed, cap hard —
  // the candidate cannot be presented as a real match until a full profile proves otherwise.
  if (dataQuality !== "full_profile") {
    // "equivalent" counts as satisfied — only unresolved statuses trigger the cap
    const criticalUnconfirmed = params.must_have_coverage.filter(
      (c) =>
        getMustHaveImportance(c.requirement) >= 1.5 &&
        (c.status === "missing" || c.status === "negative" || c.status === "unknown")
    );
    if (criticalUnconfirmed.length > 0) {
      // Each additional unconfirmed critical drops the cap by 8 more points
      const compoundedCap = Math.max(20, 45 - (criticalUnconfirmed.length - 1) * 8);
      cap = Math.min(cap, compoundedCap);
    }
  }

  // Critical gate for full profiles: if a 1.5× must-have is *confirmed* missing or negative,
  // no amount of location/seniority/domain alignment should produce a match-level score.
  // We use 50 (not 45) because full-profile absence is a cleaner signal than snippet-unknown.
  if (dataQuality === "full_profile") {
    const criticalMissing = params.must_have_coverage.filter(
      (c) =>
        getMustHaveImportance(c.requirement) >= 1.5 &&
        (c.status === "missing" || c.status === "negative")
    );
    if (criticalMissing.length > 0) {
      cap = Math.min(cap, 50);
    }
  }

  const overall         = Math.min(rawOverall, cap);
  const evidenceCoverage = computeEvidenceCoverageScore(
    params.must_have_coverage,
    params.nice_to_have_coverage
  );
  const confidence = computeConfidence(params.profileCharCount, params.must_have_coverage);

  // If the cap was applied, surface the reason so recruiters understand why the
  // score is lower than the raw weighted sum would suggest.
  const effectiveReasonsAgainst = [...params.reasons_against];
  if (rawOverall > overall) {
    if (dataQuality !== "full_profile") {
      effectiveReasonsAgainst.push(`Score capped at ${overall} — provisional snippet data; fetch full profile for reliable assessment`);
    } else {
      effectiveReasonsAgainst.push(`Score reduced from ${rawOverall} to ${overall} — critical requirement confirmed absent from full profile`);
    }
  }

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
    reasons_against:         effectiveReasonsAgainst.slice(0, 4),
    missing_evidence:        params.missing_evidence.slice(0, 4),
    confidence,
    data_quality:            dataQuality,
    recruiter_summary:       params.recruiter_summary,
  };
}
