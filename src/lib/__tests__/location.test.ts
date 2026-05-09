import { describe, expect, it } from "vitest";
import {
  assessLocationFit,
  buildTargetLocationLabel,
  expandLocationKeywords,
  extractKnownLocationTargets,
  inferCandidateLocation,
  isConfirmedOutOfAreaForLocalRole,
  isExplicitlyOverseasLocation,
  isOverseasForNzRole,
  isPlausibleLocation,
  isRemoteFriendlyLocationRule,
  locationMatches,
} from "../location";

describe("inferCandidateLocation — search-snippet city detection", () => {
  it("trusts an explicit, plausible location field", () => {
    expect(inferCandidateLocation("Wellington, New Zealand", "any text"))
      .toBe("Wellington, New Zealand");
  });

  it("scans profileText for an NZ city when the location field is empty", () => {
    const snippet = "Senior Software Engineer based in Auckland, building Kotlin services.";
    expect(inferCandidateLocation(null, snippet)).toBe("Auckland");
  });

  it("scans multiple text sources in order until a city is found", () => {
    expect(inferCandidateLocation(null, null, "headline only", "snippet says Christchurch"))
      .toBe("Christchurch");
  });

  it("returns null when no plausible location and no city in any text", () => {
    expect(inferCandidateLocation(null, "Senior Engineer", "Five years experience"))
      .toBeNull();
  });

  it("uses the first-mentioned NZ city when several appear", () => {
    const text = "Worked in Auckland for 5 years before moving back to Christchurch";
    expect(inferCandidateLocation(null, text)).toBe("Auckland");
  });
});

describe("locationMatches", () => {
  it("rejects explicit overseas lookalikes even when the city name overlaps", () => {
    const wellingtonKeywords = expandLocationKeywords("Wellington");

    expect(locationMatches("Wellington, Somerset, England", wellingtonKeywords)).toBe(false);
    expect(locationMatches("Wellington, New Zealand", wellingtonKeywords)).toBe(true);
  });

  it("rejects obviously different NZ cities for a tight city search", () => {
    const wellingtonKeywords = expandLocationKeywords("Wellington");

    expect(locationMatches("Napier, Hawke's Bay, New Zealand", wellingtonKeywords)).toBe(false);
  });
});

describe("isRemoteFriendlyLocationRule", () => {
  it("uses one remote/hybrid interpretation for scoring and job prefill", () => {
    expect(isRemoteFriendlyLocationRule("Fully remote, NZ-based only")).toBe(true);
    expect(isRemoteFriendlyLocationRule("Can work from anywhere in NZ")).toBe(true);
    expect(isRemoteFriendlyLocationRule("Hybrid, Wellington office")).toBe(false);
    expect(isRemoteFriendlyLocationRule("Remote optional, 3 days in office")).toBe(false);
  });
});

describe("assessLocationFit", () => {
  it("scores exact city matches as strong", () => {
    const fit = assessLocationFit("Wellington, New Zealand", "Wellington");
    expect(fit?.score).toBe(100);
  });

  it("scores distant NZ cities as weak for office-based roles", () => {
    const fit = assessLocationFit("Napier, Hawke's Bay, New Zealand", "Wellington");
    expect(fit?.score).toBeLessThan(45);
  });

  it("scores explicit overseas locations as mismatches", () => {
    const fit = assessLocationFit("Shanghai, China", "Wellington");
    expect(fit?.score).toBe(0);
  });

  it("treats headline text stored as location as unknown", () => {
    const fit = assessLocationFit(
      "Specialist in Training Design, Development and Delivery at Multiple Clients",
      "Wellington"
    );
    expect(fit?.score).toBe(45);
    expect(fit?.evidence).toContain("not clearly stated");
  });

  it("treats two-word person names stored as location as unknown", () => {
    const fit = assessLocationFit("Denuka Kumarage", "Wellington");
    expect(fit?.score).toBe(45);
    expect(fit?.evidence).toContain("not clearly stated");
  });

  it("scores against the best valid target for multi-location roles", () => {
    const fit = assessLocationFit(
      "Wellington, Wellington, New Zealand",
      "Primary: Devonport, Auckland. Secondary option: Petone, Wellington. Full-time, on-site role."
    );

    expect(fit?.score).toBe(100);
    expect(fit?.evidence).toContain("Acceptable role locations");
  });
});

describe("isConfirmedOutOfAreaForLocalRole", () => {
  it("flags Auckland as out of area for a Wellington office role", () => {
    expect(isConfirmedOutOfAreaForLocalRole("Auckland, New Zealand", "Wellington", null, false)).toBe(true);
  });

  it("does not reject unknown locations before the profile proves the mismatch", () => {
    expect(isConfirmedOutOfAreaForLocalRole(null, "Wellington", null, false)).toBe(false);
  });

  it("does not reject distant NZ candidates for remote roles", () => {
    expect(isConfirmedOutOfAreaForLocalRole("Auckland, New Zealand", "Wellington", null, true)).toBe(false);
  });
});

describe("extractKnownLocationTargets", () => {
  it("extracts all named NZ city targets in order", () => {
    expect(
      extractKnownLocationTargets(
        "Primary: Devonport, Auckland (on-site). Secondary option: Petone, Wellington."
      )
    ).toEqual(["North Shore", "Auckland", "Petone", "Wellington"]);
  });

  it("builds a readable target label for scoring and search fallback", () => {
    expect(buildTargetLocationLabel("Wellington", "Primary: Auckland. Secondary: Petone")).toBe(
      "Wellington OR Auckland OR Petone"
    );
  });
});

describe("isPlausibleLocation", () => {
  it("rejects job descriptions and headlines", () => {
    expect(isPlausibleLocation("Specialist in Training Design, Development and Delivery at Multiple Clients")).toBe(false);
    expect(isPlausibleLocation("Capability, Change, Learning and Development")).toBe(false);
  });

  it("keeps real locations", () => {
    expect(isPlausibleLocation("Porirua, Wellington, New Zealand")).toBe(true);
    expect(isPlausibleLocation("Wellington & Wairarapa, New Zealand")).toBe(true);
    expect(isPlausibleLocation("Shanghai, China")).toBe(true);
  });
});

describe("isExplicitlyOverseasLocation — bare-city detection", () => {
  it("catches bare Australian city names without state or country", () => {
    // Bin Xiao class of leak: snippet-only location field, no AU/NSW marker.
    expect(isExplicitlyOverseasLocation("Sydney")).toBe(true);
    expect(isExplicitlyOverseasLocation("Melbourne")).toBe(true);
    expect(isExplicitlyOverseasLocation("Brisbane")).toBe(true);
    expect(isExplicitlyOverseasLocation("Perth")).toBe(true);
    expect(isExplicitlyOverseasLocation("Adelaide")).toBe(true);
  });

  it("catches bare UK / Ireland / India / Asia city names", () => {
    expect(isExplicitlyOverseasLocation("London")).toBe(true);
    expect(isExplicitlyOverseasLocation("Manchester")).toBe(true);
    expect(isExplicitlyOverseasLocation("Dublin")).toBe(true);
    expect(isExplicitlyOverseasLocation("Mumbai")).toBe(true);
    expect(isExplicitlyOverseasLocation("Bangalore")).toBe(true);
    expect(isExplicitlyOverseasLocation("Singapore")).toBe(true);
    expect(isExplicitlyOverseasLocation("Tokyo")).toBe(true);
  });

  it("still catches the explicit forms that already worked", () => {
    expect(isExplicitlyOverseasLocation("Sydney, New South Wales, Australia")).toBe(true);
    expect(isExplicitlyOverseasLocation("Sydney, NSW")).toBe(true);
    expect(isExplicitlyOverseasLocation("Pittsburgh, PA")).toBe(true);
  });

  it("does not flag NZ locations", () => {
    expect(isExplicitlyOverseasLocation("Wellington, New Zealand")).toBe(false);
    expect(isExplicitlyOverseasLocation("Auckland")).toBe(false);
    expect(isExplicitlyOverseasLocation("Christchurch, Canterbury, NZ")).toBe(false);
    expect(isExplicitlyOverseasLocation("")).toBe(false);
  });
});

describe("isOverseasForNzRole — country gate at save sites", () => {
  it("blocks bare-city Australian candidates on a non-remote NZ role", () => {
    expect(isOverseasForNzRole("Sydney", false)).toBe(true);
    expect(isOverseasForNzRole("Sydney, NSW, Australia", false)).toBe(true);
  });

  it("does not block NZ-wide candidates (loose intra-NZ — city-distance handles ranking)", () => {
    // Auckland for a Wellington role: still in NZ, NOT a country-level reject.
    // City-distance affects scoring, not the import gate.
    expect(isOverseasForNzRole("Auckland, New Zealand", false)).toBe(false);
    expect(isOverseasForNzRole("Christchurch", false)).toBe(false);
  });

  it("does not block when the role is remote", () => {
    expect(isOverseasForNzRole("Sydney, Australia", true)).toBe(false);
    expect(isOverseasForNzRole("London", true)).toBe(false);
  });

  it("does not block when the location is unknown", () => {
    // Unknown stays reviewable — fetch will reveal more later, and the
    // post-fetch enrichment path applies the gate retroactively.
    expect(isOverseasForNzRole(null, false)).toBe(false);
    expect(isOverseasForNzRole("", false)).toBe(false);
    expect(isOverseasForNzRole(undefined, false)).toBe(false);
  });
});
