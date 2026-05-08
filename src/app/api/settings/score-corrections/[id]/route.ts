import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { withAuth } from "@/lib/session";

// Delete a single score correction. Used by the memory viewer when a
// recruiter realises a past correction was a mistake or no longer reflects
// their thinking. Org-scoped — non-owners can only delete their own org's.
export const DELETE = withAuth(async ({ auth, params }) => {
  const id = (params as { id: string }).id;
  const correction = await prisma.scoreCorrection.findUnique({
    where: { id },
    select: { id: true, orgId: true },
  });
  if (!correction) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!auth.isOwner && correction.orgId !== auth.orgId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  await prisma.scoreCorrection.delete({ where: { id } });
  return NextResponse.json({ ok: true });
});
