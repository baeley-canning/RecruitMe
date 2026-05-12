import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { applyLlamaScorePenalty, getLlamaScorePenaltyPoints, type ScoreBreakdown } from "../scoring";

// Minimal valid breakdown — focuses tests on the penalty maths, not the shape.
function fakeBreakdown(overall: number, scoredBy?: "claude" | "ollama"): ScoreBreakdown {
  return {
    version: 2,
    overall,
    evidence_coverage_score: 50,
    categories: {
      skill_fit:       { score: overall, weight: 0.22, evidence: "" },
      location_fit:    { score: overall, weight: 0.08, evidence: "" },
      seniority_fit:   { score: overall, weight: 0.10, evidence: "" },
      title_fit:       { score: overall, weight: 0.08, evidence: "" },
      domain_fit:      { score: overall, weight: 0.10, evidence: "" },
      nice_to_have_fit:{ score: overall, weight: 0.06, evidence: "" },
    },
    must_have_coverage: [],
    must_have_pct: overall,
    nice_to_have_coverage: [],
    nice_to_have_pct: 0,
    reasons_for: [],
    reasons_against: [],
    missing_evidence: [],
    confidence: { level: "medium", score: 50, reasons: [] },
    data_quality: "full_profile",
    recruiter_summary: "",
    ...(scoredBy ? { scoredBy } : {}),
  };
}

describe("getLlamaScorePenaltyPoints", () => {
  const snapshot = { ...process.env };
  beforeEach(() => { delete process.env.LLAMA_SCORE_PENALTY_POINTS; });
  afterEach(() => { process.env = { ...snapshot }; });

  it("defaults to 10 when env is unset", () => {
    expect(getLlamaScorePenaltyPoints()).toBe(10);
  });

  it("respects a custom positive value", () => {
    process.env.LLAMA_SCORE_PENALTY_POINTS = "15";
    expect(getLlamaScorePenaltyPoints()).toBe(15);
  });

  it("accepts zero as a valid (no-penalty) configuration", () => {
    process.env.LLAMA_SCORE_PENALTY_POINTS = "0";
    expect(getLlamaScorePenaltyPoints()).toBe(0);
  });

  it("falls back to default on junk / negative input", () => {
    process.env.LLAMA_SCORE_PENALTY_POINTS = "garbage";
    expect(getLlamaScorePenaltyPoints()).toBe(10);
    process.env.LLAMA_SCORE_PENALTY_POINTS = "-5";
    expect(getLlamaScorePenaltyPoints()).toBe(10);
  });
});

describe("applyLlamaScorePenalty", () => {
  const snapshot = { ...process.env };
  beforeEach(() => { delete process.env.LLAMA_SCORE_PENALTY_POINTS; });
  afterEach(() => { process.env = { ...snapshot }; });

  it("returns breakdown unchanged when scoredBy is not 'ollama'", () => {
    const b = fakeBreakdown(80, "claude");
    expect(applyLlamaScorePenalty(b).overall).toBe(80);
    const untagged = fakeBreakdown(80);
    expect(applyLlamaScorePenalty(untagged).overall).toBe(80);
  });

  it("subtracts the default 10-point penalty for ollama scores", () => {
    expect(applyLlamaScorePenalty(fakeBreakdown(80, "ollama")).overall).toBe(70);
  });

  it("clamps at 0 — never returns a negative overall", () => {
    expect(applyLlamaScorePenalty(fakeBreakdown(5, "ollama")).overall).toBe(0);
  });

  it("uses the env-overridden penalty value", () => {
    process.env.LLAMA_SCORE_PENALTY_POINTS = "20";
    expect(applyLlamaScorePenalty(fakeBreakdown(50, "ollama")).overall).toBe(30);
  });
});
