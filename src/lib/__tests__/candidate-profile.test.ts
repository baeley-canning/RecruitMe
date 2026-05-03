import { describe, expect, it } from "vitest";
import { hasFullCandidateProfile } from "../candidate-profile";

describe("hasFullCandidateProfile", () => {
  it("accepts long profile text without a capture timestamp", () => {
    expect(
      hasFullCandidateProfile({
        profileCapturedAt: null,
        profileText: "Long profile. ".repeat(170),
      })
    ).toBe(true);
  });

  it("accepts shorter extension captures once they have a capture timestamp", () => {
    expect(
      hasFullCandidateProfile({
        profileCapturedAt: new Date("2026-05-03T00:00:00.000Z"),
        profileText: "Captured LinkedIn profile. ".repeat(25),
      })
    ).toBe(true);
  });

  it("rejects short search snippets", () => {
    expect(
      hasFullCandidateProfile({
        profileCapturedAt: null,
        profileText: "Short search snippet",
      })
    ).toBe(false);
  });
});
