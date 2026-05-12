import { describe, expect, it, beforeEach } from "vitest";
import {
  aiFailoverHealth,
  recordClaudeSuccess,
  recordOllamaFailover,
  snapshotFailoverHealth,
  __resetFailoverHealthForTests,
} from "../ai-failover-health";

describe("aiFailoverHealth", () => {
  beforeEach(() => __resetFailoverHealthForTests());

  it("starts in healthy state", () => {
    const snap = snapshotFailoverHealth();
    expect(snap.isClaudeDead).toBe(false);
    expect(snap.failoverCount).toBe(0);
    expect(snap.failoverReason).toBeNull();
    expect(snap.lastFailoverAt).toBeNull();
  });

  it("recordOllamaFailover marks dead, stores reason, increments counter, stamps time", () => {
    recordOllamaFailover("credits_exhausted");
    const snap = snapshotFailoverHealth();
    expect(snap.isClaudeDead).toBe(true);
    expect(snap.failoverReason).toBe("credits_exhausted");
    expect(snap.failoverCount).toBe(1);
    expect(typeof snap.lastFailoverAt).toBe("string");
    expect(new Date(snap.lastFailoverAt!).getTime()).toBeGreaterThan(0);

    recordOllamaFailover("auth_invalid");
    expect(snapshotFailoverHealth().failoverCount).toBe(2);
    expect(snapshotFailoverHealth().failoverReason).toBe("auth_invalid");
  });

  it("recordClaudeSuccess clears dead state but preserves the count + last-failover time", () => {
    recordOllamaFailover("network_unreachable");
    expect(aiFailoverHealth.isClaudeDead).toBe(true);
    const failoverAt = aiFailoverHealth.lastFailoverAt;

    recordClaudeSuccess();
    const snap = snapshotFailoverHealth();
    expect(snap.isClaudeDead).toBe(false);
    expect(snap.failoverReason).toBeNull();
    expect(snap.lastClaudeSuccessAt).not.toBeNull();
    // History preserved so the banner can still surface "recovered N minutes ago"
    expect(snap.lastFailoverAt).toBe(failoverAt);
    expect(snap.failoverCount).toBe(1);
  });

  it("snapshot returns a copy, not a live reference", () => {
    recordOllamaFailover("service_unavailable");
    const snap = snapshotFailoverHealth();
    snap.isClaudeDead = false;
    snap.failoverCount = 99;
    expect(aiFailoverHealth.isClaudeDead).toBe(true);
    expect(aiFailoverHealth.failoverCount).toBe(1);
  });
});
