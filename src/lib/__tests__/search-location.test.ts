/**
 * Regression tests for search location pre-filter.
 *
 * Search is per-city — the pre-filter only drops explicitly overseas
 * candidates. All NZ locations (including specific cities outside the
 * job's city) pass through to scoring, where applyLocationFitOverride
 * handles fine-grained location assessment.
 */

import { describe, expect, it } from "vitest";
import { isExplicitlyOverseasLocation } from "@/lib/location";

function passesLocationPreFilter(loc: string): boolean {
  if (!loc) return true;
  if (isExplicitlyOverseasLocation(loc)) return false;
  return true;
}

describe("search location pre-filter", () => {
  // NZ locations — all pass
  it("keeps Wellington", () => expect(passesLocationPreFilter("Wellington, New Zealand")).toBe(true));
  it("keeps Lower Hutt", () => expect(passesLocationPreFilter("Lower Hutt, New Zealand")).toBe(true));
  it("keeps Petone", () => expect(passesLocationPreFilter("Petone, Wellington")).toBe(true));
  it("keeps Christchurch", () => expect(passesLocationPreFilter("Christchurch, New Zealand")).toBe(true));
  it("keeps Auckland", () => expect(passesLocationPreFilter("Auckland, New Zealand")).toBe(true));
  it("keeps Napier", () => expect(passesLocationPreFilter("Napier, New Zealand")).toBe(true));
  it("keeps generic 'New Zealand'", () => expect(passesLocationPreFilter("New Zealand")).toBe(true));
  it("keeps 'NZ'", () => expect(passesLocationPreFilter("NZ")).toBe(true));
  it("keeps empty location", () => expect(passesLocationPreFilter("")).toBe(true));

  // Overseas — all dropped
  it("drops Australia", () => expect(passesLocationPreFilter("Sydney, Australia")).toBe(false));
  it("drops United Kingdom", () => expect(passesLocationPreFilter("London, United Kingdom")).toBe(false));
  it("drops United States", () => expect(passesLocationPreFilter("San Francisco, USA")).toBe(false));
  it("drops India", () => expect(passesLocationPreFilter("Bengaluru, India")).toBe(false));
  it("drops Singapore", () => expect(passesLocationPreFilter("Singapore")).toBe(false));
  it("drops China", () => expect(passesLocationPreFilter("Shanghai, China")).toBe(false));
});
