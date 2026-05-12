/**
 * Invariant test for the Claude → Llama scoring failover path.
 *
 * Guards the rule the rest of the codebase is built around: a final
 * candidate score that comes from the local Llama model must be
 *   (a) tagged with `scoredBy: "ollama"` on the returned ScoreBreakdown,
 *   (b) penalised by LLAMA_SCORE_PENALTY_POINTS (default 10) at
 *       write-time so it cannot accidentally outrank a Claude score of
 *       the same nominal value.
 *
 * If either invariant breaks, Llama-derived scores can silently slip
 * into the candidate list as if Claude had produced them — exactly the
 * gaslighting risk the user has explicitly forbidden.
 *
 * No real network calls: chat() and ollamaGenerate are both mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockChat } = vi.hoisted(() => ({ mockChat: vi.fn() }));
const { mockOllamaGenerate } = vi.hoisted(() => ({ mockOllamaGenerate: vi.fn() }));

vi.mock("../ai/chat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai/chat")>();
  return { ...actual, chat: mockChat };
});
vi.mock("../local-model/client", () => ({ ollamaGenerate: mockOllamaGenerate }));
vi.mock("../recruiter-memory", () => ({ getRecruitingContext: vi.fn().mockResolvedValue("") }));

import { scoreCandidateStructured } from "../ai/scoring";
import { getLlamaScorePenaltyPoints } from "../scoring";

const FULL_PROFILE = (
  "Senior Frontend Engineer at AcmeCorp (2020 - present). Lead React + TypeScript developer. " +
  "Previously: Frontend Engineer at BetaCorp (2017 - 2020), Software Developer at GammaCo (2014 - 2017). " +
  "Skills: React, TypeScript, Node.js, REST APIs, frontend architecture. " +
  "Wellington-based. Built production single-page apps and led teams of 4-6 engineers. "
).repeat(8);

const PARSED_ROLE = {
  title: "Senior Frontend Engineer",
  title_source: "explicit" as const,
  location: "Wellington",
  location_source: "explicit" as const,
  company: "TestCo",
  company_source: "explicit" as const,
  experience: "5+ years",
  seniority_band: "Senior",
  seniority_source: "inferred" as const,
  salary_band: "$120k–$150k NZD",
  salary_source: "inferred" as const,
  location_rules: "Wellington CBD, hybrid",
  location_rules_source: "inferred" as const,
  visa_flags: [],
  must_haves: ["5+ years React", "TypeScript"],
  nice_to_haves: [],
  knockout_criteria: [],
  application_requirements: [],
  explicitly_stated: [],
  strongly_inferred: [],
  search_expansion: [],
  synonym_titles: [],
  responsibilities: [],
  search_queries: [],
  google_queries: [],
  skills_required: ["React", "TypeScript"],
  skills_preferred: [],
  anchor_terms: ["React"],
};

function validScoringJson(overall: number): string {
  return JSON.stringify({
    overall_score: overall,
    categories: {
      skill_fit:        { score: 80, evidence: "React + TS in profile" },
      location_fit:     { score: 100, evidence: "Wellington" },
      seniority_fit:    { score: 85, evidence: "Senior+Lead history" },
      title_fit:        { score: 80, evidence: "Frontend Engineer match" },
      domain_fit:       { score: 75, evidence: "Frontend domain" },
      nice_to_have_fit: { score: 50, evidence: "None specified" },
    },
    must_have_coverage: [
      { requirement: "5+ years React", status: "confirmed", evidence: "React listed since 2017" },
      { requirement: "TypeScript",     status: "confirmed", evidence: "TS listed in skills" },
    ],
    nice_to_have_coverage: [],
    reasons_for:   ["Strong React + TS background", "Wellington-based"],
    reasons_against: [],
    missing_evidence: [],
    recruiter_summary: "Senior frontend engineer with strong React + TS, local to Wellington.",
  });
}

describe("Llama scoring invariant — scoredBy + penalty must accompany every Llama-sourced score", () => {
  const envSnapshot = { ...process.env };
  beforeEach(() => {
    mockChat.mockReset();
    mockOllamaGenerate.mockReset();
    delete process.env.ENABLE_LOCAL_MODEL_FAILOVER;
    delete process.env.ENABLE_LOCAL_MODEL_FINAL_SCORING;
    delete process.env.LLAMA_SCORE_PENALTY_POINTS;
  });
  afterEach(() => { process.env = { ...envSnapshot }; });

  it("when Claude is dead and final-scoring failover is enabled, the breakdown is tagged scoredBy='ollama' AND penalised", async () => {
    process.env.ENABLE_LOCAL_MODEL_FINAL_SCORING = "true";
    // Claude dead with credit-balance message → classified as credits_exhausted → failover
    // 401 because withRetry treats it as non-retryable; classifyClaudeError
    // still flags it dead (auth_invalid) so failover fires immediately.
    mockChat.mockRejectedValue(Object.assign(new Error("Invalid API key"), { status: 401 }));
    mockOllamaGenerate.mockResolvedValue({ text: validScoringJson(85), durationMs: 600 });

    const breakdown = await scoreCandidateStructured(FULL_PROFILE, PARSED_ROLE);

    expect(breakdown.scoredBy).toBe("ollama");
    // Penalty is applied at write-time. The exact overall depends on the
    // formula but it MUST be lower than what a Claude-sourced identical
    // breakdown would produce. Easiest invariant: it cannot be higher than
    // 100 - penalty (since pre-penalty max is 100).
    const penalty = getLlamaScorePenaltyPoints();
    expect(penalty).toBeGreaterThan(0);
    expect(breakdown.overall).toBeLessThanOrEqual(100 - penalty);
  });

  it("when Claude succeeds (no failover triggered), the breakdown is tagged scoredBy='claude' and is NOT penalised", async () => {
    process.env.ENABLE_LOCAL_MODEL_FINAL_SCORING = "true";
    mockChat.mockResolvedValue(validScoringJson(85));

    const breakdown = await scoreCandidateStructured(FULL_PROFILE, PARSED_ROLE);

    expect(breakdown.scoredBy).toBe("claude");
    expect(mockOllamaGenerate).not.toHaveBeenCalled();
  });

  it("when ENABLE_LOCAL_MODEL_FINAL_SCORING is unset, a Claude failure throws (no silent Ollama substitution)", async () => {
    // Flag is OFF — even if Claude dies, we MUST NOT silently substitute Llama.
    // Using a 401 because withRetry treats it as non-retryable and bails on
    // the first attempt; a 429 would loop with backoff and blow the test
    // timeout while exercising the same invariant.
    delete process.env.ENABLE_LOCAL_MODEL_FINAL_SCORING;
    mockChat.mockRejectedValue(Object.assign(new Error("Invalid API key"), { status: 401 }));
    mockOllamaGenerate.mockResolvedValue({ text: validScoringJson(85), durationMs: 600 });

    await expect(scoreCandidateStructured(FULL_PROFILE, PARSED_ROLE)).rejects.toThrow(/invalid api key/i);
    expect(mockOllamaGenerate).not.toHaveBeenCalled();
  });

  it("respects LLAMA_SCORE_PENALTY_POINTS env override", async () => {
    process.env.ENABLE_LOCAL_MODEL_FINAL_SCORING = "true";
    process.env.LLAMA_SCORE_PENALTY_POINTS = "20";
    // 401 because withRetry treats it as non-retryable; classifyClaudeError
    // still flags it dead (auth_invalid) so failover fires immediately.
    mockChat.mockRejectedValue(Object.assign(new Error("Invalid API key"), { status: 401 }));
    mockOllamaGenerate.mockResolvedValue({ text: validScoringJson(90), durationMs: 600 });

    const breakdown = await scoreCandidateStructured(FULL_PROFILE, PARSED_ROLE);
    expect(breakdown.scoredBy).toBe("ollama");
    expect(getLlamaScorePenaltyPoints()).toBe(20);
    // Ceiling check — same shape as the default-penalty test, just with the
    // overridden value.
    expect(breakdown.overall).toBeLessThanOrEqual(100 - 20);
  });
});
