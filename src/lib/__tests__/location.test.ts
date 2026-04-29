import { describe, expect, it } from "vitest";
import { assessLocationFit, expandLocationKeywords, isPlausibleLocation, locationMatches } from "../location";

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
