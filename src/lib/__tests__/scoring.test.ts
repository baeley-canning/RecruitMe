import { describe, it, expect } from "vitest";
import {
  computeMustHavePct,
  computeNiceToHavePct,
  computeEvidenceCoverageScore,
  computeOverallScore,
  classifyDataQuality,
  computeConfidence,
  buildScoreBreakdown,
  CATEGORY_WEIGHTS_V2,
  type MustHaveStatus,
  type NiceToHaveStatus,
  type ScoreBreakdown,
} from "../scoring";

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const baseCategories: ScoreBreakdown["categories"] = {
  skill_fit:         { score: 80, weight: CATEGORY_WEIGHTS_V2.skill_fit,         evidence: "Uses React and TypeScript" },
  location_fit:      { score: 100, weight: CATEGORY_WEIGHTS_V2.location_fit,     evidence: "Based in Auckland" },
  seniority_fit:     { score: 80, weight: CATEGORY_WEIGHTS_V2.seniority_fit,     evidence: "Senior Software Engineer title" },
  title_fit:         { score: 70, weight: CATEGORY_WEIGHTS_V2.title_fit,         evidence: "Close synonym title" },
  industry_fit:      { score: 90, weight: CATEGORY_WEIGHTS_V2.industry_fit,      evidence: "Fintech experience" },
  nice_to_have_fit:  { score: 60, weight: CATEGORY_WEIGHTS_V2.nice_to_have_fit,  evidence: "Some nice-to-haves present" },
  keyword_alignment: { score: 75, weight: CATEGORY_WEIGHTS_V2.keyword_alignment, evidence: "Vocabulary aligns well" },
};

const allConfirmed: MustHaveStatus[] = [
  { requirement: "React", status: "confirmed", evidence: "Listed in skills section" },
  { requirement: "TypeScript", status: "confirmed", evidence: "3 years TypeScript stated" },
  { requirement: "Node.js", status: "confirmed", evidence: "Backend work in Node.js" },
];

const allLikely: MustHaveStatus[] = [
  { requirement: "React", status: "likely", evidence: "Works at a React-first company" },
  { requirement: "TypeScript", status: "likely", evidence: "TypeScript implied by tech stack" },
];

const mixed: MustHaveStatus[] = [
  { requirement: "React", status: "confirmed", evidence: "Explicitly stated" },
  { requirement: "TypeScript", status: "likely", evidence: "Implied" },
  { requirement: "AWS", status: "missing", evidence: "Not mentioned" },
  { requirement: "Kubernetes", status: "unknown", evidence: "Insufficient data" },
];

const withNegative: MustHaveStatus[] = [
  { requirement: "NZ work rights", status: "negative", evidence: "Profile states based in UK" },
  { requirement: "React", status: "confirmed", evidence: "Listed skills" },
];

// ─── computeMustHavePct ────────────────────────────────────────────────────────

describe("computeMustHavePct", () => {
  it("returns 100 when coverage is empty (no must-haves)", () => {
    expect(computeMustHavePct([])).toBe(100);
  });

  it("returns 100 when all confirmed", () => {
    expect(computeMustHavePct(allConfirmed)).toBe(100);
  });

  it("returns 65 when all likely", () => {
    expect(computeMustHavePct(allLikely)).toBe(65);
  });

  it("returns 0 when all negative", () => {
    const coverage: MustHaveStatus[] = [
      { requirement: "NZ work rights", status: "negative", evidence: "UK-based" },
    ];
    expect(computeMustHavePct(coverage)).toBe(0);
  });

  it("returns 0 when all missing", () => {
    const coverage: MustHaveStatus[] = [
      { requirement: "Python", status: "missing", evidence: "Not mentioned" },
      { requirement: "Django", status: "missing", evidence: "Not mentioned" },
    ];
    expect(computeMustHavePct(coverage)).toBe(0);
  });

  it("returns 0 when all unknown", () => {
    const coverage: MustHaveStatus[] = [
      { requirement: "Leadership", status: "unknown", evidence: "Insufficient data" },
    ];
    expect(computeMustHavePct(coverage)).toBe(0);
  });

  it("averages mixed statuses correctly (confirmed=100, missing=0 → 50)", () => {
    const coverage: MustHaveStatus[] = [
      { requirement: "A", status: "confirmed", evidence: "Found" },
      { requirement: "B", status: "missing", evidence: "Not found" },
    ];
    expect(computeMustHavePct(coverage)).toBe(50);
  });

  it("rounds correctly for non-integer averages", () => {
    // confirmed=100, likely=65, missing=0 → avg = 165/3 = 55
    const coverage: MustHaveStatus[] = [
      { requirement: "A", status: "confirmed", evidence: "Found" },
      { requirement: "B", status: "likely",    evidence: "Implied" },
      { requirement: "C", status: "missing",   evidence: "Not found" },
    ];
    expect(computeMustHavePct(coverage)).toBe(55);
  });
});

// ─── computeNiceToHavePct ──────────────────────────────────────────────────────

describe("computeNiceToHavePct", () => {
  it("returns 50 when coverage is empty (neutral baseline)", () => {
    expect(computeNiceToHavePct([])).toBe(50);
  });

  it("returns 100 when all confirmed", () => {
    const coverage: NiceToHaveStatus[] = [
      { requirement: "GraphQL", status: "confirmed", evidence: "Used GraphQL at previous role" },
    ];
    expect(computeNiceToHavePct(coverage)).toBe(100);
  });

  it("returns 60 when all likely", () => {
    const coverage: NiceToHaveStatus[] = [
      { requirement: "GraphQL", status: "likely", evidence: "Works with APIs" },
    ];
    expect(computeNiceToHavePct(coverage)).toBe(60);
  });

  it("returns 0 when all absent", () => {
    const coverage: NiceToHaveStatus[] = [
      { requirement: "GraphQL", status: "absent", evidence: "Not mentioned" },
      { requirement: "Redis",   status: "absent", evidence: "Not mentioned" },
    ];
    expect(computeNiceToHavePct(coverage)).toBe(0);
  });

  it("averages mixed statuses (confirmed=100, absent=0 → 50)", () => {
    const coverage: NiceToHaveStatus[] = [
      { requirement: "GraphQL", status: "confirmed", evidence: "Found" },
      { requirement: "Redis",   status: "absent",    evidence: "Not found" },
    ];
    expect(computeNiceToHavePct(coverage)).toBe(50);
  });
});

// ─── computeEvidenceCoverageScore ─────────────────────────────────────────────

describe("computeEvidenceCoverageScore", () => {
  it("returns 0 when no requirements exist", () => {
    expect(computeEvidenceCoverageScore([], [])).toBe(0);
  });

  it("returns 100 when all must-haves confirmed and no nice-to-haves", () => {
    expect(computeEvidenceCoverageScore(allConfirmed, [])).toBe(100);
  });

  it("counts only confirmed as evidence — not likely, missing, unknown", () => {
    const mh: MustHaveStatus[] = [
      { requirement: "A", status: "confirmed", evidence: "Found" },
      { requirement: "B", status: "likely",    evidence: "Implied" },
      { requirement: "C", status: "missing",   evidence: "Not found" },
      { requirement: "D", status: "unknown",   evidence: "N/A" },
    ];
    // 1 confirmed out of 4 = 25%
    expect(computeEvidenceCoverageScore(mh, [])).toBe(25);
  });

  it("counts nice-to-have confirmed items as evidence", () => {
    const mh: MustHaveStatus[]  = [{ requirement: "A", status: "confirmed", evidence: "Found" }];
    const nth: NiceToHaveStatus[] = [{ requirement: "B", status: "confirmed", evidence: "Found" }];
    // 2 confirmed out of 2 total = 100%
    expect(computeEvidenceCoverageScore(mh, nth)).toBe(100);
  });

  it("returns 0 when all items are missing or absent", () => {
    const mh: MustHaveStatus[]  = [{ requirement: "A", status: "missing", evidence: "Not found" }];
    const nth: NiceToHaveStatus[] = [{ requirement: "B", status: "absent", evidence: "Not found" }];
    expect(computeEvidenceCoverageScore(mh, nth)).toBe(0);
  });

  it("rounds to nearest integer", () => {
    // 1 confirmed out of 3 total = 33.33% → 33
    const mh: MustHaveStatus[] = [
      { requirement: "A", status: "confirmed", evidence: "Found" },
      { requirement: "B", status: "missing",   evidence: "Not found" },
      { requirement: "C", status: "missing",   evidence: "Not found" },
    ];
    expect(computeEvidenceCoverageScore(mh, [])).toBe(33);
  });
});

// ─── classifyDataQuality ───────────────────────────────────────────────────────

describe("classifyDataQuality", () => {
  it("returns minimal for 0 chars", () => {
    expect(classifyDataQuality(0)).toBe("minimal");
  });

  it("returns minimal at boundary (199 chars)", () => {
    expect(classifyDataQuality(199)).toBe("minimal");
  });

  it("returns snippet at lower boundary (200 chars)", () => {
    expect(classifyDataQuality(200)).toBe("snippet");
  });

  it("returns snippet for mid-range (1000 chars)", () => {
    expect(classifyDataQuality(1000)).toBe("snippet");
  });

  it("returns snippet at upper boundary (1999 chars)", () => {
    expect(classifyDataQuality(1999)).toBe("snippet");
  });

  it("returns full_profile at boundary (2000 chars)", () => {
    expect(classifyDataQuality(2000)).toBe("full_profile");
  });

  it("returns full_profile for large profiles (10000 chars)", () => {
    expect(classifyDataQuality(10000)).toBe("full_profile");
  });
});

// ─── computeOverallScore ──────────────────────────────────────────────────────

describe("computeOverallScore", () => {
  it("computes weighted sum correctly", () => {
    // 80*0.24 + 100*0.14 + 80*0.14 + 70*0.10 + 90*0.08 + 60*0.05 + 75*0.05 + 100*0.20
    // = 19.2 + 14 + 11.2 + 7 + 7.2 + 3 + 3.75 + 20 = 85.35 → 85
    expect(computeOverallScore(baseCategories, 100)).toBe(85);
  });

  it("clamps to 100 when all inputs exceed 100", () => {
    const maxCats = Object.fromEntries(
      Object.keys(baseCategories).map((k) => [k, { score: 150, weight: 0, evidence: "" }])
    ) as ScoreBreakdown["categories"];
    expect(computeOverallScore(maxCats, 150)).toBe(100);
  });

  it("clamps to 0 when all inputs are 0", () => {
    const zeroCats = Object.fromEntries(
      Object.keys(baseCategories).map((k) => [k, { score: 0, weight: 0, evidence: "" }])
    ) as ScoreBreakdown["categories"];
    expect(computeOverallScore(zeroCats, 0)).toBe(0);
  });

  it("must_have_pct of 0 with high category scores significantly lowers overall", () => {
    const highCats = Object.fromEntries(
      Object.keys(baseCategories).map((k) => [k, { score: 90, weight: 0, evidence: "" }])
    ) as ScoreBreakdown["categories"];
    const withAllMust    = computeOverallScore(highCats, 100);
    const withZeroMust   = computeOverallScore(highCats, 0);
    // must_have_pct contributes 0.20 weight: 100*0.20=20 vs 0*0.20=0 → delta=20
    expect(withAllMust - withZeroMust).toBe(20);
  });
});

// ─── computeConfidence ────────────────────────────────────────────────────────

describe("computeConfidence", () => {
  it("gives high confidence for full profile with all confirmed must-haves", () => {
    const conf = computeConfidence(3000, allConfirmed);
    expect(conf.level).toBe("high");
    expect(conf.score).toBeGreaterThanOrEqual(70);
    expect(conf.reasons.some((r) => r.includes("Full profile"))).toBe(true);
  });

  it("gives medium confidence for snippet with some confirmed must-haves", () => {
    const conf = computeConfidence(500, allConfirmed);
    expect(conf.level).toBe("medium");
    expect(conf.score).toBeGreaterThanOrEqual(40);
    expect(conf.score).toBeLessThan(70);
  });

  it("gives low confidence for minimal data", () => {
    const conf = computeConfidence(50, []);
    expect(conf.level).toBe("low");
    expect(conf.score).toBeLessThan(40);
  });

  it("reduces confidence when majority of must-haves are unknown", () => {
    const manyUnknown: MustHaveStatus[] = [
      { requirement: "A", status: "unknown", evidence: "N/A" },
      { requirement: "B", status: "unknown", evidence: "N/A" },
      { requirement: "C", status: "unknown", evidence: "N/A" },
      { requirement: "D", status: "confirmed", evidence: "Found" },
    ];
    // 3/4 unknown (75%) → -20 from full_profile base of 70 → 50
    const conf = computeConfidence(3000, manyUnknown);
    expect(conf.score).toBeLessThanOrEqual(50);
    expect(conf.reasons.some((r) => r.includes("verified"))).toBe(true);
  });

  it("reduces confidence for each negative must-have", () => {
    const confClean    = computeConfidence(3000, allConfirmed);
    const confNegative = computeConfidence(3000, withNegative);
    expect(confNegative.score).toBeLessThan(confClean.score);
    expect(confNegative.reasons.some((r) => r.includes("contradicted"))).toBe(true);
  });

  it("includes a reason string for every confidence deduction", () => {
    const conf = computeConfidence(100, mixed);
    expect(conf.reasons.length).toBeGreaterThan(0);
    conf.reasons.forEach((r) => expect(typeof r).toBe("string"));
  });
});

// ─── buildScoreBreakdown ──────────────────────────────────────────────────────

describe("buildScoreBreakdown", () => {
  const nthCoverage: NiceToHaveStatus[] = [
    { requirement: "GraphQL", status: "confirmed", evidence: "GraphQL APIs mentioned" },
    { requirement: "Redis",   status: "absent",    evidence: "Not mentioned" },
  ];

  it("produces a v2 breakdown with all required fields", () => {
    const bd = buildScoreBreakdown({
      categories:            baseCategories,
      must_have_coverage:    allConfirmed,
      nice_to_have_coverage: nthCoverage,
      reasons_for:           ["Strong React background", "Auckland-based"],
      reasons_against:       ["No AWS experience mentioned"],
      missing_evidence:      ["Years of experience not stated"],
      recruiter_summary:     "Strong frontend candidate with relevant Auckland experience.",
      profileCharCount:      3000,
    });

    expect(bd.version).toBe(2);
    expect(bd.overall).toBeGreaterThan(0);
    expect(bd.overall).toBeLessThanOrEqual(100);
    expect(bd.must_have_pct).toBe(100);
    expect(bd.nice_to_have_pct).toBe(50); // (100+0)/2
    expect(bd.evidence_coverage_score).toBeGreaterThan(0);
    expect(bd.confidence.level).toBe("high");
    expect(bd.data_quality).toBe("full_profile");
    expect(bd.reasons_for).toHaveLength(2);
    expect(bd.reasons_against).toHaveLength(1);
    expect(bd.missing_evidence).toHaveLength(1);
    expect(bd.recruiter_summary).toContain("Auckland");
  });

  it("caps reasons_for and reasons_against at 4 entries each", () => {
    const bd = buildScoreBreakdown({
      categories:            baseCategories,
      must_have_coverage:    [],
      nice_to_have_coverage: [],
      reasons_for:           ["a", "b", "c", "d", "e", "f"],
      reasons_against:       ["x", "y", "z", "w", "v"],
      missing_evidence:      ["m1", "m2", "m3", "m4", "m5"],
      recruiter_summary:     "Test.",
      profileCharCount:      3000,
    });
    expect(bd.reasons_for).toHaveLength(4);
    expect(bd.reasons_against).toHaveLength(4);
    expect(bd.missing_evidence).toHaveLength(4);
  });

  it("returns must_have_pct of 100 when no must-haves given", () => {
    const bd = buildScoreBreakdown({
      categories:            baseCategories,
      must_have_coverage:    [],
      nice_to_have_coverage: [],
      reasons_for:           [],
      reasons_against:       [],
      missing_evidence:      [],
      recruiter_summary:     "",
      profileCharCount:      2500,
    });
    expect(bd.must_have_pct).toBe(100);
  });

  it("returns evidence_coverage_score of 0 when all items missing or absent", () => {
    const mh: MustHaveStatus[] = [
      { requirement: "A", status: "missing", evidence: "Not found" },
    ];
    const nth: NiceToHaveStatus[] = [
      { requirement: "B", status: "absent", evidence: "Not found" },
    ];
    const bd = buildScoreBreakdown({
      categories:            baseCategories,
      must_have_coverage:    mh,
      nice_to_have_coverage: nth,
      reasons_for:           [],
      reasons_against:       [],
      missing_evidence:      [],
      recruiter_summary:     "",
      profileCharCount:      2500,
    });
    expect(bd.evidence_coverage_score).toBe(0);
  });

  it("overall score is lower when must_have_pct is 0", () => {
    const noMH = buildScoreBreakdown({
      categories:            baseCategories,
      must_have_coverage:    [{ requirement: "A", status: "negative", evidence: "Contradicted" }],
      nice_to_have_coverage: [],
      reasons_for:           [],
      reasons_against:       [],
      missing_evidence:      [],
      recruiter_summary:     "",
      profileCharCount:      3000,
    });
    const allMH = buildScoreBreakdown({
      categories:            baseCategories,
      must_have_coverage:    allConfirmed,
      nice_to_have_coverage: [],
      reasons_for:           [],
      reasons_against:       [],
      missing_evidence:      [],
      recruiter_summary:     "",
      profileCharCount:      3000,
    });
    expect(allMH.overall).toBeGreaterThan(noMH.overall);
  });
});
