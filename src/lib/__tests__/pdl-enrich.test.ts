import { describe, it, expect } from "vitest";
import { applyPdlFillOnly, mergePdlProvenance, type PdlEnrichResult } from "@/lib/pdl-enrich";

function match(over: Partial<PdlEnrichResult> = {}): PdlEnrichResult {
  return {
    matched: true, likelihood: 8,
    headline: "Senior Engineer at Xero",
    location: "Wellington, New Zealand",
    email: "jane@example.com",
    phone: "+64211234567",
    profileText: "x".repeat(300),
    ...over,
  };
}

describe("applyPdlFillOnly", () => {
  it("fills ONLY blank fields — never overwrites recruiter/captured data", () => {
    const { patch, filled } = applyPdlFillOnly(
      { headline: "Existing headline", location: null, email: "kept@me.com", phone: null, profileText: "y".repeat(400) },
      match(),
    );
    // headline/email/profileText already present → untouched. location/phone blank → filled.
    expect(patch).toEqual({ location: "Wellington, New Zealand", phone: "+64211234567" });
    expect(filled.sort()).toEqual(["location", "phone"]);
    expect(patch).not.toHaveProperty("headline");
    expect(patch).not.toHaveProperty("email");
    expect(patch).not.toHaveProperty("profileText");
  });

  it("treats a short profileText stub (<200 chars) as blank and fills it", () => {
    const { patch, filled } = applyPdlFillOnly(
      { headline: "h", location: "l", email: "e@e.com", phone: "p", profileText: "too short" },
      match(),
    );
    expect(patch.profileText).toBe("x".repeat(300));
    expect(filled).toEqual(["profileText"]);
  });

  it("fills everything on a totally empty candidate", () => {
    const { filled } = applyPdlFillOnly({}, match());
    expect(filled.sort()).toEqual(["email", "headline", "location", "phone", "profileText"]);
  });

  it("returns an empty patch when PDL had no match (nothing written)", () => {
    const { patch, filled } = applyPdlFillOnly({}, { matched: false } as PdlEnrichResult);
    expect(patch).toEqual({});
    expect(filled).toEqual([]);
  });

  it("only writes the specific candidate fields — never CVs or other columns", () => {
    const { patch } = applyPdlFillOnly({}, match());
    for (const k of Object.keys(patch)) {
      expect(["headline", "location", "email", "phone", "profileText"]).toContain(k);
    }
  });

  it("whitespace-only fields count as blank", () => {
    const { filled } = applyPdlFillOnly({ headline: "   ", email: "\t" }, match());
    expect(filled).toContain("headline");
    expect(filled).toContain("email");
  });
});

describe("mergePdlProvenance", () => {
  it("stamps enrichedAt + filled fields while preserving existing screeningData keys", () => {
    const at = new Date("2026-07-13T12:00:00.000Z");
    const merged = mergePdlProvenance(JSON.stringify({ scoringError: "boom" }), ["email", "location"], at);
    const obj = JSON.parse(merged);
    expect(obj.scoringError).toBe("boom"); // preserved
    expect(obj.pdl).toEqual({ enrichedAt: at.toISOString(), filled: ["email", "location"] });
  });

  it("handles null / malformed existing screeningData safely", () => {
    expect(() => JSON.parse(mergePdlProvenance(null, ["email"]))).not.toThrow();
    expect(() => JSON.parse(mergePdlProvenance("not json", ["email"]))).not.toThrow();
  });
});
