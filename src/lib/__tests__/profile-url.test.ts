/**
 * Regression: 100 queued SEEK fetches all failed on the box with
 *   "Refusing to scrape non-https URL: seek:https://nz.employer.seek.com/..."
 * because an identity merge-key string ("${kind}:${value}" from
 * mergeKeyToString) was sitting in the candidate's linkedinUrl column. The route
 * trusted the column to name the platform, so a SEEK profile was dispatched to
 * the LinkedIn scraper with an unusable URL.
 */
import { describe, it, expect } from "vitest";
import { cleanProfileUrl, firstUsableProfileUrl, platformForUrl, resolveProfileTarget } from "@/lib/profile-url";

describe("cleanProfileUrl", () => {
  it("strips a merge-key kind prefix", () => {
    expect(cleanProfileUrl("seek:https://nz.employer.seek.com/talentsearch/profile/1"))
      .toBe("https://nz.employer.seek.com/talentsearch/profile/1");
    expect(cleanProfileUrl("linkedin:https://www.linkedin.com/in/x"))
      .toBe("https://www.linkedin.com/in/x");
  });

  it("passes a clean https URL through untouched", () => {
    expect(cleanProfileUrl("https://www.linkedin.com/in/x")).toBe("https://www.linkedin.com/in/x");
  });

  it("rejects anything that isn't https — the worker refuses these", () => {
    expect(cleanProfileUrl("http://insecure.example/x")).toBeNull();
    expect(cleanProfileUrl("seek:not-a-url")).toBeNull();
    expect(cleanProfileUrl("")).toBeNull();
    expect(cleanProfileUrl(null)).toBeNull();
  });
});

describe("platformForUrl — the URL overrides the column only when it's sure", () => {
  it("routes a SEEK profile to the SEEK scraper even when the column said linkedin", () => {
    expect(platformForUrl("https://nz.employer.seek.com/talentsearch/profile/1", "linkedin")).toBe("seek");
  });

  it("identifies linkedin by host", () => {
    expect(platformForUrl("https://www.linkedin.com/in/someone", "jobadder")).toBe("linkedin");
  });

  it("falls back to the column for hosts it can't identify — JobAdder is customer-hosted", () => {
    expect(platformForUrl("https://ja.example/c/1", "jobadder")).toBe("jobadder");
  });

  it("returns null for an unknown host with no hint rather than guessing", () => {
    expect(platformForUrl("https://example.com/x")).toBeNull();
  });
});

describe("resolveProfileTarget — url and platform can never disagree", () => {
  it("recovers the real SEEK target from a merge-key string in linkedinUrl", () => {
    // The exact production row that made all 100 fetches fail on the box.
    expect(resolveProfileTarget({
      linkedinUrl: "seek:https://nz.employer.seek.com/talentsearch/profile/16439816",
    })).toEqual({
      url: "https://nz.employer.seek.com/talentsearch/profile/16439816",
      platform: "seek",
    });
  });

  it("prefers LinkedIn when a real one is present", () => {
    expect(resolveProfileTarget({
      linkedinUrl: "https://www.linkedin.com/in/x",
      seekUrl: "https://nz.employer.seek.com/talentsearch/profile/1",
    })).toEqual({ url: "https://www.linkedin.com/in/x", platform: "linkedin" });
  });

  it("still reaches JobAdder on a customer host", () => {
    expect(resolveProfileTarget({ jobAdderUrl: "https://ja.example/c/1" }))
      .toEqual({ url: "https://ja.example/c/1", platform: "jobadder" });
  });

  it("skips an unusable column and keeps looking", () => {
    expect(resolveProfileTarget({ linkedinUrl: "seek:not-a-url", jobAdderUrl: "https://ja.example/c/1" }))
      .toEqual({ url: "https://ja.example/c/1", platform: "jobadder" });
  });

  it("returns null when nothing is capturable", () => {
    expect(resolveProfileTarget({ linkedinUrl: null, seekUrl: "", jobAdderUrl: "ftp://x" })).toBeNull();
  });
});
