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
  it("requires the platform prefix at the START — not mid-string (true prefix anchor)", () => {
    // The \b bug matched a platform name after a space, so a wrapped/quoted
    // error or profile text containing "seek_challenge:" mid-string falsely
    // flipped needs-reauth. Only a message that STARTS with the prefix counts.
    expect(isAuthChallengeMessage("foo seek_challenge: bar")).toBe(false);
    expect(isAuthChallengeMessage("scrape failed: linkedin_challenge: auth wall")).toBe(false);
    expect(isAuthChallengeMessage("  seek_challenge: leading whitespace")).toBe(false);
  });
  it("classifies the circuit-open error as an auth challenge (so the job fails final, no requeue)", () => {
    // ensureSession throws this when the breaker is open — it must be detected
    // as a challenge so the worker skips backoff and the API marks it failed.
    expect(
      isAuthChallengeMessage(
        "seek_challenge: auth circuit open after repeated re-auth failures — run `npx tsx login.ts seek` on the box",
      ),
    ).toBe(true);
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

describe("MFA walls must stop immediately, not consume a retry budget", () => {
  it("classifies an MFA/OTP stall as HARD", () => {
    expect(classifyAuthFailure(new Error(
      "seek login did not settle (page.waitForURL: Timeout 30000ms exceeded.) — stalled at https://authenticate.seek.com/u/mfa-otp-challenge?state=x",
    ))).toBe("hard");
  });

  it("classifies a bare login-page stall as HARD", () => {
    expect(classifyAuthFailure(new Error(
      "seek login did not settle (Timeout) — stalled at https://authenticate.seek.com/login?state=x",
    ))).toBe("hard");
  });

  it("a HARD failure opens the circuit on the FIRST occurrence", () => {
    const s = recordAuthFailure(createBreakerState(), "seek", "hard", 1000);
    expect(isCircuitOpen(s, "seek", 1001)).toBe(true);
  });

  it("still treats an ordinary network blip as soft", () => {
    expect(classifyAuthFailure(new Error("net::ERR_CONNECTION_RESET"))).toBe("soft");
  });
});
