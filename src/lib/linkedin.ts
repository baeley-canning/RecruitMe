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

// Number of characters from the trailing hash to keep as a secondary
// discriminator. 4 is short enough that LinkedIn's own canonicalisation
// (adding/removing a `-1`/`-2` suffix on the same person) still aliases to
// the same key — but long enough that two genuinely different "john-smith"
// profiles with different discriminators don't collide.
const ALIAS_HASH_DISCRIMINATOR_CHARS = 4;
// Matches the trailing canonical LinkedIn hash (at least one digit + 5+
// alphanum chars), optionally followed by a `-N` LinkedIn-canonical suffix
// (e.g. `-1`, `-2`) that LinkedIn appends to disambiguate same-hash profiles
// for the SAME person across edits. The optional suffix is stripped so the
// captured discriminator is the stable hash portion.
const ALIAS_HASH_TAIL_RE = /-([a-z0-9]*\d[a-z0-9]{5,})(?:-\d{1,3})?$/i;

export function linkedInSlugAliasKey(raw: string): string {
  const match = raw.match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  const slug = (match ? match[1] : raw.replace(/[?#].*$/, "").replace(/\/$/, "")).toLowerCase();

  const tail = slug.match(ALIAS_HASH_TAIL_RE);
  const stripped = slug.replace(ALIAS_HASH_TAIL_RE, "").replace(/[^a-z0-9]/g, "");

  // No discriminator → just the cleaned slug (back-compat with non-hash URLs).
  if (!tail) return stripped;

  // Discriminator present → keep the first N chars of the hash as a secondary
  // factor so john-smith-abc123 and john-smith-xyz456 produce different keys
  // while john-smith-abc123 and john-smith-abc123-1 still alias.
  const discriminator = tail[1].slice(0, ALIAS_HASH_DISCRIMINATOR_CHARS);
  return `${stripped}|${discriminator}`;
}

export function linkedInProfileMatches(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (normaliseLinkedInUrl(a).toLowerCase() === normaliseLinkedInUrl(b).toLowerCase()) return true;

  const aKey = linkedInSlugAliasKey(a);
  const bKey = linkedInSlugAliasKey(b);
  // Exact match (both keys are identical — same stripped + same discriminator,
  // or both have no discriminator and same stripped slug).
  if (aKey.length >= 6 && aKey === bKey) return true;

  // Canonical-redirect tolerance: LinkedIn sometimes returns the same person
  // under both `<name>` (no hash) and `<name>-<hash>` forms. If one side has
  // a discriminator and the other doesn't, fall back to comparing just the
  // stripped slug portions so the bare canonical form still aliases. When
  // BOTH sides have a discriminator they must match in full — that's what
  // prevents `john-smith-abc123` and `john-smith-xyz456` from collapsing.
  const [aStripped, aDisc] = aKey.split("|");
  const [bStripped, bDisc] = bKey.split("|");
  if (aDisc && bDisc) return false;
  return aStripped.length >= 6 && aStripped === bStripped;
}
