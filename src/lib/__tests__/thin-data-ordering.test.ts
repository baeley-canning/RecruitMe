/**
 * Reported: "It's not scoring, just leaving them at 40% each time."
 *
 * Re-scoring DOES call the AI (the summaries change every run, and it bills),
 * but every thin-data candidate lands on exactly 40 because the data-quality
 * ceiling is applied with Math.min. Everything above the ceiling flattens onto
 * it, so a strong intermediate and an over-qualified lead tie — the ranking the
 * recruiter is paying for is destroyed at the last step.
 */
import { describe, it, expect } from "vitest";
import { capScorePreservingOrder } from "../scoring";

describe("capScorePreservingOrder", () => {
  const CAP = 40;

  it("never exceeds the cap", () => {
    for (const raw of [41, 55, 70, 88, 100]) {
      expect(capScorePreservingOrder(raw, CAP)).toBeLessThanOrEqual(CAP);
    }
  });

  it("keeps distinct raw scores distinct — the actual bug", () => {
    const strong = capScorePreservingOrder(88, CAP);
    const middling = capScorePreservingOrder(65, CAP);
    const weak = capScorePreservingOrder(45, CAP);
    expect(strong).toBeGreaterThan(middling);
    expect(middling).toBeGreaterThan(weak);
  });

  it("leaves scores comfortably below the cap untouched", () => {
    // A genuinely poor candidate must not be inflated by the compression.
    expect(capScorePreservingOrder(12, CAP)).toBe(12);
    expect(capScorePreservingOrder(25, CAP)).toBe(25);
  });

  it("is monotonic and continuous across the band boundary", () => {
    let prev = -1;
    for (let raw = 0; raw <= 100; raw++) {
      const got = capScorePreservingOrder(raw, CAP);
      expect(got).toBeGreaterThanOrEqual(prev);
      prev = got;
    }
  });

  it("is a no-op when the cap is 100 (full profiles are unaffected)", () => {
    for (const raw of [0, 37, 64, 91, 100]) {
      expect(capScorePreservingOrder(raw, 100)).toBe(raw);
    }
  });

  it("still separates candidates under a harsher cap", () => {
    expect(capScorePreservingOrder(90, 20)).toBeGreaterThan(capScorePreservingOrder(50, 20));
    expect(capScorePreservingOrder(90, 20)).toBeLessThanOrEqual(20);
  });
});
