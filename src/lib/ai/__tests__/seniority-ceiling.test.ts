import { describe, it, expect } from "vitest";
import {
  SCORING_CATEGORY_RULES,
  SCORING_OVERALL_RULE,
} from "@/lib/ai/prompts/scoring";

/**
 * Guards the fix for "it keeps giving me tech leads on $150k for a $125k role".
 *
 * Root cause was structural: seniority_fit was scored purely on DISTANCE
 * ("one level off"), so being ABOVE the band read as exceeding the bar rather
 * than missing it — while must-haves (36%) + skill_fit (22%) reward exactly
 * what an over-qualified lead has most of, and seniority carries only 10%.
 * The most over-qualified CV therefore won.
 */
describe("seniority ceiling rules", () => {
  it("names over-qualification as a MISMATCH, not a bonus", () => {
    expect(SCORING_CATEGORY_RULES).toMatch(/OVER-qualification as a mismatch/i);
  });

  it("lists the specific titles that sit above an IC role", () => {
    for (const title of ["Lead", "Principal", "Architect", "Head-of", "Manager", "Director"]) {
      expect(SCORING_CATEGORY_RULES).toContain(title);
    }
  });

  it("rewards the step-up candidate — the actual target for a mentoring role", () => {
    expect(SCORING_CATEGORY_RULES).toMatch(/one step below who is visibly ready to step up/i);
  });

  it("judges level from scope, not years (a long-tenured senior IC is still an IC)", () => {
    expect(SCORING_CATEGORY_RULES).toMatch(/not from years alone/i);
    expect(SCORING_CATEGORY_RULES).toMatch(/long-tenured senior IC is still a senior IC/i);
  });

  it("makes over-qualification a hard score cap, using the existing blocker rule", () => {
    expect(SCORING_OVERALL_RULE).toMatch(/OVER-QUALIFICATION IS A BLOCKER/);
    expect(SCORING_OVERALL_RULE).toMatch(/cap overall_score below 40/i);
    // The blocker list must explicitly include it, or the model won't apply it.
    expect(SCORING_OVERALL_RULE).toMatch(/INCLUDING over-qualification/i);
  });

  it("states the business reason, so the model weighs acceptance not CV strength", () => {
    expect(SCORING_OVERALL_RULE).toMatch(/declines the offer, or accepts and leaves/i);
    expect(SCORING_OVERALL_RULE).toMatch(/hard ceiling on the level/i);
  });
});
