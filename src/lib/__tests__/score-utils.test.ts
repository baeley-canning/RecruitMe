import { describe, expect, it } from "vitest";
import { applyLocationFitOverride } from "../score-utils";
import type { ScoreBreakdown } from "../scoring";
import { DEFAULT_SCORING_WEIGHTS } from "../scoring-config";

function makeBreakdown(overrides: Partial<ScoreBreakdown> = {}): ScoreBreakdown {
  return {
    overall: 70,
    confidence: 75,
    confidence_label: "high",
    data_quality: "full_profile",
    recruiter_summary: "Strong all-round candidate.",
    must_have_coverage: [],
    nice_to_have_coverage: [],
    reasons_for: [],
    reasons_against: [],
    categories: {
      skill_fit:        { score: 75, weight: 0.22, evidence: "" },
      location_fit:     { score: 90, weight: 0.08, evidence: "" },
      seniority_fit:    { score: 70, weight: 0.10, evidence: "" },
      title_fit:        { score: 75, weight: 0.08, evidence: "" },
      domain_fit:       { score: 60, weight: 0.10, evidence: "" },
      nice_to_have_fit: { score: 50, weight: 0.06, evidence: "" },
    },
    ...overrides,
  } as ScoreBreakdown;
}

describe("applyLocationFitOverride", () => {
  it("returns the breakdown unchanged when location fit can't be assessed", () => {
    const before = makeBreakdown({ overall: 80 });
    const after = applyLocationFitOverride(before, undefined, undefined, null, false, DEFAULT_SCORING_WEIGHTS);
    expect(after.overall).toBe(80);
  });

  it("hard-caps an out-of-area candidate at 50 when location_fit is at default weight", () => {
    const before = makeBreakdown({ overall: 80 });
    // Strongly out-of-area location → assessment.score should be low.
    const after = applyLocationFitOverride(
      before,
      "Sydney, NSW, Australia",
      "Wellington, New Zealand",
      null,
      false,
      DEFAULT_SCORING_WEIGHTS,
    );
    // Default weight ratio = 1.0 → hard cap fires when fit < 50.
    expect(after.overall).toBeLessThanOrEqual(50);
  });

  it("does not hard-cap when the recruiter explicitly de-prioritises location", () => {
    const before = makeBreakdown({ overall: 80 });
    const tunedDownWeights = { ...DEFAULT_SCORING_WEIGHTS, location_fit: 0.02 };
    const after = applyLocationFitOverride(
      before,
      "Sydney, NSW, Australia",
      "Wellington, New Zealand",
      null,
      false,
      tunedDownWeights,
    );
    // weightRatio = 0.02/0.08 = 0.25 → cap doesn't apply, mild penalty only.
    // Should stay above 50 (the hard-cap threshold) because the recruiter
    // told us location matters less.
    expect(after.overall).toBeGreaterThan(50);
  });

  it("skips the penalty entirely for remote roles", () => {
    const before = makeBreakdown({ overall: 80 });
    const after = applyLocationFitOverride(
      before,
      "Sydney, NSW, Australia",
      "Wellington, New Zealand",
      null,
      true, // isRemote
      DEFAULT_SCORING_WEIGHTS,
    );
    // Remote role → no penalty regardless of geographic distance.
    expect(after.overall).toBe(80);
  });

  it("never lifts a snippet-quality score above the data-quality cap", () => {
    const before = makeBreakdown({ overall: 30, data_quality: "snippet" });
    const after = applyLocationFitOverride(
      before,
      "Wellington, NZ",
      "Wellington, NZ",
      null,
      false,
      DEFAULT_SCORING_WEIGHTS,
    );
    // Even with location fit re-assessed positively, snippet score never grows.
    expect(after.overall).toBeLessThanOrEqual(30);
  });
});
