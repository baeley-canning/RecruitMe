/**
 * Unit tests for the formatScoreLabel helper exported from
 * src/components/candidate/identity-block.tsx.
 *
 * Why a pure-helper test (not a render test): @testing-library/react isn't
 * a project dependency, and rolling our own JSDOM wiring just to verify a
 * string + classname pair is wasteful. The helper is the only branch with
 * actual logic — the JSX around it is a one-line passthrough.
 *
 * Tier breakpoints (80/60/40, "match" kind) come from scoreTier() in
 * src/lib/score-utils.ts — see that file's comment for the rationale.
 *
 * Labels and colours must stay in lockstep with the local TIER_STYLE map
 * in src/app/candidates/[id]/page.tsx so the detail page and the inline
 * IdentityBlock pill agree on what "Strong / Good / Moderate / Weak" mean.
 */

import { describe, expect, it } from "vitest";
import { formatScoreLabel } from "../identity-block";

describe("formatScoreLabel — numeric format (default, back-compat)", () => {
  it("renders bare percentage for score 75", () => {
    // Default format must keep the pre-refactor "{score}%" output verbatim
    // — every untouched consumer (dashboard recent captures, shortlist)
    // relies on this.
    const r = formatScoreLabel(75, "number");
    expect(r).not.toBeNull();
    expect(r!.text).toBe("75%");
    expect(r!.isTier).toBe(false);
  });

  it("returns null for null score (renders nothing)", () => {
    expect(formatScoreLabel(null, "number")).toBeNull();
  });

  it("defaults to numeric format when format arg omitted", () => {
    // Back-compat: callers that don't pass scoreFormat at all must still
    // get the numeric pill. This pins that contract.
    const r = formatScoreLabel(50);
    expect(r).not.toBeNull();
    expect(r!.text).toBe("50%");
    expect(r!.isTier).toBe(false);
  });
});

describe("formatScoreLabel — tier format (JobAdder-style)", () => {
  it("score 85 → 'Strong match · 85' with success colour", () => {
    const r = formatScoreLabel(85, "tier");
    expect(r).not.toBeNull();
    expect(r!.text).toBe("Strong match · 85");
    expect(r!.colorClass).toBe("text-success");
    expect(r!.isTier).toBe(true);
  });

  it("score 65 → 'Good match · 65' with accent colour", () => {
    const r = formatScoreLabel(65, "tier");
    expect(r!.text).toBe("Good match · 65");
    expect(r!.colorClass).toBe("text-accent");
    expect(r!.isTier).toBe(true);
  });

  it("score 45 → 'Moderate match · 45' with warning colour", () => {
    const r = formatScoreLabel(45, "tier");
    expect(r!.text).toBe("Moderate match · 45");
    expect(r!.colorClass).toBe("text-warning");
    expect(r!.isTier).toBe(true);
  });

  it("score 20 → 'Weak match · 20' with tertiary colour", () => {
    const r = formatScoreLabel(20, "tier");
    expect(r!.text).toBe("Weak match · 20");
    expect(r!.colorClass).toBe("text-text-tertiary");
    expect(r!.isTier).toBe(true);
  });

  it("returns null for null score (renders nothing, matches today)", () => {
    expect(formatScoreLabel(null, "tier")).toBeNull();
  });

  it("breakpoint edges match the canonical 80/60/40 tiers", () => {
    // Pin the boundary semantics — if score-utils ever shifts the
    // breakpoints, these tests fail loudly instead of silently re-tiering
    // the entire candidate library.
    expect(formatScoreLabel(80, "tier")!.text).toBe("Strong match · 80");
    expect(formatScoreLabel(79, "tier")!.text).toBe("Good match · 79");
    expect(formatScoreLabel(60, "tier")!.text).toBe("Good match · 60");
    expect(formatScoreLabel(59, "tier")!.text).toBe("Moderate match · 59");
    expect(formatScoreLabel(40, "tier")!.text).toBe("Moderate match · 40");
    expect(formatScoreLabel(39, "tier")!.text).toBe("Weak match · 39");
  });
});
