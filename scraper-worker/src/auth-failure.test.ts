import { describe, it, expect } from "vitest";
import {
  isAuthChallengeMessage,
  classifyAuthFailure,
  createBreakerState,
  isCircuitOpen,
  recordAuthFailure,
  recordAuthSuccess,
  BREAKER_THRESHOLD,
  BREAKER_COOLDOWN_MS,
} from "./auth-failure.js";

describe("isAuthChallengeMessage (anchored — no false positives)", () => {
  it("matches the scrapers' platform_challenge prefixes", () => {
    expect(isAuthChallengeMessage("linkedin_challenge: auth wall during search")).toBe(true);
    expect(isAuthChallengeMessage("seek_challenge: session expired — re-authentication required")).toBe(true);
    expect(isAuthChallengeMessage("jobadder_challenge: login")).toBe(true);
  });
  it("does NOT match arbitrary text that merely contains '_challenge:' or 'challenge'", () => {
    expect(isAuthChallengeMessage("Loves a good challenge: shipping fast")).toBe(false);
    expect(isAuthChallengeMessage("project_challenge: delivered the migration")).toBe(false);
    expect(isAuthChallengeMessage("Senior Engineer | the_big_challenge: leadership")).toBe(false);
    expect(isAuthChallengeMessage("")).toBe(false);
  });
});

describe("classifyAuthFailure (soft vs hard)", () => {
  it("treats transient errors as soft", () => {
    expect(classifyAuthFailure(new Error("Timeout 30000ms exceeded waiting for locator"))).toBe("soft");
    expect(classifyAuthFailure(new Error("net::ERR_CONNECTION_RESET"))).toBe("soft");
    expect(classifyAuthFailure("navigation failed")).toBe("soft");
    expect(classifyAuthFailure(new Error("something unexpected"))).toBe("soft"); // unknown -> soft
  });
  it("treats unrecoverable login problems as hard", () => {
    expect(classifyAuthFailure(new Error("invalid password"))).toBe("hard");
    expect(classifyAuthFailure(new Error("re-run `npx tsx login.ts jobadder` on the desktop"))).toBe("hard");
    expect(classifyAuthFailure(new Error("No authentication flow for platform: foo"))).toBe("hard");
    expect(classifyAuthFailure(new Error("account is locked"))).toBe("hard");
  });
});

describe("circuit breaker (pure, time injected)", () => {
  it("opens immediately on a hard failure", () => {
    let s = createBreakerState();
    expect(isCircuitOpen(s, "seek", 1000)).toBe(false);
    s = recordAuthFailure(s, "seek", "hard", 1000);
    expect(isCircuitOpen(s, "seek", 1000)).toBe(true);
    expect(isCircuitOpen(s, "seek", 1000 + BREAKER_COOLDOWN_MS - 1)).toBe(true);
    expect(isCircuitOpen(s, "seek", 1000 + BREAKER_COOLDOWN_MS + 1)).toBe(false); // cooldown elapsed
  });

  it("opens a soft-failure streak only at the threshold", () => {
    let s = createBreakerState();
    for (let i = 1; i < BREAKER_THRESHOLD; i++) {
      s = recordAuthFailure(s, "linkedin", "soft", 0);
      expect(isCircuitOpen(s, "linkedin", 0)).toBe(false);
    }
    s = recordAuthFailure(s, "linkedin", "soft", 0); // the THRESHOLD-th failure
    expect(isCircuitOpen(s, "linkedin", 0)).toBe(true);
  });

  it("is per-platform (one platform's failures don't open another)", () => {
    let s = createBreakerState();
    s = recordAuthFailure(s, "seek", "hard", 0);
    expect(isCircuitOpen(s, "seek", 0)).toBe(true);
    expect(isCircuitOpen(s, "linkedin", 0)).toBe(false);
  });

  it("a success resets the streak and closes the circuit", () => {
    let s = createBreakerState();
    s = recordAuthFailure(s, "seek", "soft", 0);
    s = recordAuthFailure(s, "seek", "soft", 0);
    s = recordAuthSuccess(s, "seek");
    expect(isCircuitOpen(s, "seek", 0)).toBe(false);
    // streak reset: it now takes a full fresh threshold to open again
    for (let i = 1; i < BREAKER_THRESHOLD; i++) s = recordAuthFailure(s, "seek", "soft", 0);
    expect(isCircuitOpen(s, "seek", 0)).toBe(false);
  });

  it("does not mutate the input state (pure)", () => {
    const s0 = createBreakerState();
    const s1 = recordAuthFailure(s0, "seek", "hard", 0);
    expect(s0).toEqual({});
    expect(s1).not.toBe(s0);
  });
});
