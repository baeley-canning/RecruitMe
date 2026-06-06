import { describe, expect, it } from "vitest";
import { parseBooleanQuery, scoreTextRelevance } from "../boolean-query";

describe("parseBooleanQuery — happy paths", () => {
  it("empty query → empty result, no errors", () => {
    const r = parseBooleanQuery("");
    expect(r).toEqual({
      raw: "",
      mustHave: [],
      anyOf: [],
      mustNot: [],
      hasErrors: false,
      errors: [],
    });
  });

  it("single bare word → mustHave: [x]", () => {
    const r = parseBooleanQuery("engineer");
    expect(r.mustHave).toEqual(["engineer"]);
    expect(r.anyOf).toEqual([]);
    expect(r.mustNot).toEqual([]);
    expect(r.hasErrors).toBe(false);
  });

  it("single quoted phrase preserved as one element", () => {
    const r = parseBooleanQuery('"tech lead"');
    expect(r.mustHave).toEqual(["tech lead"]);
    expect(r.hasErrors).toBe(false);
  });

  it("two bare words → implicit AND", () => {
    const r = parseBooleanQuery("tech lead");
    expect(r.mustHave).toEqual(["tech", "lead"]);
    expect(r.anyOf).toEqual([]);
    expect(r.hasErrors).toBe(false);
  });

  it("two quoted phrases with explicit AND", () => {
    const r = parseBooleanQuery('"X" AND "Y"');
    expect(r.mustHave).toEqual(["x", "y"]);
    expect(r.anyOf).toEqual([]);
    expect(r.hasErrors).toBe(false);
  });

  it("two quoted phrases implicit AND matches explicit AND", () => {
    const a = parseBooleanQuery('"X" "Y"');
    const b = parseBooleanQuery('"X" AND "Y"');
    expect(a.mustHave).toEqual(b.mustHave);
    expect(a.anyOf).toEqual(b.anyOf);
  });

  it("OR between two terms → one anyOf group", () => {
    const r = parseBooleanQuery('"X" OR "Y"');
    expect(r.mustHave).toEqual([]);
    expect(r.anyOf).toEqual([["x", "y"]]);
    expect(r.hasErrors).toBe(false);
  });

  it("paren OR group AND another term", () => {
    const r = parseBooleanQuery('("X" OR "Y") AND "Z"');
    expect(r.anyOf).toEqual([["x", "y"]]);
    expect(r.mustHave).toEqual(["z"]);
    expect(r.hasErrors).toBe(false);
  });

  it("multiple OR groups separated by AND", () => {
    const r = parseBooleanQuery('("A" OR "B") AND ("C" OR "D")');
    expect(r.anyOf).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(r.mustHave).toEqual([]);
    expect(r.hasErrors).toBe(false);
  });

  it("NOT operator → mustNot", () => {
    const r = parseBooleanQuery('"X" NOT "Y"');
    expect(r.mustHave).toEqual(["x"]);
    expect(r.mustNot).toEqual(["y"]);
    expect(r.hasErrors).toBe(false);
  });

  it("-term shorthand → mustNot", () => {
    const r = parseBooleanQuery('"engineer" -"intern"');
    expect(r.mustHave).toEqual(["engineer"]);
    expect(r.mustNot).toEqual(["intern"]);
    expect(r.hasErrors).toBe(false);
  });

  it("-bareword shorthand → mustNot", () => {
    const r = parseBooleanQuery("engineer -intern");
    expect(r.mustHave).toEqual(["engineer"]);
    expect(r.mustNot).toEqual(["intern"]);
    expect(r.hasErrors).toBe(false);
  });

  it("hyphen inside bareword is not a negation", () => {
    const r = parseBooleanQuery("full-stack");
    expect(r.mustHave).toEqual(["full-stack"]);
    expect(r.mustNot).toEqual([]);
    expect(r.hasErrors).toBe(false);
  });

  it("mixed: paren OR + AND + NOT shorthand", () => {
    const r = parseBooleanQuery('("CTO" OR "VP Eng") AND "saas" -"junior"');
    expect(r.anyOf).toEqual([["cto", "vp eng"]]);
    expect(r.mustHave).toEqual(["saas"]);
    expect(r.mustNot).toEqual(["junior"]);
    expect(r.hasErrors).toBe(false);
  });

  it("operators are case-insensitive (lowercase)", () => {
    const r = parseBooleanQuery('"X" or "Y" and "Z" not "W"');
    expect(r.anyOf).toEqual([["x", "y"]]);
    expect(r.mustHave).toEqual(["z"]);
    expect(r.mustNot).toEqual(["w"]);
    expect(r.hasErrors).toBe(false);
  });

  it("operators are case-insensitive (mixed case)", () => {
    const r = parseBooleanQuery('"X" Or "Y" aNd "Z"');
    expect(r.anyOf).toEqual([["x", "y"]]);
    expect(r.mustHave).toEqual(["z"]);
  });

  it("term content is lowercased on output", () => {
    const r = parseBooleanQuery('"Tech Lead" AND ENGINEER');
    expect(r.mustHave).toEqual(["tech lead", "engineer"]);
  });

  it("raw string is preserved exactly", () => {
    const q = '  "Tech Lead"  OR  "Engineering Manager"  ';
    const r = parseBooleanQuery(q);
    expect(r.raw).toBe(q);
  });
});

describe("parseBooleanQuery — edge cases", () => {
  it("unbalanced quote at end → hasErrors, term still captured", () => {
    const r = parseBooleanQuery('"tech lead');
    expect(r.hasErrors).toBe(true);
    expect(r.errors.some((e) => /Unbalanced quote/i.test(e))).toBe(true);
    expect(r.mustHave).toEqual(["tech lead"]);
  });

  it("dangling operator at end → hasErrors, left side preserved", () => {
    const r = parseBooleanQuery('"X" OR');
    expect(r.hasErrors).toBe(true);
    expect(r.mustHave).toEqual(["x"]);
    expect(r.anyOf).toEqual([]);
  });

  it("only an operator → hasErrors, empty result", () => {
    const r = parseBooleanQuery("OR");
    expect(r.hasErrors).toBe(true);
    expect(r.mustHave).toEqual([]);
    expect(r.anyOf).toEqual([]);
    expect(r.mustNot).toEqual([]);
  });

  it("only AND → hasErrors, empty result", () => {
    const r = parseBooleanQuery("AND");
    expect(r.hasErrors).toBe(true);
    expect(r.mustHave).toEqual([]);
  });

  it("empty quoted phrase → skipped, hasErrors", () => {
    const r = parseBooleanQuery('"" "real"');
    expect(r.hasErrors).toBe(true);
    expect(r.errors.some((e) => /Empty quoted phrase/i.test(e))).toBe(true);
    expect(r.mustHave).toEqual(["real"]);
  });

  it("whitespace-only quoted phrase is treated as empty", () => {
    const r = parseBooleanQuery('"   "');
    expect(r.hasErrors).toBe(true);
    expect(r.mustHave).toEqual([]);
  });

  it("multi-line query (newlines) treated as whitespace", () => {
    const r = parseBooleanQuery('"tech lead"\nOR\n"engineering manager"');
    expect(r.anyOf).toEqual([["tech lead", "engineering manager"]]);
    expect(r.hasErrors).toBe(false);
  });

  it("garbage punctuation does not throw and does not crash", () => {
    expect(() => parseBooleanQuery("!!! @@@ ### $$$ %%%")).not.toThrow();
    const r = parseBooleanQuery("!!! @@@ ### $$$ %%%");
    // Each chunk is a bareword; not pretty but it's not a crash.
    expect(r.mustHave.length).toBeGreaterThan(0);
  });

  it("very long query (1000 chars) does not throw", () => {
    const long = '"a" '.repeat(250).trim(); // ~1000 chars of '"a" "a" "a" ...'
    expect(() => parseBooleanQuery(long)).not.toThrow();
    const r = parseBooleanQuery(long);
    expect(r.mustHave.length).toBe(250);
  });

  it("unbalanced parenthesis is reported but doesn't crash", () => {
    const r = parseBooleanQuery('("X" OR "Y"');
    expect(r.hasErrors).toBe(true);
    expect(r.anyOf).toEqual([["x", "y"]]);
  });

  it("stray closing paren is reported but doesn't crash", () => {
    const r = parseBooleanQuery('"X")');
    expect(r.hasErrors).toBe(true);
    expect(r.mustHave).toEqual(["x"]);
  });

  it("non-string input (cast) returns safe empty result", () => {
    // Force the runtime branch: callers may pass undefined via API payload.
    const r = parseBooleanQuery(undefined as unknown as string);
    expect(r.raw).toBe("");
    expect(r.mustHave).toEqual([]);
    expect(r.hasErrors).toBe(false);
  });

  it("OR after bareword promotes left term into anyOf group", () => {
    const r = parseBooleanQuery("engineer OR developer");
    expect(r.mustHave).toEqual([]);
    expect(r.anyOf).toEqual([["engineer", "developer"]]);
  });

  it("OR with paren RHS attaches preceding term to the group", () => {
    const r = parseBooleanQuery('"X" OR ("Y" OR "Z")');
    expect(r.anyOf).toEqual([["x", "y", "z"]]);
    expect(r.mustHave).toEqual([]);
  });
});

describe("scoreTextRelevance — local relevance for unscored scraper cards", () => {
  const q = parseBooleanQuery('"PHP" OR "Laravel" OR "SilverStripe" AND ("Senior" OR "Intermediate")');

  it("returns 0 for empty text", () => {
    expect(scoreTextRelevance(q, "")).toBe(0);
    expect(scoreTextRelevance(q, "   ")).toBe(0);
  });

  it("a card hitting every group scores 1", () => {
    const score = scoreTextRelevance(
      parseBooleanQuery('"PHP" AND ("Senior" OR "Lead")'),
      "Senior PHP Developer at Acme",
    );
    expect(score).toBe(1);
  });

  it("partial match scores between 0 and 1", () => {
    // mustHave "react" present, the (aws OR gcp) group absent → 1 of 2 satisfied.
    const score = scoreTextRelevance(
      parseBooleanQuery('"React" AND ("AWS" OR "GCP")'),
      "React frontend engineer, Wellington",
    );
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
    expect(score).toBeCloseTo(0.5, 5);
  });

  it("a mustNot hit zeroes the score even with other matches", () => {
    const score = scoreTextRelevance(
      parseBooleanQuery('"PHP" -"recruiter"'),
      "PHP developer and technical recruiter",
    );
    expect(score).toBe(0);
  });

  it("higher relevance for a stronger card → orders scraper cards sensibly", () => {
    const strong = scoreTextRelevance(q, "Senior Full-Stack Developer — PHP | Laravel | SilverStripe");
    const weak = scoreTextRelevance(q, "Office Manager");
    expect(strong).toBeGreaterThan(weak);
  });
});
