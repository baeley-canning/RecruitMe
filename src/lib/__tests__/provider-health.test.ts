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
    process.env.OPENAI_API_KEY = "test";
    process.env.PDL_API_KEY = "test";
    process.env.GITHUB_TOKEN = "test";
  });
  afterEach(() => { process.env = { ...snapshot }; });

  it("configured but never called → untested", () => {
    const snap = snapshotProviderHealth();
    for (const p of snap) {
      expect(p.state).toBe("untested");
    }
  });

  it("unconfigured providers report state=unconfigured", () => {
    delete process.env.PDL_API_KEY;
    const snap = snapshotProviderHealth();
    expect(snap.find((p) => p.name === "pdl")!.state).toBe("unconfigured");
    expect(snap.find((p) => p.name === "claude")!.state).toBe("untested");
  });

  it("recordProviderSuccess flips state to healthy", () => {
    recordProviderSuccess("pdl");
    const serp = snapshotProviderHealth().find((p) => p.name === "pdl");
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

  it("success after sustained failures decrements toward recovery (no instant flip)", () => {
    // Use a non-fatal failure pattern so the trigger is 3 consecutive,
    // not the fatal fast-path.
    recordProviderFailure("github", "500 server error");
    recordProviderFailure("github", "500 server error");
    recordProviderFailure("github", "500 server error");
    expect(snapshotProviderHealth().find((p) => p.name === "github")!.state).toBe("down");

    // First success: degrades but stays sub-healthy (still 2 failures on record)
    recordProviderSuccess("github");
    expect(snapshotProviderHealth().find((p) => p.name === "github")!.consecutiveFailures).toBe(2);

    // Second success: still 1 failure
    recordProviderSuccess("github");
    expect(snapshotProviderHealth().find((p) => p.name === "github")!.consecutiveFailures).toBe(1);

    // Third success: cleared, badge reads healthy
    recordProviderSuccess("github");
    const gh = snapshotProviderHealth().find((p) => p.name === "github");
    expect(gh!.consecutiveFailures).toBe(0);
    expect(gh!.state).toBe("healthy");
    expect(gh!.lastFailureReason).toBeNull();
  });

  it("one failure (last call) reads as degraded — not down", () => {
    recordProviderFailure("pdl", "transient 502");
    expect(snapshotProviderHealth().find((p) => p.name === "pdl")!.state).toBe("degraded");
  });

  it("success after a single failure flips back to healthy (1-shot recovery)", () => {
    recordProviderFailure("pdl", "transient 502");
    recordProviderSuccess("pdl");
    expect(snapshotProviderHealth().find((p) => p.name === "pdl")!.state).toBe("healthy");
  });

  it("trims very long failure reasons to ~200 chars", () => {
    const longReason = "x".repeat(1000);
    recordProviderFailure("pdl", longReason);
    const snap = snapshotProviderHealth().find((p) => p.name === "pdl")!;
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
    recordProviderFailure("pdl", "quota exceeded for this account");
    expect(snapshotProviderHealth().find((p) => p.name === "pdl")!.state).toBe("down");
  });

  it("401/403 auth failures flip immediately to down", () => {
    recordProviderFailure("pdl", "401 Unauthorized");
    expect(snapshotProviderHealth().find((p) => p.name === "pdl")!.state).toBe("down");
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

  it("a fatal failure requires 3 successes to fully recover (no grace-period flap)", () => {
    recordProviderFailure("claude", "Credit balance is too low to complete this request");
    expect(snapshotProviderHealth().find((p) => p.name === "claude")!.state).toBe("down");

    // First lucky success during Anthropic grace period — still 2 on record
    recordProviderSuccess("claude");
    expect(snapshotProviderHealth().find((p) => p.name === "claude")!.consecutiveFailures).toBe(2);
    expect(snapshotProviderHealth().find((p) => p.name === "claude")!.state).toBe("degraded");

    // Two more sustained successes clear it
    recordProviderSuccess("claude");
    recordProviderSuccess("claude");
    expect(snapshotProviderHealth().find((p) => p.name === "claude")!.consecutiveFailures).toBe(0);
    expect(snapshotProviderHealth().find((p) => p.name === "claude")!.state).toBe("healthy");
  });

  // ── Regex tightening: false-positive guard ────────────────────────────
  // The previous bare-word regex would flip these to "down" incorrectly.
  // Tightened patterns require the fatal word to appear in context.

  it("does NOT flag 'load balancer timeout' as fatal (bare 'balance' false positive)", () => {
    recordProviderFailure("pdl", "load balancer timeout after 30s");
    // One non-fatal failure → degraded, not down
    expect(snapshotProviderHealth().find((p) => p.name === "pdl")!.state).toBe("degraded");
  });

  it("does NOT flag '401-byte response from upstream' as fatal (bare '401' false positive)", () => {
    recordProviderFailure("github", "received 401-byte response from upstream");
    expect(snapshotProviderHealth().find((p) => p.name === "github")!.state).toBe("degraded");
  });

  it("DOES flag 'HTTP 401 Unauthorized' as fatal", () => {
    recordProviderFailure("pdl", "HTTP 401 Unauthorized");
    expect(snapshotProviderHealth().find((p) => p.name === "pdl")!.state).toBe("down");
  });

  it("DOES flag 'account suspended' as fatal", () => {
    recordProviderFailure("pdl", "account suspended due to billing issue");
    expect(snapshotProviderHealth().find((p) => p.name === "pdl")!.state).toBe("down");
  });

  it("DOES flag 'subscription expired' as fatal", () => {
    recordProviderFailure("pdl", "Your subscription expired on 2026-01-01");
    expect(snapshotProviderHealth().find((p) => p.name === "pdl")!.state).toBe("down");
  });
});
