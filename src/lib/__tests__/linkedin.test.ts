import { describe, expect, it } from "vitest";
import { linkedInProfileMatches, linkedInSlugAliasKey, normaliseLinkedInUrl } from "../linkedin";

describe("LinkedIn URL helpers", () => {
  it("normalises /in profile URLs", () => {
    expect(normaliseLinkedInUrl("https://nz.linkedin.com/in/ranjana-tyagi-3755b615/?trk=people")).toBe(
      "https://www.linkedin.com/in/ranjana-tyagi-3755b615"
    );
  });

  it("builds alias keys for LinkedIn canonical redirects", () => {
    expect(linkedInSlugAliasKey("https://www.linkedin.com/in/ranjana-tyagi-3755b615/")).toBe("ranjanatyagi");
    expect(linkedInSlugAliasKey("https://www.linkedin.com/in/ranjanatyagi/")).toBe("ranjanatyagi");
  });

  it("matches numeric-suffix search URLs to canonical LinkedIn redirects", () => {
    expect(
      linkedInProfileMatches(
        "https://www.linkedin.com/in/ranjana-tyagi-3755b615/",
        "https://www.linkedin.com/in/ranjanatyagi/"
      )
    ).toBe(true);
    expect(
      linkedInProfileMatches(
        "https://www.linkedin.com/in/ranjana-tyagi-3755b615/",
        "https://www.linkedin.com/in/harish-bhyraw/"
      )
    ).toBe(false);
  });
});
