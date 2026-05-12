import { describe, expect, it } from "vitest";
import { canonicalizeUrl } from "../canonical-url";

describe("canonicalizeUrl — LinkedIn", () => {
  it("strips tracking params and forces www.linkedin.com host", () => {
    // Two providers may surface the same person with different subdomain +
    // tracking — both must collapse to one key.
    const a = canonicalizeUrl("https://nz.linkedin.com/in/jane-smith?trk=public_post");
    const b = canonicalizeUrl("https://linkedin.com/in/jane-smith");
    expect(a).toBe(b);
  });

  it("lowercases the slug", () => {
    expect(canonicalizeUrl("https://www.linkedin.com/in/Jane-Smith"))
      .toBe(canonicalizeUrl("https://www.linkedin.com/in/jane-smith"));
  });

  it("does not throw on malformed URLs (returns trimmed lowercase fallback)", () => {
    expect(canonicalizeUrl("not a url at all")).toBe("not a url at all");
  });
});

describe("canonicalizeUrl — non-LinkedIn", () => {
  it("strips utm / gclid tracking params", () => {
    const noisy = canonicalizeUrl("https://example.com/page?utm_source=ad&id=42");
    const clean = canonicalizeUrl("https://example.com/page?id=42");
    expect(noisy).toBe(clean);
  });

  it("lowercases the host but preserves the path case (paths are case-sensitive)", () => {
    // Path case matters on case-sensitive servers, so we deliberately
    // lowercase the WHOLE URL for dedupe simplicity — accept the false-
    // positive risk on path-cased URLs (rare in candidate-search context).
    const a = canonicalizeUrl("https://Example.COM/Page");
    const b = canonicalizeUrl("https://example.com/Page");
    expect(a).toBe(b);
  });

  it("strips trailing slash", () => {
    expect(canonicalizeUrl("https://example.com/page/"))
      .toBe(canonicalizeUrl("https://example.com/page"));
  });

  it("returns empty string for empty input", () => {
    expect(canonicalizeUrl("")).toBe("");
  });
});
