import { describe, expect, it } from "vitest";
import { inferLocationFromSearchText } from "../search";

describe("inferLocationFromSearchText", () => {
  it("extracts explicit foreign locations from search snippets", () => {
    expect(
      inferLocationFromSearchText(
        "Jane Doe - Software Engineer | LinkedIn",
        "Software Engineer at Example Co. London, England, United Kingdom · Contact info"
      )
    ).toBe("London, England, United Kingdom");

    expect(
      inferLocationFromSearchText(
        "Wei Chen - Senior Developer | LinkedIn",
        "Senior Developer at Example. Shanghai, China · 500+ connections"
      )
    ).toBe("Shanghai, China");
  });

  it("extracts local NZ city locations from search snippets", () => {
    expect(
      inferLocationFromSearchText(
        "Priya Sodhi - Engineer at Xero | LinkedIn",
        "Engineer at Xero | RubyOnRails | React · Wellington, Wellington, New Zealand · Xero"
      )
    ).toBe("Wellington, Wellington, New Zealand");
  });
});
