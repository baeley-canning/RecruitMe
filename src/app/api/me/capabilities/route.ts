/**
 * GET /api/me/capabilities — the logged-in user's effective capability set.
 *
 * Read fresh from the DB (not the JWT) so an owner's grant/revoke shows up on
 * the next page load without a re-login. Drives the client-side locks
 * (usePermissions). The SERVER enforcement (requireCapability) is the real
 * protection — this is only for hiding/greying actions the user can't use.
 */

import { NextResponse } from "next/server";
import { getAuth, unauthorized } from "@/lib/session";
import { getUserPermissions } from "@/lib/require-capability";
import { effectiveCapabilities } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const permissions = auth.isOwner ? [] : await getUserPermissions(auth.userId);
  return NextResponse.json({
    isOwner: auth.isOwner,
    capabilities: effectiveCapabilities({ isOwner: auth.isOwner, permissions }),
  });
}
