/**
 * Unit tests for src/lib/candidate-photo.ts.
 *
 * These pin the contract that downstream Avatar consumers rely on:
 *  • Null inputs / empty strings / synthetic library keys return null so the
 *    Avatar falls back to initials without firing an unavatar request.
 *  • Malformed URLs never throw — the helper is called inside render paths.
 *  • Slugs are lowercased + de-suffixed so the same person hits the same
 *    unavatar URL regardless of how the LinkedIn URL was captured.
 *  • The ?fallback=false flag is always present — without it unavatar serves
 *    a generic placeholder and our onError swap never fires.
 */

import { describe, expect, it } from "vitest";
import { getCandidatePhotoUrl } from "../candidate-photo";

describe("getCandidatePhotoUrl", () => {
  it("returns null for null / undefined / empty linkedinUrl", () => {
    expect(getCandidatePhotoUrl({ linkedinUrl: null })).toBeNull();
    expect(getCandidatePhotoUrl({ linkedinUrl: undefined })).toBeNull();
    expect(getCandidatePhotoUrl({ linkedinUrl: "" })).toBeNull();
    expect(getCandidatePhotoUrl({ linkedinUrl: "   " })).toBeNull();
  });

  it("returns null for synthetic library: keys", () => {
    expect(getCandidatePhotoUrl({ linkedinUrl: "library:src-1" })).toBeNull();
    expect(getCandidatePhotoUrl({ linkedinUrl: "library:" })).toBeNull();
    expect(getCandidatePhotoUrl({ linkedinUrl: "library:abc-123-def" })).toBeNull();
  });

  it("returns null for malformed URLs with no /in/ slug", () => {
    expect(getCandidatePhotoUrl({ linkedinUrl: "not-a-url" })).toBeNull();
    expect(getCandidatePhotoUrl({ linkedinUrl: "https://example.com/profile/jane" })).toBeNull();
    expect(getCandidatePhotoUrl({ linkedinUrl: "https://linkedin.com/company/foo" })).toBeNull();
    expect(getCandidatePhotoUrl({ linkedinUrl: "https://linkedin.com/in/" })).toBeNull();
  });

  it("returns the unavatar URL for a plain linkedin.com/in/<slug> URL", () => {
    expect(getCandidatePhotoUrl({ linkedinUrl: "https://linkedin.com/in/jane" })).toBe(
      "https://unavatar.io/linkedin/jane?fallback=false",
    );
  });

  it("lowercases the slug and accepts the www. host", () => {
    expect(
      getCandidatePhotoUrl({ linkedinUrl: "https://www.linkedin.com/in/Jane-Doe-12345/" }),
    ).toBe("https://unavatar.io/linkedin/jane-doe-12345?fallback=false");
  });

  it("strips trailing slash, query string, and hash from the slug", () => {
    expect(getCandidatePhotoUrl({ linkedinUrl: "https://linkedin.com/in/jane/" })).toBe(
      "https://unavatar.io/linkedin/jane?fallback=false",
    );
    expect(
      getCandidatePhotoUrl({ linkedinUrl: "https://linkedin.com/in/jane?trk=public_profile" }),
    ).toBe("https://unavatar.io/linkedin/jane?fallback=false");
    expect(getCandidatePhotoUrl({ linkedinUrl: "https://linkedin.com/in/jane#about" })).toBe(
      "https://unavatar.io/linkedin/jane?fallback=false",
    );
  });

  it("trims whitespace around the input", () => {
    expect(
      getCandidatePhotoUrl({ linkedinUrl: "   https://linkedin.com/in/jane   " }),
    ).toBe("https://unavatar.io/linkedin/jane?fallback=false");
  });

  it("preserves the canonical LinkedIn hash suffix in the slug", () => {
    // LinkedIn's canonical URLs append an alphanumeric hash — that's a real
    // part of the slug and unavatar handles it correctly.
    expect(
      getCandidatePhotoUrl({ linkedinUrl: "https://www.linkedin.com/in/john-smith-abc123" }),
    ).toBe("https://unavatar.io/linkedin/john-smith-abc123?fallback=false");
  });

  it("always includes ?fallback=false so the onError swap fires on misses", () => {
    const url = getCandidatePhotoUrl({ linkedinUrl: "https://linkedin.com/in/anyone" });
    expect(url).not.toBeNull();
    expect(url).toContain("?fallback=false");
  });
});
