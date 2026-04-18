import { describe, expect, it } from "vitest";
import localSeniorMatch from "./fixtures/scoring/local-senior-match.json";
import overseasMismatch from "./fixtures/scoring/overseas-mismatch.json";
import localGapyMatch from "./fixtures/scoring/local-gapy-match.json";
import { buildScoreBreakdown, type ScoreBreakdown } from "../scoring";
import { applyLocationFitOverride } from "../score-utils";

type ScoringFixture = {
  candidateLocation: string;
  targetLocation: string;
  locationRules: string;
  profileCharCount: number;
  categories: ScoreBreakdown["categories"];
  must_have_coverage: ScoreBreakdown["must_have_coverage"];
  nice_to_have_coverage: ScoreBreakdown["nice_to_have_coverage"];
  reasons_for: string[];
  reasons_against: string[];
  missing_evidence: string[];
  recruiter_summary: string;
  expected: {
    overall: number;
    locationFit: number;
    mustHavePct: number;
    confidenceScore: number;
    confidenceLevel: ScoreBreakdown["confidence"]["level"];
    summaryIncludes: string;
  };
};

const fixtures: ScoringFixture[] = [
  localSeniorMatch as ScoringFixture,
  overseasMismatch as ScoringFixture,
  localGapyMatch as ScoringFixture,
];

describe("golden scoring fixtures", () => {
  it.each(fixtures)("stays stable for %j", (fixture) => {
    const rawBreakdown = buildScoreBreakdown({
      categories: fixture.categories,
      must_have_coverage: fixture.must_have_coverage,
      nice_to_have_coverage: fixture.nice_to_have_coverage,
      reasons_for: fixture.reasons_for,
      reasons_against: fixture.reasons_against,
      missing_evidence: fixture.missing_evidence,
      recruiter_summary: fixture.recruiter_summary,
      profileCharCount: fixture.profileCharCount,
    });

    const breakdown = applyLocationFitOverride(
      rawBreakdown,
      fixture.candidateLocation,
      fixture.targetLocation,
      fixture.locationRules,
    );

    expect(breakdown.overall).toBe(fixture.expected.overall);
    expect(breakdown.categories.location_fit.score).toBe(fixture.expected.locationFit);
    expect(breakdown.must_have_pct).toBe(fixture.expected.mustHavePct);
    expect(breakdown.confidence.score).toBe(fixture.expected.confidenceScore);
    expect(breakdown.confidence.level).toBe(fixture.expected.confidenceLevel);
    expect(breakdown.recruiter_summary).toContain(fixture.expected.summaryIncludes);
  });
});
