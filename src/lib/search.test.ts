import { describe, expect, it } from "vitest";
import { inferLocationFromSearchText } from "./search";

describe("inferLocationFromSearchText", () => {
  it("does not treat a comma-separated headline as a location", () => {
    const location = inferLocationFromSearchText(
      "Owen Nicholson - Specialist in Training Design, Development and Delivery at Multiple Clients | LinkedIn",
      "Specialist in Training Design, Development and Delivery at Multiple Clients"
    );

    expect(location).toBe("");
  });

  it("still extracts valid New Zealand locations from search text", () => {
    const location = inferLocationFromSearchText(
      "Monray Swart - Senior Software Engineer - Porirua, Wellington, New Zealand | LinkedIn"
    );

    expect(location).toBe("Porirua, Wellington, New Zealand");
  });
});
