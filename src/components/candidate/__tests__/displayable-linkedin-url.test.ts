import { describe, it, expect } from "vitest";
import { displayableLinkedinUrl } from "../helpers";

/**
 * displayableLinkedinUrl decides whether a candidate's linkedinUrl renders as a
 * clickable link. It must reject everything that produced dead "This page
 * doesn't exist" links: synthetic dedupe keys, mis-filed SEEK URLs, and the
 * mangled `linkedin.com/in/https://…seek…` double-scheme values.
 */
describe("displayableLinkedinUrl", () => {
  it("returns genuine LinkedIn profile URLs", () => {
    expect(displayableLinkedinUrl("https://www.linkedin.com/in/jane-doe")).toBe("https://www.linkedin.com/in/jane-doe");
    expect(displayableLinkedinUrl("https://nz.linkedin.com/in/jane-doe/")).toBe("https://nz.linkedin.com/in/jane-doe/");
  });

  it("rejects synthetic library keys (not http)", () => {
    expect(displayableLinkedinUrl("library:cmp7we7c00oll1107br3rqt43")).toBeNull();
    expect(displayableLinkedinUrl("li:abc")).toBeNull();
  });

  it("rejects the mangled double-scheme value (SEEK normalised as a LinkedIn slug)", () => {
    expect(displayableLinkedinUrl(
      "https://www.linkedin.com/in/https://nz.employer.seek.com/talentsearch/profile/571239686/",
    )).toBeNull();
  });

  it("rejects a SEEK URL mis-filed into linkedinUrl", () => {
    expect(displayableLinkedinUrl("https://nz.employer.seek.com/talentsearch/profile/571239686/")).toBeNull();
  });

  it("rejects other non-LinkedIn URLs", () => {
    expect(displayableLinkedinUrl("https://meet.google.com/ywq-xeqj-dhc")).toBeNull();
    expect(displayableLinkedinUrl("http://example.com/x")).toBeNull();
  });

  it("returns null for empty / nullish input", () => {
    expect(displayableLinkedinUrl(null)).toBeNull();
    expect(displayableLinkedinUrl(undefined)).toBeNull();
    expect(displayableLinkedinUrl("")).toBeNull();
  });
});
