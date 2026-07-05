import { describe, expect, it } from "vitest";
import crypto from "crypto";
import { generateScraperToken, hashScraperToken, scraperTokenStatus, SCRAPER_TOKEN_BYTES } from "@/lib/scraper-tokens";

describe("scraper-tokens", () => {
  it("generates a base64url token whose hash is sha256-hex of the plaintext", () => {
    const { raw, tokenHash } = generateScraperToken();
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no +/=
    expect(tokenHash).toBe(crypto.createHash("sha256").update(raw).digest("hex"));
    expect(tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("has enough entropy (32 bytes) and is unique per call", () => {
    expect(SCRAPER_TOKEN_BYTES).toBe(32);
    const a = generateScraperToken().raw;
    const b = generateScraperToken().raw;
    expect(a).not.toBe(b);
    // 32 bytes base64url ≈ 43 chars
    expect(a.length).toBeGreaterThanOrEqual(42);
  });

  it("hashScraperToken is the EXACT hash verifyScraperAuth checks (mint/verify can't drift)", () => {
    // verifyScraperAuth computes: crypto.createHash("sha256").update(token).digest("hex")
    const token = "some-known-token-value";
    expect(hashScraperToken(token)).toBe(crypto.createHash("sha256").update(token).digest("hex"));
  });

  it("derives status: active / revoked / expired", () => {
    const now = new Date("2026-07-05T00:00:00Z");
    expect(scraperTokenStatus({ revokedAt: null, expiresAt: null }, now)).toBe("active");
    expect(scraperTokenStatus({ revokedAt: new Date(), expiresAt: null }, now)).toBe("revoked");
    expect(scraperTokenStatus({ revokedAt: null, expiresAt: new Date("2026-07-04T00:00:00Z") }, now)).toBe("expired");
    expect(scraperTokenStatus({ revokedAt: null, expiresAt: new Date("2026-07-06T00:00:00Z") }, now)).toBe("active");
    // revoked wins over not-yet-expired
    expect(scraperTokenStatus({ revokedAt: new Date(), expiresAt: new Date("2026-07-06T00:00:00Z") }, now)).toBe("revoked");
  });
});
