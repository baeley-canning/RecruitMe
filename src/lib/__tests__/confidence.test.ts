import { describe, it, expect } from "vitest";
import { deriveConfidence, candidateConfidence } from "@/lib/confidence";

const NOW = new Date("2026-07-13T12:00:00.000Z").getTime();
const daysAgo = (d: number) => new Date(NOW - d * 24 * 60 * 60 * 1000);

describe("deriveConfidence", () => {
  it("high: full profile, fresh, corroborated, with contact", () => {
    const c = deriveConfidence({
      hasFullProfile: true,
      capturedAt: daysAgo(10),
      sourceCount: 2,
      hasVerifiedContact: true,
      now: NOW,
    });
    expect(c.score).toBe(100); // 40 + 25 + 20 + 15
    expect(c.level).toBe("high");
  });

  it("medium: full profile only", () => {
    const c = deriveConfidence({ hasFullProfile: true, sourceCount: 0, now: NOW });
    expect(c.score).toBe(40);
    expect(c.level).toBe("medium");
  });

  it("low: single-source snippet, no profile", () => {
    const c = deriveConfidence({ hasFullProfile: false, sourceCount: 1, now: NOW });
    expect(c.score).toBe(5);
    expect(c.level).toBe("low");
    expect(c.reasons).toContain("Snippet only — not yet fetched");
  });

  it("freshness tiers: recent +25, within 6mo +10, stale +0", () => {
    expect(deriveConfidence({ hasFullProfile: false, sourceCount: 0, capturedAt: daysAgo(30), now: NOW }).score).toBe(25);
    expect(deriveConfidence({ hasFullProfile: false, sourceCount: 0, capturedAt: daysAgo(120), now: NOW }).score).toBe(10);
    expect(deriveConfidence({ hasFullProfile: false, sourceCount: 0, capturedAt: daysAgo(400), now: NOW }).score).toBe(0);
  });

  it("clamps to 0..100 and never NaN on empty signals", () => {
    const c = deriveConfidence({ hasFullProfile: false, sourceCount: 0, now: NOW });
    expect(c.score).toBe(0);
    expect(c.level).toBe("low");
  });
});

describe("candidateConfidence adapter", () => {
  it("counts platform URLs as sources and treats short text as NOT a full profile", () => {
    const c = candidateConfidence({
      profileText: "short", // < 200 chars → not full
      linkedinUrl: "https://linkedin.com/in/x",
      seekUrl: "https://seek.com/x",
      jobAdderUrl: null,
      profileCapturedAt: daysAgo(5),
      email: "a@b.com",
    }, NOW);
    // sources: linkedin + seek = 2 (+20); fresh (+25); contact (+15); no full profile.
    expect(c.score).toBe(60);
    expect(c.level).toBe("medium");
  });

  it("full substantive profile bumps to high", () => {
    const c = candidateConfidence({
      profileText: "x".repeat(250),
      linkedinUrl: "https://linkedin.com/in/x",
      seekUrl: "https://seek.com/x",
      profileCapturedAt: daysAgo(5),
      phone: "021",
    }, NOW);
    expect(c.score).toBe(100);
    expect(c.level).toBe("high");
  });

  it("bare row with nothing is low", () => {
    expect(candidateConfidence({}, NOW).level).toBe("low");
  });
});
