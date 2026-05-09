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

/** Invalidate the cache for a given viewer org (called after a grant change). */
export function invalidateAccessCache(viewerOrgId: string) {
  cache.delete(viewerOrgId);
}

/** For the admin UI — list every grant in the system. Owner-only callers. */
export async function listAllGrants() {
  return prisma.orgAccessGrant.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
  });
}
