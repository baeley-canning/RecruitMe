import { prisma } from "./db";
import type { AuthResult } from "./session";

// Cross-org candidate-library access. The platform owner manually grants
// view access to org A over org B's library (typically after org A buys a
// higher-tier subscription). Queries that touch the candidate library use
// getAccessibleOrgIds to expand the recruiter's reach beyond their own orgId.
//
// One-way grants only: viewer sees provider, not vice versa.
// Owner (auth.isOwner=true) sees everything regardless of grants.

const CACHE_TTL_MS = 60_000; // 1 minute
const cache = new Map<string, { ids: string[]; expires: number }>();
const scopeCache = new Map<string, { scopes: Set<string>; expires: number }>();

/**
 * Sensitive fields that should only be exposed to viewers whose grant scope
 * is `library_full`. Cross-org `library_read` viewers must see these as null
 * so a partner org's recruiter notes / screening Q&A / interview impressions
 * never leak through the candidate library view. Schema comment in
 * prisma/schema.prisma:66 is the source of truth for the policy.
 */
export const LIBRARY_FULL_SENSITIVE_FIELDS = [
  "notes",
  "screeningData",
  "interviewNotes",
] as const;

/**
 * Returns every orgId whose library the caller can read. Always includes
 * the caller's own orgId. For owners (`auth.isOwner`) returns null — owners
 * bypass org filtering entirely (callers should treat null as "no filter").
 */
export async function getAccessibleOrgIds(auth: AuthResult): Promise<string[] | null> {
  if (auth.isOwner) return null;
  if (!auth.orgId) return [];

  const cacheKey = auth.orgId;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.ids;

  const grants = await prisma.orgAccessGrant.findMany({
    where: {
      viewerOrgId: auth.orgId,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { providerOrgId: true, scope: true },
  });
  // Right now only "library_read" scope grants library access. When more
  // scopes (library_full, anonymous) land, this filter expands.
  const grantedIds = grants
    .filter((g) => g.scope === "library_read")
    .map((g) => g.providerOrgId);
  const ids = [auth.orgId, ...grantedIds];

  cache.set(cacheKey, { ids, expires: Date.now() + CACHE_TTL_MS });
  return ids;
}

/** Build a Prisma where-clause fragment that filters candidates by accessible orgs. */
export function candidateOrgFilter(accessibleOrgIds: string[] | null) {
  if (accessibleOrgIds === null) return {}; // owner — no filter
  if (accessibleOrgIds.length === 0) return { orgId: "__none__" }; // no orgId, no rows
  return {
    OR: [
      { job: { orgId: { in: accessibleOrgIds } } },
      { jobId: null, orgId: { in: accessibleOrgIds } },
    ],
  };
}

/**
 * Returns the set of scopes the viewer has via grants (across every provider
 * org they've been granted access to). Owners get a synthetic set containing
 * every known scope. Used by routes that need to decide whether a viewer is
 * allowed to see sensitive fields (`library_full`) on a cross-org candidate.
 *
 * Today most callers just defensively null sensitive fields when
 * `sharedFromOrgName !== null`. When `library_full` grants start being
 * issued, callers can switch to `scopes.has("library_full")` to permit them.
 */
export async function getGrantScopes(auth: AuthResult): Promise<Set<string>> {
  if (auth.isOwner) return new Set(["library_read", "library_full", "anonymous"]);
  if (!auth.orgId) return new Set();

  const cacheKey = auth.orgId;
  const cached = scopeCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.scopes;

  const grants = await prisma.orgAccessGrant.findMany({
    where: {
      viewerOrgId: auth.orgId,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { scope: true },
  });
  const scopes = new Set(grants.map((g) => g.scope));
  scopeCache.set(cacheKey, { scopes, expires: Date.now() + CACHE_TTL_MS });
  return scopes;
}

/** Invalidate the cache for a given viewer org (called after a grant change). */
export function invalidateAccessCache(viewerOrgId: string) {
  cache.delete(viewerOrgId);
  scopeCache.delete(viewerOrgId);
}

/** For the admin UI — list every grant in the system. Owner-only callers. */
export async function listAllGrants() {
  return prisma.orgAccessGrant.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
  });
}
