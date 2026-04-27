/**
 * Regression tests for search location pre-filter.
 * Pins the behaviour of isExplicitlyOverseasLocation + radius keyword
 * filtering so Wellington/Petone/Lower Hutt are kept and
 * Napier/Christchurch/overseas are dropped.
 */

import { describe, expect, it } from "vitest";
import { isExplicitlyOverseasLocation, isNzLocation, normalizeLocationText } from "@/lib/location";
import { getCityKeywordsWithinRadius, getCityCoords } from "@/lib/nz-cities";

function passesLocationPreFilter(loc: string, radiusKeywords: string[]): boolean {
  if (!loc) return true;
  if (isExplicitlyOverseasLocation(loc)) return false;
  if (radiusKeywords.length > 0 && isNzLocation(loc)) {
    const normalised = normalizeLocationText(loc);
    const inRadius = radiusKeywords.some((kw) => normalised.includes(normalizeLocationText(kw)));
    const isGenericNz = ["new zealand", "aotearoa", "nz"].some(
      (g) => normalised === g || normalised === g.replace(" ", "")
    );
    if (!inRadius && !isGenericNz) return false;
  }
  return true;
}

const wellingtonCoords = getCityCoords("Wellington")!;
const radiusKeywords25km = getCityKeywordsWithinRadius(wellingtonCoords.lat, wellingtonCoords.lng, 25);

describe("location pre-filter — Wellington 25 km radius", () => {
  it("keeps Wellington", () => expect(passesLocationPreFilter("Wellington, New Zealand", radiusKeywords25km)).toBe(true));
  it("keeps Lower Hutt", () => expect(passesLocationPreFilter("Lower Hutt, New Zealand", radiusKeywords25km)).toBe(true));
  it("keeps Petone", () => expect(passesLocationPreFilter("Petone, Wellington", radiusKeywords25km)).toBe(true));
  it("keeps Porirua", () => expect(passesLocationPreFilter("Porirua, New Zealand", radiusKeywords25km)).toBe(true));
  it("keeps generic 'New Zealand'", () => expect(passesLocationPreFilter("New Zealand", radiusKeywords25km)).toBe(true));
  it("keeps 'NZ'", () => expect(passesLocationPreFilter("NZ", radiusKeywords25km)).toBe(true));
  it("keeps empty location", () => expect(passesLocationPreFilter("", radiusKeywords25km)).toBe(true));
  it("drops Napier (~320 km)", () => expect(passesLocationPreFilter("Napier, New Zealand", radiusKeywords25km)).toBe(false));
  it("drops Christchurch (~340 km)", () => expect(passesLocationPreFilter("Christchurch, New Zealand", radiusKeywords25km)).toBe(false));
  it("drops Auckland (~640 km)", () => expect(passesLocationPreFilter("Auckland, New Zealand", radiusKeywords25km)).toBe(false));
  it("drops Australia", () => expect(passesLocationPreFilter("Sydney, Australia", radiusKeywords25km)).toBe(false));
  it("drops United Kingdom", () => expect(passesLocationPreFilter("London, United Kingdom", radiusKeywords25km)).toBe(false));
  it("drops United States", () => expect(passesLocationPreFilter("San Francisco, USA", radiusKeywords25km)).toBe(false));
});

describe("location pre-filter — no radius", () => {
  it("keeps all NZ locations when no radius applied", () => {
    expect(passesLocationPreFilter("Napier, New Zealand", [])).toBe(true);
    expect(passesLocationPreFilter("Christchurch, New Zealand", [])).toBe(true);
  });
  it("still drops overseas", () => {
    expect(passesLocationPreFilter("Sydney, Australia", [])).toBe(false);
    expect(passesLocationPreFilter("London, UK", [])).toBe(false);
  });
});
