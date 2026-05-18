import { describe, expect, it } from "vitest";
import { DEFAULT_SCORING_WEIGHTS, normaliseWeights } from "../scoring-config";

describe("normaliseWeights", () => {
  it("normalises complete custom weights to 100 percent", () => {
    const weights = normaliseWeights({
      must_have: 2,
      skill_fit: 1,
      location_fit: 1,
      seniority_fit: 1,
      title_fit: 1,
      domain_fit: 1,
      nice_to_have_fit: 1,
    });

    expect(Object.values(weights).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
    expect(weights.must_have).toBeCloseTo(0.25);
  });

  it("fills missing or invalid stored values from defaults before normalising", () => {
    const weights = normaliseWeights({
      must_have: 0.5,
      skill_fit: Number.NaN,
    });

    expect(Object.values(weights).every(Number.isFinite)).toBe(true);
    expect(Object.values(weights).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
    expect(weights.location_fit).toBeGreaterThan(0);
  });

  it("falls back to defaults when all values are zero", () => {
    expect(normaliseWeights({
      must_have: 0,
      skill_fit: 0,
      location_fit: 0,
      seniority_fit: 0,
      title_fit: 0,
      domain_fit: 0,
      nice_to_have_fit: 0,
    })).toEqual(DEFAULT_SCORING_WEIGHTS);
  });
});
