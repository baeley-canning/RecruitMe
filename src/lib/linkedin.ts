export function normaliseLinkedInUrl(raw: string): string {
  const match = raw.match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  const slug = match ? match[1] : raw.replace(/[?#].*$/, "").replace(/\/$/, "");
  return `https://www.linkedin.com/in/${slug.toLowerCase()}`;
}

// Validate that a string is genuinely a linkedin.com/in/<slug> URL. Used by
// extension API routes — without this, callers can submit any URL and have
// the server persist it as the candidate's linkedinUrl.
const LINKEDIN_PROFILE_URL_RE = /^https?:\/\/(?:[a-z0-9-]+\.)?linkedin\.com\/in\/[^/?#\s]+/i;
export function isLinkedInProfileUrl(raw: string | null | undefined): boolean {
  if (!raw) return false;
  return LINKEDIN_PROFILE_URL_RE.test(raw.trim());
}

export function linkedInSlugAliasKey(raw: string): string {
  const match = raw.match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  const slug = match ? match[1] : raw.replace(/[?#].*$/, "").replace(/\/$/, "");
  return slug
    .toLowerCase()
    .replace(/-[a-z0-9]*\d[a-z0-9]{5,}$/i, "")
    .replace(/[^a-z0-9]/g, "");
}

export function linkedInProfileMatches(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (normaliseLinkedInUrl(a).toLowerCase() === normaliseLinkedInUrl(b).toLowerCase()) return true;

  const aKey = linkedInSlugAliasKey(a);
  const bKey = linkedInSlugAliasKey(b);
  return aKey.length >= 6 && aKey === bKey;
}
