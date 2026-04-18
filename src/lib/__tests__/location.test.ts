import { describe, expect, it } from "vitest";
import { assessLocationFit, expandLocationKeywords, locationMatches } from "../location";

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
});
