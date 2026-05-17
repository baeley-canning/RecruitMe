import { describe, expect, it } from "vitest";
import { linkedInProfileMatches, linkedInSlugAliasKey, normaliseLinkedInUrl } from "../linkedin";

describe("LinkedIn URL helpers", () => {
  it("normalises /in profile URLs", () => {
    expect(normaliseLinkedInUrl("https://nz.linkedin.com/in/ranjana-tyagi-3755b615/?trk=people")).toBe(
      "https://www.linkedin.com/in/ranjana-tyagi-3755b615"
    );
    expect(normaliseLinkedInUrl("https://www.linkedin.com/in/RanjanaTyagi/?miniProfileUrn=abc")).toBe(
      "https://www.linkedin.com/in/ranjanatyagi"
    );
  });

  it("builds alias keys for LinkedIn canonical redirects", () => {
    // With multi-factor key (audit E1): keep the first 4 chars of the trailing
    // hash as a secondary discriminator so different people don't collide.
    expect(linkedInSlugAliasKey("https://www.linkedin.com/in/ranjana-tyagi-3755b615/")).toBe("ranjanatyagi|3755");
    expect(linkedInSlugAliasKey("https://www.linkedin.com/in/ranjanatyagi/")).toBe("ranjanatyagi");
  });

  it("matches numeric-suffix search URLs to canonical LinkedIn redirects", () => {
    // LinkedIn sometimes returns the same person under bare and hashed slugs
    // — when one side has no discriminator, fall back to stripped-slug match.
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

  // Audit E1: previously, the trailing-hash strip collapsed every same-name
  // discriminator into a single key — two different people with the same
  // name and different trailing hashes would alias. Multi-factor key fix.
  it("distinguishes two different people with the same stripped slug but different discriminators", () => {
    // Realistic LinkedIn-style hashes (8 hex chars).
    const a = linkedInSlugAliasKey("https://www.linkedin.com/in/john-smith-3755b615/");
    const b = linkedInSlugAliasKey("https://www.linkedin.com/in/john-smith-9a2cf041/");
    expect(a).not.toBe(b);
    expect(
      linkedInProfileMatches(
        "https://www.linkedin.com/in/john-smith-3755b615/",
        "https://www.linkedin.com/in/john-smith-9a2cf041/"
      )
    ).toBe(false);
  });

  it("still aliases the same person whose canonical hash gained a trailing -N suffix", () => {
    // LinkedIn's own canonicalisation occasionally appends `-1`/`-2` to the
    // hash for the SAME profile. The first 4 chars of the discriminator stay
    // stable across this rewrite, so the alias key should still match.
    const a = linkedInSlugAliasKey("https://www.linkedin.com/in/john-smith-3755b615/");
    const b = linkedInSlugAliasKey("https://www.linkedin.com/in/john-smith-3755b615-1/");
    expect(a).toBe(b);
    expect(
      linkedInProfileMatches(
        "https://www.linkedin.com/in/john-smith-3755b615/",
        "https://www.linkedin.com/in/john-smith-3755b615-1/"
      )
    ).toBe(true);
  });
});
