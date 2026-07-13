/**
 * Server-side capability enforcement — the authoritative credit protection.
 *
 * DB-backed so an owner's grant/revoke takes effect on the next action (no
 * re-login). Owner short-circuits without a DB read. Kept out of permissions.ts
 * so that module stays pure + unit-testable without prisma/next.
 */

import { NextResponse } from "next/server";
import { prisma } from "./db";
import { parsePermissions, capabilityLabel, type Capability } from "./permissions";

/** Fresh grant set for a user (empty on any lookup failure — fail closed). */
export async function getUserPermissions(userId: string): Promise<Capability[]> {
  try {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { permissions: true } });
    return parsePermissions(u?.permissions ?? null);
  } catch {
    return [];
  }
}

/**
 * Returns null when the caller may perform `cap`, or a 403 JSON response when
 * not. Usage in a route:
 *   const denied = await requireCapability(auth, "score");
 *   if (denied) return denied;
 */
export async function requireCapability(
  auth: { userId: string; isOwner: boolean },
  cap: Capability,
): Promise<NextResponse | null> {
  if (auth.isOwner) return null;
  const perms = await getUserPermissions(auth.userId);
  if (perms.includes(cap)) return null;
  return NextResponse.json(
    {
      error: `You don't have access to "${capabilityLabel(cap)}". Ask an owner to grant it.`,
      code: "capability_denied",
      capability: cap,
    },
    { status: 403 },
  );
}
