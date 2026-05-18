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

  // Always scope by orgId — even owners can only delete presets in their own org.
  const result = await prisma.scoringWeightPreset.deleteMany({
    where: {
      id: presetId,
      orgId: auth.orgId,
    },
  });

  if (result.count === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
