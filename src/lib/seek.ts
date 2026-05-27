/**
 * SEEK profile-URL helpers. Mirrors src/lib/linkedin.ts so SEEK profiles
 * (from the manual "paste a SEEK URL" affordance now, and the mini-PC
 * scraper later) get the same normalise + validate treatment LinkedIn and
 * JobAdder URLs already get.
 *
 * We deliberately keep normalisation CONSERVATIVE — strip query/fragment,
 * collapse a trailing slash, lowercase only the scheme+host — because the
 * exact SEEK candidate-profile URL format the scraper emits isn't pinned
 * yet. Path case is preserved (SEEK profile/advertiser IDs may be
 * case-sensitive), matching the normaliseJobAdderUrl decision.
 */

/**
 * Normalise a SEEK profile URL to a stable identity key. Same shape as
 * normaliseJobAdderUrl in identity-merge.ts — kept here so both the app
 * and the scraper-ingest route share one definition.
 */
export function normaliseSeekUrl(raw: string): string {
  const trimmed = raw.trim();
  // Strip query + fragment so tracking params collapse to the same key.
  const noQuery = trimmed.replace(/[?#].*$/, "");
  // Collapse trailing slash.
  const noTrailing = noQuery.replace(/\/$/, "");
  // Lowercase scheme + host only; preserve path case (IDs may be case-sensitive).
  return noTrailing.replace(/^(https?:\/\/[^/]+)/i, (match) => match.toLowerCase());
}

// Accept any seek.co.nz / seek.com.au / seek.com host (incl. subdomains like
// talent.seek.com.au). Used by the URL-edit affordance + scraper ingest to
// reject non-SEEK URLs before persisting them as a candidate's seekUrl.
const SEEK_PROFILE_URL_RE = /^https?:\/\/(?:[a-z0-9-]+\.)*seek\.(?:co\.nz|com\.au|com)(?:[/?#]|$)/i;
export function isSeekProfileUrl(raw: string | null | undefined): boolean {
  if (!raw) return false;
  return SEEK_PROFILE_URL_RE.test(raw.trim());
}
