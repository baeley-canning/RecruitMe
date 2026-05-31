/**
 * Focused unit tests for finalizeScoreFromText — the post-AI finalize seam
 * extracted from scoreCandidateStructured. It is a PURE function (no AI / no
 * DB), so no mocks are needed: feed it the raw model TEXT + a provider source
 * + a context, and it returns the finished ScoreBreakdown.
 *
 * These pin the two branches the extraction must preserve:
 *   1. parseable JSON  → finalizeBreakdownFromRawAI result, tagged scoredBy.
 *   2. unparseable text → deterministic stub, tagged scoredBy.
 */

import { describe, expect, it } from "vitest";
import { finalizeScoreFromText } from "../scoring";

// A realistic full-profile text (>2000 chars) so data_quality === "full_profile"
// and the parsed-JSON path isn't subject to snippet caps. Mentions React +
// TypeScript so the "confirmed" evidence is grounded (not hallucination-guarded).
const PROFILE_TEXT = (
  "Senior Frontend Engineer at AcmeCorp (2020 - present). Lead React + TypeScript developer. " +
  "Previously: Frontend Engineer at BetaCorp (2017 - 2020). " +
  "Skills: React, TypeScript, Node.js. Wellington-based. "
).repeat(10); // ~2500 chars

const ctx = {
  profileText: PROFILE_TEXT,
  mustHaves: ["React", "TypeScript"],
  niceToHaves: [] as string[],
  parsedRoleLocation: "Wellington",
  parsedRoleTitle: "Senior Frontend Engineer",
};

function goodRawJson(): string {
  return JSON.stringify({
    overall_score: 85,
    categories: {
      skill_fit:        { score: 80, evidence: "React + TypeScript listed" },
      location_fit:     { score: 100, evidence: "Wellington-based" },
      seniority_fit:    { score: 80, evidence: "Senior title" },
      title_fit:        { score: 75, evidence: "Direct title match" },
      domain_fit:       { score: 70, evidence: "Frontend domain" },
      nice_to_have_fit: { score: 50, evidence: "Some extras" },
    },
    must_have_coverage: [
      { requirement: "React", status: "confirmed", evidence: "React listed in skills" },
      { requirement: "TypeScript", status: "confirmed", evidence: "TypeScript listed in skills" },
    ],
    nice_to_have_coverage: [],
    reasons_for: ["Strong React background"],
    reasons_against: [],
    missing_evidence: [],
    recruiter_summary: "Solid frontend engineer with relevant experience.",
  });
}

describe("finalizeScoreFromText — parseable JSON", () => {
  it("returns a v2 ScoreBreakdown with scoredBy set to the provider source", () => {
    const bd = finalizeScoreFromText(goodRawJson(), "claude", ctx);

    expect(bd.version).toBe(2);
    expect(bd.scoredBy).toBe("claude");
    // Claude's overall_score (85) is preserved through the finalize on a
    // full profile with confirmed must-haves (no cap fires).
    expect(bd.overall).toBe(85);
    expect(bd.data_quality).toBe("full_profile");
    expect(bd.must_have_pct).toBe(100); // both must-haves confirmed
    expect(bd.must_have_coverage).toHaveLength(2);
    expect(bd.recruiter_summary).toContain("frontend engineer");
  });

  it("propagates an ollama source onto scoredBy", () => {
    const bd = finalizeScoreFromText(goodRawJson(), "ollama", ctx);
    expect(bd.scoredBy).toBe("ollama");
    expect(bd.overall).toBe(85);
  });
});

describe("finalizeScoreFromText — unparseable text", () => {
  it("returns the deterministic stub tagged with scoredBy (no throw)", () => {
    const bd = finalizeScoreFromText("{ this is not valid JSON at all", "ollama", ctx);

    expect(bd.version).toBe(2);
    expect(bd.scoredBy).toBe("ollama");
    // Stub shape: the role title becomes the visible headline, the role
    // location becomes the visible location, and the must-haves are listed
    // as "unknown" coverage (not visible in the unparseable capture).
    expect(bd.must_have_coverage.map((c) => c.requirement)).toEqual(["React", "TypeScript"]);
    expect(bd.must_have_coverage.every((c) => c.status === "unknown")).toBe(true);
    // Location was visible (Wellington) → location_fit credited above the
    // not-visible floor of 40.
    expect(bd.categories.location_fit.score).toBe(75);
  });

  it("still tags the stub when the source is claude", () => {
    const bd = finalizeScoreFromText("not json", "claude", ctx);
    expect(bd.scoredBy).toBe("claude");
  });
});
