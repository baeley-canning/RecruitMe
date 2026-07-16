import { describe, it, expect } from "vitest";
import {
  shouldAcceptProfileText,
  STUB_MAX_CHARS,
  THINNER_REJECT_RATIO,
} from "@/lib/profile-text-merge";

const text = (n: number) => "x".repeat(n);

describe("shouldAcceptProfileText — the anti-degradation guard", () => {
  it("REGRESSION (2026-07-16 incident): a 1k box scrape must NOT replace a 100k extension capture", () => {
    const d = shouldAcceptProfileText(text(1015), text(99_989));
    expect(d.accept).toBe(false);
    expect(d.reason).toBe("rejected-thinner");
    expect(d.incomingChars).toBe(1015);
    expect(d.existingChars).toBe(99_989);
  });

  it("never nulls a stored profile out when the scrape returns nothing", () => {
    for (const empty of [null, undefined, "", "   ", "\n\t"]) {
      const d = shouldAcceptProfileText(empty, text(50_000));
      expect(d.accept).toBe(false);
      expect(d.reason).toBe("no-incoming");
    }
  });

  it("accepts any real capture when nothing is stored", () => {
    for (const none of [null, undefined, "", "  "]) {
      const d = shouldAcceptProfileText(text(500), none);
      expect(d.accept).toBe(true);
      expect(d.reason).toBe("no-existing");
    }
  });

  it("upgrades a stub: a thin stored placeholder is replaceable by anything real", () => {
    const d = shouldAcceptProfileText(text(120), text(STUB_MAX_CHARS));
    expect(d.accept).toBe(true);
    expect(d.reason).toBe("existing-stub");
    // even a SHORTER capture may replace a stub — there's nothing to protect
    expect(shouldAcceptProfileText(text(30), text(199)).accept).toBe(true);
  });

  it("accepts a richer capture (the genuine refresh case)", () => {
    const d = shouldAcceptProfileText(text(120_000), text(99_989));
    expect(d.accept).toBe(true);
    expect(d.reason).toBe("richer-or-comparable");
  });

  it("accepts a comparable capture — a real edit that trimmed some content", () => {
    // 10% shrink: a removed role. Must NOT be treated as degradation.
    expect(shouldAcceptProfileText(text(9_000), text(10_000)).accept).toBe(true);
    // exactly at the ratio boundary is accepted (only strictly-thinner rejects)
    const boundary = Math.ceil(10_000 * THINNER_REJECT_RATIO);
    expect(shouldAcceptProfileText(text(boundary), text(10_000)).accept).toBe(true);
  });

  it("rejects just below the ratio boundary", () => {
    const justUnder = Math.floor(10_000 * THINNER_REJECT_RATIO) - 1;
    const d = shouldAcceptProfileText(text(justUnder), text(10_000));
    expect(d.accept).toBe(false);
    expect(d.reason).toBe("rejected-thinner");
  });

  it("identical text is accepted (idempotent re-scrape, no-op write)", () => {
    expect(shouldAcceptProfileText(text(5_000), text(5_000)).accept).toBe(true);
  });

  it("compares TRIMMED lengths — whitespace padding can't fake richness", () => {
    // 100 real chars padded to look long must still lose to 10k of real content.
    const padded = text(100) + " ".repeat(50_000);
    const d = shouldAcceptProfileText(padded, text(10_000));
    expect(d.accept).toBe(false);
    expect(d.reason).toBe("rejected-thinner");
    expect(d.incomingChars).toBe(100);
  });
});
