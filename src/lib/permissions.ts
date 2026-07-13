/**
 * Capability-based access control for the paid / API-consuming actions.
 *
 * The problem this solves: several users share the app while we build, and every
 * search / score / parse / enrich / AI-writing action spends real money (Claude
 * tokens, SEEK/LinkedIn scraping, PDL credits). We DEFAULT-DENY those actions
 * for non-owners so nobody burns credits until an owner explicitly grants the
 * capability.
 *
 * Model:
 *  - role "owner" implicitly has EVERY capability (the admin — you).
 *  - role "user" has only the capability slugs stored in User.permissions (a
 *    JSON array). Null/empty = can use the free parts of the app but none of the
 *    paid actions.
 *
 * Enforcement is DB-backed (getUserPermissions / requireCapability), so an
 * owner's grant takes effect immediately — no re-login needed. The client lock
 * (see /api/me/capabilities + usePermissions) is UX; the server check is the
 * real protection.
 */

export interface CapabilityMeta {
  slug: string;
  label: string;
  /** Shown in the admin grant UI + the client lock tooltip. */
  description: string;
}

export const CAPABILITIES = [
  { slug: "search",   label: "Talent search", description: "Run live LinkedIn/SEEK discovery searches (scraper + provider credits)." },
  { slug: "enrich",   label: "PDL enrich",    description: "Fill candidate blanks from People Data Labs (PDL credits)." },
  { slug: "score",    label: "AI scoring",    description: "Score / re-score candidates with AI (Claude tokens)." },
  { slug: "parse",    label: "JD parsing",    description: "Parse / re-analyse job descriptions with AI (Claude tokens)." },
  { slug: "outreach", label: "AI writing",    description: "Generate outreach, emails, offer letters, references, ads (Claude tokens)." },
] as const satisfies readonly CapabilityMeta[];

export type Capability = (typeof CAPABILITIES)[number]["slug"];

export const ALL_CAPABILITIES: Capability[] = CAPABILITIES.map((c) => c.slug);
const CAP_SET = new Set<string>(ALL_CAPABILITIES);

export function isCapability(x: unknown): x is Capability {
  return typeof x === "string" && CAP_SET.has(x);
}

/** Parse the stored JSON array, dropping anything not a known capability. */
export function parsePermissions(raw: string | null | undefined): Capability[] {
  if (!raw) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr.filter(isCapability);
}

/** Serialize a grant set for storage — dedup + drop unknown slugs. */
export function serializePermissions(caps: readonly string[]): string {
  const clean = [...new Set(caps.filter(isCapability))];
  return JSON.stringify(clean);
}

/** Owner has everything; a user has only what's been granted. */
export function hasCapability(
  principal: { isOwner: boolean; permissions: readonly Capability[] },
  cap: Capability,
): boolean {
  return principal.isOwner || principal.permissions.includes(cap);
}

/** The effective capability set for a principal (owner ⇒ all). */
export function effectiveCapabilities(principal: { isOwner: boolean; permissions: readonly Capability[] }): Capability[] {
  return principal.isOwner ? [...ALL_CAPABILITIES] : ALL_CAPABILITIES.filter((c) => principal.permissions.includes(c));
}

export function capabilityLabel(cap: string): string {
  return CAPABILITIES.find((c) => c.slug === cap)?.label ?? cap;
}
