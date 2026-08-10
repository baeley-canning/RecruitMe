import { describe, it, expect } from "vitest";
import { msUntilNextJobAllowed } from "./job-pacing.js";

describe("msUntilNextJobAllowed — the account-safety floor", () => {
  it("waits out the remainder when a job returned fast", () => {
    // The exact shape that got the account flagged: job failed in ~4s, and the
    // trailing 2-6s pause let the loop cycle every ~7s.
    expect(msUntilNextJobAllowed(1_000_000, 1_004_000, 30_000)).toBe(26_000);
  });

  it("does not wait when the job already took longer than the floor", () => {
    expect(msUntilNextJobAllowed(1_000_000, 1_045_000, 30_000)).toBe(0);
  });

  it("never waits before the very first job", () => {
    expect(msUntilNextJobAllowed(0, 1_000_000, 30_000)).toBe(0);
  });

  it("is disabled by a zero interval", () => {
    expect(msUntilNextJobAllowed(1_000_000, 1_000_100, 0)).toBe(0);
  });

  it("never returns negative", () => {
    expect(msUntilNextJobAllowed(1_000_000, 9_000_000, 30_000)).toBe(0);
  });
});
