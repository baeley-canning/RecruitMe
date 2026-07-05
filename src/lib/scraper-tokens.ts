/**
 * Scraper API token minting + hashing — the single source of truth for the
 * bearer tokens a headless scraper box uses to authenticate
 * (Authorization: Bearer <token>).
 *
 * Security model (mirrors the invite/reset links in auth-tokens.ts):
 *  - 256-bit random token, base64url so it's header-safe.
 *  - The plaintext exists ONLY in the mint response (shown once); the DB stores
 *    only its sha256 hex hash (tokenHash). Losing it = mint a new one.
 *  - hashScraperToken is the EXACT hash verifyScraperAuth checks against, so
 *    mint and verify can never drift.
 *
 * Both this lib and scripts/create-scraper-token.mjs produce identical tokens
 * (32-byte base64url + sha256 hex); the CLI stays standalone for ops use.
 */

import crypto from "crypto";

/** 32 bytes → ~43-char base64url. Plenty of entropy for a bearer token. */
export const SCRAPER_TOKEN_BYTES = 32;

export function hashScraperToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export function generateScraperToken(): { raw: string; tokenHash: string } {
  const raw = crypto.randomBytes(SCRAPER_TOKEN_BYTES).toString("base64url");
  return { raw, tokenHash: hashScraperToken(raw) };
}

export type ScraperTokenStatus = "active" | "revoked" | "expired";

export function scraperTokenStatus(t: { revokedAt: Date | null; expiresAt: Date | null }, now = new Date()): ScraperTokenStatus {
  if (t.revokedAt) return "revoked";
  if (t.expiresAt && t.expiresAt.getTime() < now.getTime()) return "expired";
  return "active";
}
