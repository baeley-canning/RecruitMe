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

  it("judges LEVEL from scope, not years — long service alone doesn't make a Lead", () => {
    expect(SCORING_CATEGORY_RULES).toMatch(/long-tenured senior IC is still a senior IC/i);
    expect(SCORING_CATEGORY_RULES).toMatch(/does not by itself make someone a Lead/i);
  });

  // The gap that "not from years alone" left open: a 15-year senior dev has the
  // RIGHT title, so nothing flagged them — but their market rate is far above a
  // $125k ceiling, so they were topping searches they'd never accept.
  it("infers PRICE from tenure even when the title matches the role exactly", () => {
    expect(SCORING_CATEGORY_RULES).toMatch(/tenure moves PRICE/i);
    expect(SCORING_CATEGORY_RULES).toMatch(/12\+ years/i);
    expect(SCORING_CATEGORY_RULES).toMatch(/EVEN THOUGH the title matches/i);
    // The judgement is about acceptance and retention, not capability.
    expect(SCORING_CATEGORY_RULES).toMatch(/would they accept this number/i);
  });

  it("only infers compensation when the role actually stated a ceiling", () => {
    expect(SCORING_CATEGORY_RULES).toMatch(/If NO budget ceiling is given, ignore compensation entirely/i);
    expect(SCORING_CATEGORY_RULES).toMatch(/Never invent a ceiling/i);
  });

  it("treats a long-tenured senior as a capped blocker in the overall rule too", () => {
    expect(SCORING_OVERALL_RULE).toMatch(/long-tenured senior [\s\S]*whose market rate sits above the ceiling/i);
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
