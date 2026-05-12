/**
 * Route-integration safety net for the free-providers wiring.
 *
 * Goal: verify the route's `executeSearchTask` produces a SearchTaskOutcome
 * for the "free-providers" path that has the SAME SHAPE as the SerpAPI
 * outcomes — so the downstream pipeline (dedupe, country gate, scoring)
 * doesn't notice any difference.
 *
 * We exercise the full chain: runProviderSearch (mocked at provider level)
 * → mergeProviderHits → rankMergedResults → mergedResultsToSearchResults.
 * Anything that diverges from the existing SerpAPI outcome shape would
 * break route.ts's primaryOutcomes merge.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveEnabledProviders, runProviderSearch } from "../manager";
import { mergeProviderHits } from "../merge";
import { rankMergedResults } from "../ranking";
import { mergedResultsToSearchResults } from "../adapter";
import type { ProviderSearchHit, SearchProvider } from "../types";

const provider = (name: "searxng" | "openserp", hits: ProviderSearchHit[]): SearchProvider => ({
  name, enabled: () => true,
  search: () => Promise.resolve(hits),
});

describe("free-providers end-to-end integration shape", () => {
  it("emits SearchResult[] in the existing internal shape (name/headline/location/linkedinUrl/snippet/source)", async () => {
    const sx = provider("searxng", [
      { title: "Jane Smith - Senior Engineer at Xero | LinkedIn", url: "https://linkedin.com/in/jane-smith", snippet: "Wellington, NZ. 8 years experience.", provider: "searxng", rank: 0 },
    ]);
    const op = provider("openserp", [
      { title: "John Doe - Software Developer at Datacom", url: "https://linkedin.com/in/john-doe", snippet: "Auckland, NZ.", provider: "openserp", rank: 1 },
    ]);

    const { byProvider } = await runProviderSearch({ query: "Senior Engineer" }, [sx, op]);
    const merged = mergeProviderHits(byProvider);
    const ranked = rankMergedResults(merged);
    const items = mergedResultsToSearchResults(ranked);

    expect(items).toHaveLength(2);
    for (const item of items) {
      // Same field set the downstream route relies on.
      expect(item).toHaveProperty("name");
      expect(item).toHaveProperty("headline");
      expect(item).toHaveProperty("location");
      expect(item).toHaveProperty("linkedinUrl");
      expect(item).toHaveProperty("snippet");
      expect(item).toHaveProperty("source");
      // Source must be one of the new free-provider names (not "manual"
      // / "extension" / etc.).
      expect(["searxng", "openserp"]).toContain(item.source);
    }
  });

  it("dedup collapses the same LinkedIn URL from two providers into one final SearchResult", async () => {
    const sx = provider("searxng", [
      { title: "Jane Smith - Lead", url: "https://nz.linkedin.com/in/jane-smith?trk=x", snippet: "S1", provider: "searxng", rank: 0 },
    ]);
    const op = provider("openserp", [
      { title: "Jane Smith - Senior Engineer at Xero", url: "https://www.linkedin.com/in/jane-smith", snippet: "S2 longer", provider: "openserp", rank: 2 },
    ]);

    const { byProvider } = await runProviderSearch({ query: "x" }, [sx, op]);
    const merged = mergeProviderHits(byProvider);
    const items = mergedResultsToSearchResults(rankMergedResults(merged));

    expect(items).toHaveLength(1);
    // Should attribute to searxng (lower rank wins).
    expect(items[0].source).toBe("searxng");
    // The LinkedIn URL should be canonical (www.linkedin.com).
    expect(items[0].linkedinUrl).toContain("www.linkedin.com");
  });

  it("zero providers → zero items (the route's default-off behaviour)", async () => {
    const { byProvider, outcomes } = await runProviderSearch({ query: "x" }, []);
    expect(byProvider).toEqual({});
    expect(outcomes).toEqual([]);
    expect(mergedResultsToSearchResults(rankMergedResults(mergeProviderHits(byProvider)))).toEqual([]);
  });

  it("all providers failing → empty items + per-provider error in outcomes", async () => {
    const failing: SearchProvider = { name: "searxng", enabled: () => true, search: () => Promise.reject(new Error("network")) };
    const { byProvider, outcomes } = await runProviderSearch({ query: "x" }, [failing]);
    expect(byProvider.searxng).toEqual([]);
    expect(outcomes[0].error).toMatch(/network/);
    // Downstream pipeline must still produce a valid (empty) SearchResult[].
    const items = mergedResultsToSearchResults(rankMergedResults(mergeProviderHits(byProvider)));
    expect(items).toEqual([]);
  });
});

describe("behaviour parity: SEARCH_PROVIDERS unset → no free providers run, route falls back to SerpAPI-only", () => {
  const envSnapshot = { ...process.env };
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.SEARCH_PROVIDERS;
    delete process.env.SEARXNG_BASE_URL;
    delete process.env.OPENSERP_BASE_URL;
  });
  afterEach(() => { process.env = { ...envSnapshot }; });

  it("resolveEnabledProviders() returns an empty array when SEARCH_PROVIDERS is unset", () => {
    expect(resolveEnabledProviders()).toEqual([]);
  });

  it("runProviderSearch() returns empty byProvider + empty outcomes AND does not call fetch when SEARCH_PROVIDERS is unset", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await runProviderSearch({ query: "Senior Engineer", location: "Wellington" });
    expect(result.byProvider).toEqual({});
    expect(result.outcomes).toEqual([]);
    // The critical invariant: NO network call. If this fails, the route is
    // hitting free-provider endpoints even when the recruiter hasn't
    // opted into them, which is the byte-identical-baseline contract.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("resolveEnabledProviders() returns ONLY searxng when only SEARXNG_BASE_URL is set", () => {
    process.env.SEARCH_PROVIDERS  = "searxng,openserp";
    process.env.SEARXNG_BASE_URL  = "http://localhost:8080";
    // OPENSERP_BASE_URL deliberately unset.
    const resolved = resolveEnabledProviders();
    expect(resolved.map((p) => p.name)).toEqual(["searxng"]);
  });

  it("resolveEnabledProviders() returns an empty array when SEARCH_PROVIDERS lists providers but no base URLs are set", () => {
    process.env.SEARCH_PROVIDERS = "searxng,openserp";
    // Both base URLs unset.
    expect(resolveEnabledProviders()).toEqual([]);
  });
});
