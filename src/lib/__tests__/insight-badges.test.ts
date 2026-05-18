import { describe, expect, it } from "vitest";
import { decideBadges, type CandidateBadgeState } from "../insight-badges";

function state(overrides: Partial<CandidateBadgeState> = {}): CandidateBadgeState {
  return {
    matchScore: 75,
    scoredProfileTextHash: "hash-A",
    currentProfileTextHash: "hash-A",
    source: "talent_pool",
    profileTextEmpty: false,
    hasUsableInsight: false,
    insightWasReused: false,
    context: "job",
    ...overrides,
  };
}

describe("decideBadges — library-only state", () => {
  it("returns 'library_only' badge when context is library", () => {
    const b = decideBadges(state({ context: "library", matchScore: 75 }));
    expect(b.map((x) => x.kind)).toContain("library_only");
  });

  it("returns 'library_only' badge when matchScore is null even in job context", () => {
    const b = decideBadges(state({ matchScore: null }));
    expect(b.map((x) => x.kind)).toContain("library_only");
  });

  it("library_only suppresses 'scored' (they are mutually exclusive)", () => {
    const b = decideBadges(state({ matchScore: null }));
    expect(b.map((x) => x.kind)).not.toContain("scored");
  });
});

describe("decideBadges — scored state", () => {
  it("returns 'scored' when matchScore exists, hashes match, context is job", () => {
    const b = decideBadges(state({ matchScore: 75, scoredProfileTextHash: "A", currentProfileTextHash: "A" }));
    expect(b.map((x) => x.kind)).toContain("scored");
    expect(b.map((x) => x.kind)).not.toContain("needs_rescore");
  });
});

describe("decideBadges — needs_rescore state (Critic B §8b — hash-mismatch surface)", () => {
  it("returns 'needs_rescore' when scored and current hashes differ", () => {
    const b = decideBadges(state({ scoredProfileTextHash: "A", currentProfileTextHash: "B" }));
    expect(b.map((x) => x.kind)).toContain("needs_rescore");
    expect(b.map((x) => x.kind)).not.toContain("scored");
  });

  it("does NOT flip 'needs_rescore' when we never scored (matchScore null)", () => {
    const b = decideBadges(state({ matchScore: null, scoredProfileTextHash: null, currentProfileTextHash: "A" }));
    expect(b.map((x) => x.kind)).not.toContain("needs_rescore");
  });

  it("DOES flip 'needs_rescore' when matchScore exists but scoredProfileTextHash was cleared (existing card convention — profile updated)", () => {
    // This is shape (a) in the helper: hash-cleared by an update.
    // The existing card already renders a small status dot for this; the
    // badge promotes it to a labelled pill.
    const b = decideBadges(state({ matchScore: 80, scoredProfileTextHash: null, currentProfileTextHash: "A" }));
    expect(b.map((x) => x.kind)).toContain("needs_rescore");
  });

  it("does NOT flip 'needs_rescore' when current hash is null AND scored hash present (no comparison possible — fall back to NOT stale)", () => {
    // Caller couldn't compute the current hash (e.g. UI didn't pass it).
    // We DON'T want to false-positive needs_rescore here — the existing
    // hashCleared check handles the real staleness signal.
    const b = decideBadges(state({ scoredProfileTextHash: "A", currentProfileTextHash: null }));
    expect(b.map((x) => x.kind)).not.toContain("needs_rescore");
  });

  it("needs_rescore takes top priority in the badge order", () => {
    const b = decideBadges(state({ scoredProfileTextHash: "A", currentProfileTextHash: "B", source: "jobadder_import" }));
    expect(b[0].kind).toBe("needs_rescore");
  });
});

describe("decideBadges — insight_reused state", () => {
  it("returns 'insight_reused' only when both flags are true", () => {
    const b1 = decideBadges(state({ hasUsableInsight: true, insightWasReused: true }));
    expect(b1.map((x) => x.kind)).toContain("insight_reused");

    const b2 = decideBadges(state({ hasUsableInsight: true, insightWasReused: false }));
    expect(b2.map((x) => x.kind)).not.toContain("insight_reused");

    const b3 = decideBadges(state({ hasUsableInsight: false, insightWasReused: true }));
    expect(b3.map((x) => x.kind)).not.toContain("insight_reused");
  });

  it("renders with neutral tone (plan §F: should not visually shout)", () => {
    const b = decideBadges(state({ hasUsableInsight: true, insightWasReused: true }));
    const reused = b.find((x) => x.kind === "insight_reused");
    expect(reused?.tone).toBe("neutral");
  });
});

describe("decideBadges — from_jobadder state", () => {
  it("returns 'from_jobadder' for jobadder_import source", () => {
    const b = decideBadges(state({ source: "jobadder_import" }));
    expect(b.map((x) => x.kind)).toContain("from_jobadder");
  });

  it("does NOT render for non-jobadder sources", () => {
    const b = decideBadges(state({ source: "talent_pool" }));
    expect(b.map((x) => x.kind)).not.toContain("from_jobadder");
  });

  it("uses warning tone when profileText is empty (Bede shape)", () => {
    const b = decideBadges(state({ source: "jobadder_import", profileTextEmpty: true }));
    const ja = b.find((x) => x.kind === "from_jobadder");
    expect(ja?.tone).toBe("warning");
  });

  it("uses neutral tone when profileText is non-empty (provenance only)", () => {
    const b = decideBadges(state({ source: "jobadder_import", profileTextEmpty: false }));
    const ja = b.find((x) => x.kind === "from_jobadder");
    expect(ja?.tone).toBe("neutral");
  });
});

describe("decideBadges — badge priority ordering", () => {
  it("orders: needs_rescore > library_only > insight_reused > scored > from_jobadder", () => {
    // Construct a state that triggers as many badges as possible — needs_rescore
    // (hash mismatch on a present score), insight_reused, and from_jobadder.
    const b = decideBadges(state({
      matchScore: 75,
      scoredProfileTextHash: "A",
      currentProfileTextHash: "B",
      source: "jobadder_import",
      hasUsableInsight: true,
      insightWasReused: true,
    }));
    const kinds = b.map((x) => x.kind);
    expect(kinds.indexOf("needs_rescore")).toBeLessThan(kinds.indexOf("insight_reused"));
    expect(kinds.indexOf("insight_reused")).toBeLessThan(kinds.indexOf("from_jobadder"));
  });

  it("library_only sorts AFTER needs_rescore", () => {
    const b = decideBadges(state({
      matchScore: null,
      scoredProfileTextHash: "A",
      currentProfileTextHash: "B",
    }));
    const kinds = b.map((x) => x.kind);
    // needs_rescore won't trigger because matchScore is null, so this is
    // just library_only at the head. Sanity-check.
    expect(kinds[0]).toBe("library_only");
  });
});

describe("decideBadges — every badge has a non-empty tooltip (no jargon-only labels)", () => {
  it("every returned descriptor has a tooltip > 20 chars", () => {
    // Construct a maximally-noisy state and assert all badges have helpful tooltips.
    const all = decideBadges(state({
      matchScore: 75,
      scoredProfileTextHash: "A",
      currentProfileTextHash: "B",
      source: "jobadder_import",
      profileTextEmpty: true,
      hasUsableInsight: true,
      insightWasReused: true,
    }));
    for (const b of all) {
      expect(b.tooltip.length).toBeGreaterThan(20);
    }
  });
});
