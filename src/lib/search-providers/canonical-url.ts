/**
 * URL canonicalisation for the dedupe step. Critic flagged: don't reinvent
 * LinkedIn slug normalisation — the existing `normaliseLinkedInUrl` in
 * src/lib/linkedin.ts already strips tracking params and forces the
 * www.linkedin.com host. Re-use it so two providers returning slightly
 * different LinkedIn URLs (nz.linkedin.com vs linkedin.com, with vs without
 * ?trk=...) collapse to the same canonical key.
 *
 * For non-LinkedIn URLs (GitHub, personal portfolios, anything else) we
 * apply a cheap generic normalisation: lowercase host, strip well-known
 * tracking params, trim trailing slash, drop fragment.
 */

import { normaliseLinkedInUrl } from "../linkedin";

const TRACKING_PARAM_RE = /^(utm_|fbclid|gclid|mc_|igshid|trk$|trkInfo$|originalSubdomain$|original_referer$|miniProfileUrn$)/i;

function isLinkedInProfileUrl(url: string): boolean {
  return /linkedin\.com\/in\//i.test(url);
}

function stripTrackingParams(u: URL): URL {
  const out = new URL(u.toString());
  const drop: string[] = [];
  out.searchParams.forEach((_, key) => {
    if (TRACKING_PARAM_RE.test(key)) drop.push(key);
  });
  for (const k of drop) out.searchParams.delete(k);
  return out;
}

/**
 * Return a canonical key for dedupe. For LinkedIn profile URLs this is the
 * existing `normaliseLinkedInUrl` output (lowercase slug, www.linkedin.com
 * host). For everything else, generic normalisation. Returns the original
 * URL string when parsing fails — we'd rather over-dedupe a malformed URL
 * than throw and lose results.
 */
export function canonicalizeUrl(url: string): string {
  if (!url) return "";
  if (isLinkedInProfileUrl(url)) {
    try {
      return normaliseLinkedInUrl(url);
    } catch {
      return url.trim().toLowerCase();
    }
  }
  try {
    const u = new URL(url.trim());
    u.hostname = u.hostname.toLowerCase();
    u.hash = "";
    const stripped = stripTrackingParams(u);
    let s = stripped.toString();
    if (s.endsWith("/") && !s.endsWith("://")) s = s.slice(0, -1);
    return s.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}
