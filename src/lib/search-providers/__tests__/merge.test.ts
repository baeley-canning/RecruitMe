import { describe, expect, it } from "vitest";
import { mergeProviderHits } from "../merge";
import type { ProviderSearchHit } from "../types";

const hit = (overrides: Partial<ProviderSearchHit>): ProviderSearchHit => ({
  title: "Test", url: "https://example.com", snippet: "", provider: "searxng", rank: 0,
  ...overrides,
});

describe("mergeProviderHits", () => {
  it("dedupes the same LinkedIn URL across providers via canonicalizeUrl", () => {
    // SearXNG returned the noisy version, OpenSERP the clean one.
    const result = mergeProviderHits({
      searxng:  [hit({ provider: "searxng",  url: "https://nz.linkedin.com/in/jane-smith?trk=abc", rank: 0 })],
      openserp: [hit({ provider: "openserp", url: "https://www.linkedin.com/in/jane-smith",        rank: 2 })],
    });
    expect(result).toHaveLength(1);
    expect(result[0].providers.searxng?.rank).toBe(0);
    expect(result[0].providers.openserp?.rank).toBe(2);
  });

  it("preserves rank from each provider when duplicates collapse", () => {
    const result = mergeProviderHits({
      searxng:  [hit({ provider: "searxng",  url: "https://linkedin.com/in/a", rank: 3 })],
      openserp: [hit({ provider: "openserp", url: "https://linkedin.com/in/a", rank: 7 })],
    });
    expect(result[0].providers).toEqual({ searxng: { rank: 3 }, openserp: { rank: 7 } });
  });

  it("keeps the longer title / snippet when providers disagree", () => {
    const result = mergeProviderHits({
      searxng:  [hit({ url: "https://linkedin.com/in/a", title: "Jane",                              snippet: "Short" })],
      openserp: [hit({ url: "https://linkedin.com/in/a", title: "Jane Smith - Senior Eng at Xero", snippet: "A much longer snippet with employer + location" })],
    });
    expect(result[0].title).toBe("Jane Smith - Senior Eng at Xero");
    expect(result[0].snippet).toContain("longer snippet");
  });

  it("keeps unique URLs from both providers", () => {
    const result = mergeProviderHits({
      searxng:  [hit({ url: "https://linkedin.com/in/a" })],
      openserp: [hit({ url: "https://linkedin.com/in/b" })],
    });
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.canonicalUrl).sort()).toEqual([
      "https://www.linkedin.com/in/a",
      "https://www.linkedin.com/in/b",
    ]);
  });

  it("returns empty when input is empty", () => {
    expect(mergeProviderHits({})).toEqual([]);
    expect(mergeProviderHits({ searxng: [] })).toEqual([]);
  });

  it("skips hits with no URL", () => {
    expect(mergeProviderHits({ searxng: [hit({ url: "" })] })).toEqual([]);
  });

  it("collapses LinkedIn slug aliases — `/in/jane-smith` and `/in/jane-smith-1a2b3c4d` are the same person", () => {
    const result = mergeProviderHits({
      searxng:  [hit({ provider: "searxng",  url: "https://www.linkedin.com/in/jane-smith",          rank: 4 })],
      openserp: [hit({ provider: "openserp", url: "https://www.linkedin.com/in/jane-smith-1a2b3c4d", rank: 1 })],
    });
    expect(result).toHaveLength(1);
    // Cleaner slug wins as primary when provider counts tie (both saw it once).
    expect(result[0].canonicalUrl).toBe("https://www.linkedin.com/in/jane-smith");
    expect(result[0].providers.searxng?.rank).toBe(4);
    expect(result[0].providers.openserp?.rank).toBe(1);
  });

  it("keeps the entry with MORE provider confirmations as primary in an alias collapse", () => {
    const result = mergeProviderHits({
      searxng:  [
        hit({ provider: "searxng",  url: "https://www.linkedin.com/in/jane-smith-1a2b3c4d", rank: 2 }),
      ],
      openserp: [
        hit({ provider: "openserp", url: "https://www.linkedin.com/in/jane-smith",          rank: 5 }),
        hit({ provider: "openserp", url: "https://www.linkedin.com/in/jane-smith-1a2b3c4d", rank: 8 }),
      ],
    });
    // After first-pass merge: `jane-smith` has 1 provider, `jane-smith-1a2b3c4d` has 2.
    // Alias collapse picks the 2-provider entry as primary.
    expect(result).toHaveLength(1);
    expect(result[0].canonicalUrl).toBe("https://www.linkedin.com/in/jane-smith-1a2b3c4d");
    // Best (lowest) rank from each provider is preserved.
    expect(result[0].providers.searxng?.rank).toBe(2);
    expect(result[0].providers.openserp?.rank).toBe(5);
  });

  it("does NOT collapse short slug aliases (length < 6) to avoid false positives", () => {
    // `ab` and `cd` are too short to safely match — keep as separate.
    const result = mergeProviderHits({
      searxng:  [hit({ url: "https://www.linkedin.com/in/ab" })],
      openserp: [hit({ url: "https://www.linkedin.com/in/cd" })],
    });
    expect(result).toHaveLength(2);
  });

  it("does NOT collapse non-LinkedIn URLs via slug-alias dedupe", () => {
    // GitHub profile pages share characters but should NEVER be alias-merged.
    const result = mergeProviderHits({
      searxng:  [hit({ url: "https://github.com/janesmith" })],
      openserp: [hit({ url: "https://github.com/janesmith-fork-of-some-repo" })],
    });
    expect(result).toHaveLength(2);
  });

  it("merges title/snippet across alias-collapsed entries — keeps the longer one", () => {
    const result = mergeProviderHits({
      searxng:  [hit({ url: "https://www.linkedin.com/in/jane-smith",          title: "Jane",                              snippet: "" })],
      openserp: [hit({ url: "https://www.linkedin.com/in/jane-smith-1a2b3c4d", title: "Jane Smith — Senior Eng at Xero", snippet: "Wellington, NZ" })],
    });
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Jane Smith — Senior Eng at Xero");
    expect(result[0].snippet).toBe("Wellington, NZ");
  });
});
