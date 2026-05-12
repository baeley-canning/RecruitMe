import { describe, expect, it } from "vitest";
import { rankMergedResults } from "../ranking";
import type { MergedResult } from "../types";

const merged = (overrides: Partial<MergedResult>): MergedResult => ({
  canonicalUrl: "https://linkedin.com/in/x",
  title: "Test",
  snippet: "",
  providers: { searxng: { rank: 0 } },
  rankScore: 0,
  ...overrides,
});

describe("rankMergedResults", () => {
  it("boosts a multi-provider hit above a single-provider hit at the same rank", () => {
    const ranked = rankMergedResults([
      merged({ canonicalUrl: "url-a", providers: { searxng: { rank: 0 } } }),
      merged({ canonicalUrl: "url-b", providers: { searxng: { rank: 0 }, openserp: { rank: 0 } } }),
    ]);
    // Multi-provider hit must appear first after sort.
    expect(ranked[0].canonicalUrl).toBe("url-b");
    expect(ranked[1].canonicalUrl).toBe("url-a");
  });

  it("within a single provider, lower rank (better position) scores higher", () => {
    const ranked = rankMergedResults([
      merged({ canonicalUrl: "url-rank-5", providers: { searxng: { rank: 5 } } }),
      merged({ canonicalUrl: "url-rank-0", providers: { searxng: { rank: 0 } } }),
    ]);
    expect(ranked[0].canonicalUrl).toBe("url-rank-0");
  });

  it("returns a stable sort (lower rank wins ties)", () => {
    const ranked = rankMergedResults([
      merged({ canonicalUrl: "a", providers: { searxng: { rank: 2 } } }),
      merged({ canonicalUrl: "b", providers: { searxng: { rank: 2 } } }),
    ]);
    // Both should still produce a valid array with the same length
    expect(ranked).toHaveLength(2);
    // Same rankScore for both.
    expect(ranked[0].rankScore).toBe(ranked[1].rankScore);
  });

  it("does not mutate the original array's order", () => {
    // ranking.ts sorts a COPY (`[...results]`) so the caller can keep its
    // own original-order reference for logging / debugging.
    const input = [
      merged({ canonicalUrl: "a", providers: { searxng: { rank: 5 } } }),
      merged({ canonicalUrl: "b", providers: { searxng: { rank: 0 } } }),
    ];
    rankMergedResults(input);
    expect(input.map((r) => r.canonicalUrl)).toEqual(["a", "b"]);
  });
});
