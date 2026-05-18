import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized, forbidden } from "@/lib/session";
import { invalidateAccessCache } from "@/lib/org-access";

// Owner-only: revoke a single cross-org access grant.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  if (!auth.isOwner) return forbidden();

  const { id } = await params;
  const grant = await prisma.orgAccessGrant.findUnique({
    where: { id },
    select: { id: true, viewerOrgId: true },
  });
  if (!grant) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.orgAccessGrant.delete({ where: { id } });
  invalidateAccessCache(grant.viewerOrgId);
  return NextResponse.json({ ok: true });
}
