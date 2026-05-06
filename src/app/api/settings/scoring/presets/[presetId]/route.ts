import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized } from "@/lib/session";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ presetId: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { presetId } = await params;

  // Scope by orgId so a malicious user can't delete another org's preset by ID.
  const result = await prisma.scoringWeightPreset.deleteMany({
    where: {
      id: presetId,
      ...(auth.isOwner ? {} : { orgId: auth.orgId }),
    },
  });

  if (result.count === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
