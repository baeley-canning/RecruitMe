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

  // ── Fatal-failure fast-path ─────────────────────────────────────────────
  // Credit exhaustion / auth failures don't recover on retry, so the badge
  // shouldn't wait for 3 in a row to confirm. One fatal-pattern failure
  // should flip the state straight to "down".

  it("credit-exhausted failure flips Claude to down on first hit", () => {
    recordProviderFailure("claude", "Credit balance is too low to complete this request");
    expect(snapshotProviderHealth().find((p) => p.name === "claude")!.state).toBe("down");
  });

  it("'quota exceeded' phrasing also counts as fatal", () => {
    recordProviderFailure("serpapi", "quota exceeded for this account");
    expect(snapshotProviderHealth().find((p) => p.name === "serpapi")!.state).toBe("down");
  });

  it("401/403 auth failures flip immediately to down", () => {
    recordProviderFailure("firmable", "401 Unauthorized");
    expect(snapshotProviderHealth().find((p) => p.name === "firmable")!.state).toBe("down");
    recordProviderFailure("github", "403 forbidden — bad credentials");
    expect(snapshotProviderHealth().find((p) => p.name === "github")!.state).toBe("down");
  });

  it("'invalid API key' phrasing flips immediately to down", () => {
    recordProviderFailure("claude", "Invalid API key — please check your credentials");
    expect(snapshotProviderHealth().find((p) => p.name === "claude")!.state).toBe("down");
  });

  it("transient failures (rate limit / 5xx) still take 3 to be down", () => {
    recordProviderFailure("pdl", "rate limit exceeded, retry later");
    // "rate limit" alone doesn't match the fatal regex (no credit/auth keyword)
    // — wait, "exceeded" doesn't match either since we tightened earlier.
    // Actually "limit exceeded" contains "exceeded" which isn't in our regex.
    // So this is just a regular failure → degraded after 1, not down.
    expect(snapshotProviderHealth().find((p) => p.name === "pdl")!.state).toBe("degraded");
    recordProviderFailure("pdl", "500 Internal Server Error");
    recordProviderFailure("pdl", "504 Gateway Timeout");
    expect(snapshotProviderHealth().find((p) => p.name === "pdl")!.state).toBe("down");
  });

  it("a single success after a fatal failure clears it back to healthy", () => {
    recordProviderFailure("claude", "Credit balance too low");
    expect(snapshotProviderHealth().find((p) => p.name === "claude")!.state).toBe("down");
    recordProviderSuccess("claude");
    expect(snapshotProviderHealth().find((p) => p.name === "claude")!.state).toBe("healthy");
  });
});
