import { describe, expect, it } from "vitest";
import { mergedResultsToSearchResults } from "../adapter";
import type { MergedResult } from "../types";

const merged = (overrides: Partial<MergedResult>): MergedResult => ({
  canonicalUrl: "https://www.linkedin.com/in/jane-smith",
  title: "Jane Smith - Senior Engineer at Xero | LinkedIn",
  snippet: "Wellington, NZ. Senior Software Engineer with 8 years.",
  providers: { searxng: { rank: 0 } },
  rankScore: 0,
  ...overrides,
});

describe("mergedResultsToSearchResults — adapter to existing internal shape", () => {
  it("parses name + headline from the title via the existing helper", () => {
    const out = mergedResultsToSearchResults([merged({})]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      name: "Jane Smith",
      headline: "Senior Engineer at Xero",
      linkedinUrl: "https://www.linkedin.com/in/jane-smith",
    });
  });

  it("filters out non-LinkedIn URLs (the existing parser's contract)", () => {
    const out = mergedResultsToSearchResults([
      merged({ canonicalUrl: "https://github.com/janesmith", title: "Jane Smith" }),
    ]);
    expect(out).toEqual([]);
  });

  it("attributes source to the provider with the lowest rank", () => {
    // SearXNG had it at rank 0, OpenSERP at rank 3 — source should be searxng.
    const out = mergedResultsToSearchResults([
      merged({
        canonicalUrl: "https://www.linkedin.com/in/a",
        title: "Alice Adams - Software Engineer",
        providers: { searxng: { rank: 0 }, openserp: { rank: 3 } },
      }),
    ]);
    expect(out[0].source).toBe("searxng");
  });

  it("returns empty array on empty input", () => {
    expect(mergedResultsToSearchResults([])).toEqual([]);
  });
});
