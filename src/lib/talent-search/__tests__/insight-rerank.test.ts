import { describe, expect, it } from "vitest";
import {
  positiveQueryTerms,
  insightMatchFraction,
  rerankByInsights,
  INSIGHT_BOOST_POSITIONS,
} from "../insight-rerank";
import type { ParsedQuery } from "../../boolean-query";
import type { InsightFacts } from "../../ai/insights";

const pq = (over: Partial<ParsedQuery>): ParsedQuery => ({
  raw: "", mustHave: [], anyOf: [], mustNot: [], hasErrors: false, errors: [], ...over,
});

const facts = (over: Partial<InsightFacts>): InsightFacts => ({
  currentTitle: null, currentEmployer: null, primaryStack: [], secondaryStack: [],
  domains: [], titlesHeld: [], education: [], certifications: [], evidenceSnippets: [],
  totalYearsExperience: null, currentSeniority: null, ...over,
});

describe("positiveQueryTerms", () => {
  it("flattens mustHave + anyOf, de-dupes, lowercases; excludes mustNot", () => {
    const terms = positiveQueryTerms(pq({
      mustHave: ["React"], anyOf: [["typescript", "react"]], mustNot: ["php"],
    }));
    expect(terms.sort()).toEqual(["react", "typescript"]);
  });
});

describe("insightMatchFraction", () => {
  it("matches single-word terms by token equality — 'java' does NOT match 'javascript'", () => {
    const f = facts({ primaryStack: ["javascript", "react"] });
    expect(insightMatchFraction(["java"], f)).toBe(0);
    expect(insightMatchFraction(["javascript"], f)).toBe(1);
  });

  it("keeps #/+/. inside tokens (c#, c++, .net, node.js)", () => {
    const f = facts({ primaryStack: ["c#", "c++", ".net", "node.js"] });
    expect(insightMatchFraction(["c#", "c++", ".net", "node.js"], f)).toBe(1);
  });

  it("matches hyphenated single-word terms (full-stack survives as one token both sides)", () => {
    expect(insightMatchFraction(["full-stack"], facts({ titlesHeld: ["Full-Stack Developer"] }))).toBe(1);
    expect(insightMatchFraction(["ci-cd"], facts({ primaryStack: ["ci-cd", "docker"] }))).toBe(1);
  });

  it("does NOT crash on a valid-JSON-but-unshaped facts row (coerces to 0)", () => {
    // A legacy / partial-backfill / hand-written row can be valid JSON but the
    // wrong shape — spreading a non-array must not throw and 500 the search.
    const bad = [
      {} as unknown as InsightFacts,
      { primaryStack: null } as unknown as InsightFacts,
      { titlesHeld: "not-an-array", currentTitle: 42 } as unknown as InsightFacts,
    ];
    for (const f of bad) {
      expect(() => insightMatchFraction(["react"], f)).not.toThrow();
      expect(insightMatchFraction(["react"], f)).toBe(0);
    }
  });

  it("matches multi-word phrases by substring across the joined facts", () => {
    const f = facts({ titlesHeld: ["Senior Software Engineer"] });
    expect(insightMatchFraction(["software engineer"], f)).toBe(1);
    expect(insightMatchFraction(["product manager"], f)).toBe(0);
  });

  it("returns the fraction matched across all positive terms", () => {
    const f = facts({ primaryStack: ["react"], domains: ["fintech"] });
    // react + fintech hit, kotlin misses → 2/3
    expect(insightMatchFraction(["react", "fintech", "kotlin"], f)).toBeCloseTo(2 / 3);
  });

  it("is 0 with no terms", () => {
    expect(insightMatchFraction([], facts({ primaryStack: ["react"] }))).toBe(0);
  });
});

describe("rerankByInsights", () => {
  const row = (id: string) => ({ id, candidateIdentityId: id });

  it("is an exact no-op with no terms (returns input order)", () => {
    const rows = [row("a"), row("b"), row("c")];
    const map = new Map<string, InsightFacts>([["b", facts({ primaryStack: ["react"] })]]);
    expect(rerankByInsights(rows, [], map)).toBe(rows);
  });

  it("is an exact no-op with no insights", () => {
    const rows = [row("a"), row("b")];
    expect(rerankByInsights(rows, ["react"], new Map())).toBe(rows);
  });

  it("preserves order when nobody matches (stable, all-zero boost)", () => {
    const rows = [row("a"), row("b"), row("c")];
    const map = new Map<string, InsightFacts>([["a", facts({ primaryStack: ["php"] })]]);
    expect(rerankByInsights(rows, ["react"], map).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("lifts an insight-matching row above an adjacent non-matcher", () => {
    // SQL order: a, b. b matches the query in its facts, a does not.
    const rows = [row("a"), row("b")];
    const map = new Map<string, InsightFacts>([
      ["a", facts({ primaryStack: ["php"] })],
      ["b", facts({ primaryStack: ["react"] })],
    ]);
    // baseRank: a=2, b=1; b gets +8 → b wins.
    expect(rerankByInsights(rows, ["react"], map).map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("cannot leap a bottom row past a far-ahead row (bounded nudge)", () => {
    // 20 rows; only the last matches. Boost is capped at INSIGHT_BOOST_POSITIONS,
    // so it can climb at most ~8 places, never to the top.
    const rows = Array.from({ length: 20 }, (_, i) => row(`r${i}`));
    const map = new Map<string, InsightFacts>([["r19", facts({ primaryStack: ["react"] })]]);
    const out = rerankByInsights(rows, ["react"], map).map((r) => r.id);
    const newPos = out.indexOf("r19");
    expect(newPos).toBeGreaterThan(0); // not the top
    expect(newPos).toBeLessThan(19); // but it did climb
    expect(20 - 1 - newPos).toBeLessThanOrEqual(INSIGHT_BOOST_POSITIONS);
  });
});
