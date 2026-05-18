/**
 * Unit tests for src/lib/identity-merge.ts — the identity-resolution
 * primitives used by the clustering script and (future) recruiter-merge UI.
 *
 * Test goals:
 *  • Pin the precedence of identityMergeKey (LinkedIn > JobAdder > null).
 *  • Pin the rejection of synthetic `library:<id>` keys — these mark a
 *    source library row, NOT a person.
 *  • Pin URL normalisation parity with the canonical normaliseLinkedInUrl.
 *  • Pin phone E.164 normalisation, including the NZ-default behaviour.
 *  • Pin name normalisation including diacritic stripping (the regex was
 *    written with an explicit \u-escape to avoid editor encoding fragility).
 *
 * What we deliberately DO NOT test:
 *  • The .mjs mirror (covered by scripts/__tests__/_identity-merge.test.mjs
 *    which runs the same fixtures against both modules).
 *  • Tier 2 / Tier 3 logic (lives in PR 5 / future work).
 */

import { describe, expect, it } from "vitest";
import {
  identityMergeKey,
  isSyntheticLibraryKey,
  normaliseEmail,
  normaliseJobAdderUrl,
  normaliseName,
  normalisePhoneE164,
  mergeKeyToString,
} from "../identity-merge";

describe("isSyntheticLibraryKey", () => {
  it("returns true for library:<id> placeholders", () => {
    expect(isSyntheticLibraryKey("library:abc123")).toBe(true);
    expect(isSyntheticLibraryKey("library:")).toBe(true);
  });

  it("returns false for real LinkedIn URLs", () => {
    expect(isSyntheticLibraryKey("https://linkedin.com/in/jane")).toBe(false);
    expect(isSyntheticLibraryKey("https://www.linkedin.com/in/john-smith-12345")).toBe(false);
  });

  it("returns false for empty / null / undefined", () => {
    expect(isSyntheticLibraryKey(null)).toBe(false);
    expect(isSyntheticLibraryKey(undefined)).toBe(false);
    expect(isSyntheticLibraryKey("")).toBe(false);
  });

  it("is exact-prefix sensitive (does not match accidental substrings)", () => {
    expect(isSyntheticLibraryKey("LIBRARY:abc")).toBe(false); // case-sensitive
    expect(isSyntheticLibraryKey(" library:abc")).toBe(false); // leading space
  });
});

describe("identityMergeKey precedence", () => {
  it("prefers LinkedIn URL when both are present", () => {
    const key = identityMergeKey({
      linkedinUrl: "https://linkedin.com/in/jane",
      jobAdderUrl: "https://acme.jobadder.com/c/123",
    });
    expect(key?.kind).toBe("linkedinUrl");
    expect(key?.value).toBe("https://www.linkedin.com/in/jane");
  });

  it("falls back to JobAdder URL when LinkedIn is missing", () => {
    const key = identityMergeKey({
      linkedinUrl: null,
      jobAdderUrl: "https://acme.jobadder.com/c/456",
    });
    expect(key?.kind).toBe("jobAdderUrl");
    expect(key?.value).toBe("https://acme.jobadder.com/c/456");
  });

  it("falls back to JobAdder URL when LinkedIn is a synthetic library: key", () => {
    const key = identityMergeKey({
      linkedinUrl: "library:src-789",
      jobAdderUrl: "https://acme.jobadder.com/c/789",
    });
    expect(key?.kind).toBe("jobAdderUrl");
  });

  it("returns null when neither URL is usable", () => {
    expect(identityMergeKey({ linkedinUrl: null, jobAdderUrl: null })).toBeNull();
    expect(identityMergeKey({ linkedinUrl: "", jobAdderUrl: "" })).toBeNull();
    expect(identityMergeKey({ linkedinUrl: "  ", jobAdderUrl: "  " })).toBeNull();
    // Synthetic-only is also null — no JobAdder URL to fall back to.
    expect(identityMergeKey({ linkedinUrl: "library:abc", jobAdderUrl: null })).toBeNull();
  });

  it("normalises LinkedIn URLs (case, scheme, trailing slash, query string)", () => {
    const variants = [
      "https://www.linkedin.com/in/Jane/",
      "https://linkedin.com/in/jane",
      "http://nz.linkedin.com/in/jane?trk=foo",
      "https://www.linkedin.com/in/JANE",
    ];
    const keys = variants.map((url) => identityMergeKey({ linkedinUrl: url, jobAdderUrl: null }));
    // All four variants should normalise to the same value.
    expect(new Set(keys.map((k) => k?.value)).size).toBe(1);
  });

  it("trims whitespace before evaluating", () => {
    const key = identityMergeKey({ linkedinUrl: "  https://linkedin.com/in/jane  ", jobAdderUrl: null });
    expect(key?.value).toBe("https://www.linkedin.com/in/jane");
  });
});

describe("normaliseJobAdderUrl", () => {
  it("strips query string and fragment", () => {
    expect(normaliseJobAdderUrl("https://acme.jobadder.com/c/123?trk=foo")).toBe("https://acme.jobadder.com/c/123");
    expect(normaliseJobAdderUrl("https://acme.jobadder.com/c/123#section")).toBe("https://acme.jobadder.com/c/123");
  });

  it("collapses trailing slash", () => {
    expect(normaliseJobAdderUrl("https://acme.jobadder.com/c/123/")).toBe("https://acme.jobadder.com/c/123");
  });

  it("lowercases scheme + host but preserves path case (some tenants use mixed-case IDs)", () => {
    expect(normaliseJobAdderUrl("HTTPS://Acme.JobAdder.com/c/AbCdEf123")).toBe("https://acme.jobadder.com/c/AbCdEf123");
  });

  it("handles raw whitespace", () => {
    expect(normaliseJobAdderUrl("  https://acme.jobadder.com/c/123  ")).toBe("https://acme.jobadder.com/c/123");
  });
});

describe("normaliseEmail", () => {
  it("lowercases and trims", () => {
    expect(normaliseEmail("  Jane.Doe@Example.COM  ")).toBe("jane.doe@example.com");
  });

  it("preserves plus-tags (different tags ≠ same identity in our model)", () => {
    expect(normaliseEmail("jane+jobs@example.com")).toBe("jane+jobs@example.com");
    expect(normaliseEmail("jane+other@example.com")).toBe("jane+other@example.com");
    // Two different tags produce two different normalised values — by design.
    expect(normaliseEmail("jane+jobs@example.com")).not.toBe(normaliseEmail("jane+other@example.com"));
  });

  it("returns null for non-email strings", () => {
    expect(normaliseEmail("just a name")).toBeNull();
    expect(normaliseEmail("no-at-sign")).toBeNull();
    expect(normaliseEmail("missing@dot")).toBeNull();
    expect(normaliseEmail("")).toBeNull();
    expect(normaliseEmail(null)).toBeNull();
    expect(normaliseEmail(undefined)).toBeNull();
  });
});

describe("normalisePhoneE164", () => {
  it("preserves an explicit international form", () => {
    expect(normalisePhoneE164("+64211234567")).toBe("+64211234567");
    expect(normalisePhoneE164("+44 7700 900123")).toBe("+447700900123");
  });

  it("NZ-default: bare numbers get +64 with trunk-zero stripped", () => {
    expect(normalisePhoneE164("0211234567")).toBe("+64211234567");
    expect(normalisePhoneE164("021-123-4567")).toBe("+64211234567");
    expect(normalisePhoneE164("(021) 123 4567")).toBe("+64211234567");
  });

  it("treats numbers without a leading 0 as NZ-default too (recruiter may have stripped trunk)", () => {
    expect(normalisePhoneE164("211234567")).toBe("+64211234567");
  });

  it("returns null for strings that don't reach E.164 minimum length", () => {
    expect(normalisePhoneE164("123")).toBeNull();
    expect(normalisePhoneE164("")).toBeNull();
    expect(normalisePhoneE164(null)).toBeNull();
    expect(normalisePhoneE164("nothing-here")).toBeNull();
  });

  it("rejects strings with a `+` mid-string (malformed)", () => {
    expect(normalisePhoneE164("64+211234567")).toBeNull();
  });

  it("rejects absurdly long inputs (paste-of-the-whole-CV class of bug)", () => {
    expect(normalisePhoneE164("0211234567" + "0".repeat(50))).toBeNull();
  });
});

describe("normaliseName", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normaliseName("  Jane    DOE  ")).toBe("jane doe");
  });

  it("strips diacritics (José → jose)", () => {
    expect(normaliseName("José García")).toBe("jose garcia");
    // Ś→s+combining (stripped), ą→a+combining (stripped), ę→e+combining (stripped).
    // Łukasz's Ł has no NFD decomposition (it's a base letter), so it falls
    // to the [^a-z'\s] filter and becomes a space → trimmed.
    expect(normaliseName("Łukasz Świątek")).toBe("ukasz swiatek");
  });

  it("preserves apostrophes (O'Brien stays as o'brien)", () => {
    expect(normaliseName("O'Brien")).toBe("o'brien");
  });

  it("returns empty string for inputs with no letters after normalisation", () => {
    expect(normaliseName("123")).toBe("");
    expect(normaliseName("")).toBe("");
    expect(normaliseName(null)).toBe("");
  });

  it("removes punctuation and digits", () => {
    expect(normaliseName("Jane Doe, MBA (2024)")).toBe("jane doe mba");
  });
});

describe("mergeKeyToString", () => {
  it("returns null for null input", () => {
    expect(mergeKeyToString(null)).toBeNull();
  });

  it("encodes kind and value", () => {
    expect(mergeKeyToString({ kind: "linkedinUrl", value: "https://www.linkedin.com/in/jane" })).toBe(
      "linkedinUrl:https://www.linkedin.com/in/jane",
    );
    expect(mergeKeyToString({ kind: "jobAdderUrl", value: "https://acme.jobadder.com/c/1" })).toBe(
      "jobAdderUrl:https://acme.jobadder.com/c/1",
    );
  });

  it("produces distinct strings for the same value under different kinds", () => {
    const a = mergeKeyToString({ kind: "linkedinUrl", value: "shared" });
    const b = mergeKeyToString({ kind: "jobAdderUrl", value: "shared" });
    expect(a).not.toBe(b);
  });
});
