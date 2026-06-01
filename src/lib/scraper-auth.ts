/**
 * Authn/authz for the scraper job queue endpoints (/api/scraper/jobs).
 *
 * Two credential types, with different tenant authority:
 *   - A per-box `ScraperApiToken` (Authorization: Bearer) carrying an orgId is
 *     LOCKED to that org. A box authenticated this way cannot act on any other
 *     tenant — this is what closes the cross-tenant write that the single
 *     shared SCRAPER_SECRET allowed (every box held the same secret, so any
 *     box could name orgId=<victim> and inject candidates into another
 *     agency's library, or claim their queued jobs).
 *   - The shared `SCRAPER_SECRET`, or an owner-scope token (orgId null), is the
 *     platform operator: it may target any org, named explicitly in the request.
 *
 * Migration: issue per-box tokens (scripts/create-scraper-token.mjs) and drop
 * SCRAPER_SECRET from box.env so only the platform owner holds it.
 */

import { timingSafeEqual } from "crypto";
import { verifyScraperAuth } from "./session";

export function checkScraperSecret(req: Request): boolean {
  const provided = req.headers.get("x-scraper-secret");
  const expected = process.env.SCRAPER_SECRET;
  if (!provided || !expected) return false;
  try {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Authenticate a scraper request and return the org it is ALLOWED to act on.
 * `boundOrgId` non-null = a tenant-locked token; null = platform operator
 * (shared secret or owner token), free to name the target org in the request.
 * Returns null when no valid credential is present.
 */
export async function authenticateScraper(
  req: Request,
): Promise<{ boundOrgId: string | null } | null> {
  const tokenAuth = await verifyScraperAuth(req);
  if (tokenAuth) return { boundOrgId: tokenAuth.orgId };
  if (checkScraperSecret(req)) return { boundOrgId: null };
  return null;
}

/**
 * Resolve the effective orgId for a request given its authenticated principal.
 * A token-bound box may only act on its own org (a mismatching requested org is
 * a cross-tenant attempt → error); an owner-scope principal uses the requested
 * org as-is (which may be null — callers that require an org reject that).
 */
export function resolveScraperOrgId(
  boundOrgId: string | null,
  requestedOrgId: string | null,
): { orgId: string | null } | { error: string } {
  if (boundOrgId != null) {
    if (requestedOrgId != null && requestedOrgId !== boundOrgId) {
      return { error: "orgId does not match the authenticated scraper token's org" };
    }
    return { orgId: boundOrgId };
  }
  return { orgId: requestedOrgId };
}
