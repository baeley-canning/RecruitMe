import { describe, expect, it } from "vitest";
import { runProviderSearch } from "../manager";
import type { ProviderSearchHit, SearchProvider } from "../types";

const fake = (
  name: "searxng" | "openserp",
  result: ProviderSearchHit[] | Promise<ProviderSearchHit[]>,
): SearchProvider => ({
  name,
  enabled: () => true,
  search: () => (result instanceof Promise ? result : Promise.resolve(result)),
});

const hit = (provider: "searxng" | "openserp", overrides: Partial<ProviderSearchHit> = {}): ProviderSearchHit => ({
  title: "T", url: "https://linkedin.com/in/x", snippet: "", provider, rank: 0, ...overrides,
});

describe("runProviderSearch — parallel dispatch + partial-result resilience", () => {
  it("returns empty result when no providers are passed (and none configured via env)", async () => {
    const result = await runProviderSearch({ query: "x" }, []);
    expect(result.byProvider).toEqual({});
    expect(result.outcomes).toEqual([]);
  });

  it("returns hits keyed by provider when both succeed", async () => {
    const result = await runProviderSearch({ query: "x" }, [
      fake("searxng",  [hit("searxng",  { url: "https://linkedin.com/in/a" })]),
      fake("openserp", [hit("openserp", { url: "https://linkedin.com/in/b" })]),
    ]);
    expect(result.byProvider.searxng).toHaveLength(1);
    expect(result.byProvider.openserp).toHaveLength(1);
    expect(result.outcomes.map((o) => o.provider).sort()).toEqual(["openserp", "searxng"]);
    expect(result.outcomes.every((o) => !o.error)).toBe(true);
  });

  it("returns partial results when one provider throws — does NOT bail", async () => {
    const failing: SearchProvider = {
      name: "searxng", enabled: () => true,
      search: () => Promise.reject(new Error("network down")),
    };
    const working = fake("openserp", [hit("openserp")]);
    const result = await runProviderSearch({ query: "x" }, [failing, working]);
    expect(result.byProvider.searxng).toEqual([]);
    expect(result.byProvider.openserp).toHaveLength(1);
    const failed = result.outcomes.find((o) => o.provider === "searxng");
    expect(failed?.error).toMatch(/network down/);
  });

  it("times out a slow provider without blocking faster ones", async () => {
    // Slow provider takes 5s; manager applies a 50ms timeout via opts.
    const slow: SearchProvider = {
      name: "searxng", enabled: () => true,
      search: () => new Promise((resolve) => setTimeout(() => resolve([hit("searxng")]), 5000)),
    };
    const fastResult = fake("openserp", [hit("openserp")]);

    const start = Date.now();
    const result = await runProviderSearch({ query: "x", timeoutMs: 50 }, [slow, fastResult]);
    const elapsed = Date.now() - start;

    // Should complete in well under the 5s slow-provider time
    expect(elapsed).toBeLessThan(500);
    expect(result.byProvider.openserp).toHaveLength(1);
    expect(result.byProvider.searxng).toEqual([]);
    const slowOutcome = result.outcomes.find((o) => o.provider === "searxng");
    expect(slowOutcome?.error).toMatch(/timeout/i);
  });

  it("records duration per provider in outcomes (useful for ops debugging)", async () => {
    const result = await runProviderSearch({ query: "x" }, [fake("searxng", [hit("searxng")])]);
    expect(result.outcomes[0]).toHaveProperty("durationMs");
    expect(typeof result.outcomes[0].durationMs).toBe("number");
  });

  // Critic-flagged edge case: when every provider times out (e.g. all
  // self-hosted instances are down), the search should still return an
  // empty result rather than throw. The route can then fall back to the
  // existing SerpAPI / Bing path.
  it("returns empty byProvider + per-provider timeout outcomes when ALL providers fail", async () => {
    const slow1: SearchProvider = {
      name: "searxng", enabled: () => true,
      search: () => new Promise((resolve) => setTimeout(() => resolve([]), 5000)),
    };
    const slow2: SearchProvider = {
      name: "openserp", enabled: () => true,
      search: () => new Promise((resolve) => setTimeout(() => resolve([]), 5000)),
    };
    const result = await runProviderSearch({ query: "x", timeoutMs: 30 }, [slow1, slow2]);
    expect(result.byProvider.searxng).toEqual([]);
    expect(result.byProvider.openserp).toEqual([]);
    expect(result.outcomes.every((o) => o.error?.match(/timeout/i))).toBe(true);
  });
});
