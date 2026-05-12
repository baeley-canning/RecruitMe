import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  recordProviderSuccess,
  recordProviderFailure,
  snapshotProviderHealth,
  __resetProviderHealthForTests,
} from "../provider-health";

describe("providerHealth — state derivation", () => {
  const snapshot = { ...process.env };
  beforeEach(() => {
    __resetProviderHealthForTests();
    // Configure every provider so we exercise the non-"unconfigured" branches.
    process.env.ANTHROPIC_API_KEY = "test";
    process.env.SERPAPI_API_KEY = "test";
    process.env.PDL_API_KEY = "test";
    process.env.FIRMABLE_API_KEY = "test";
    process.env.GITHUB_TOKEN = "test";
    process.env.ENABLE_LOCAL_MODEL_FAILOVER = "true";
    process.env.SEARXNG_BASE_URL = "http://searxng.test";
    process.env.OPENSERP_BASE_URL = "http://openserp.test";
    // Free providers also require SEARCH_PROVIDERS to opt them in. Setting
    // both names so the configured-check passes for the untested-state test.
    process.env.SEARCH_PROVIDERS = "searxng,openserp";
  });
  afterEach(() => { process.env = { ...snapshot }; });

  it("configured but never called → untested", () => {
    const snap = snapshotProviderHealth();
    for (const p of snap) {
      expect(p.state).toBe("untested");
    }
  });

  it("unconfigured providers report state=unconfigured", () => {
    delete process.env.SERPAPI_API_KEY;
    delete process.env.FIRMABLE_API_KEY;
    const snap = snapshotProviderHealth();
    expect(snap.find((p) => p.name === "serpapi")!.state).toBe("unconfigured");
    expect(snap.find((p) => p.name === "firmable")!.state).toBe("unconfigured");
    expect(snap.find((p) => p.name === "claude")!.state).toBe("untested");
  });

  it("recordProviderSuccess flips state to healthy", () => {
    recordProviderSuccess("serpapi");
    const serp = snapshotProviderHealth().find((p) => p.name === "serpapi");
    expect(serp!.state).toBe("healthy");
    expect(serp!.lastSuccessAt).not.toBeNull();
    expect(serp!.consecutiveFailures).toBe(0);
  });

  it("3 consecutive failures flips state to down", () => {
    recordProviderFailure("pdl", "500 Internal Server Error");
    recordProviderFailure("pdl", "500 Internal Server Error");
    expect(snapshotProviderHealth().find((p) => p.name === "pdl")!.state).not.toBe("down");
    recordProviderFailure("pdl", "500 Internal Server Error");
    expect(snapshotProviderHealth().find((p) => p.name === "pdl")!.state).toBe("down");
  });

  it("success after failures resets consecutive counter and recovers state", () => {
    recordProviderFailure("github", "403 forbidden");
    recordProviderFailure("github", "403 forbidden");
    recordProviderFailure("github", "403 forbidden");
    expect(snapshotProviderHealth().find((p) => p.name === "github")!.state).toBe("down");
    recordProviderSuccess("github");
    const gh = snapshotProviderHealth().find((p) => p.name === "github");
    expect(gh!.state).toBe("healthy");
    expect(gh!.consecutiveFailures).toBe(0);
    expect(gh!.lastFailureReason).toBeNull();
  });

  it("one failure (last call) reads as degraded — not down", () => {
    recordProviderFailure("firmable", "transient 502");
    expect(snapshotProviderHealth().find((p) => p.name === "firmable")!.state).toBe("degraded");
  });

  it("success after a single failure flips back to healthy (1-shot recovery)", () => {
    recordProviderFailure("firmable", "transient 502");
    recordProviderSuccess("firmable");
    expect(snapshotProviderHealth().find((p) => p.name === "firmable")!.state).toBe("healthy");
  });

  it("trims very long failure reasons to ~200 chars", () => {
    const longReason = "x".repeat(1000);
    recordProviderFailure("serpapi", longReason);
    const snap = snapshotProviderHealth().find((p) => p.name === "serpapi")!;
    expect(snap.lastFailureReason!.length).toBeLessThanOrEqual(200);
  });
});
