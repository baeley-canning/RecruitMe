import { NextResponse } from "next/server";
import { getAuth, unauthorized } from "@/lib/session";
import { revokeApiKey } from "@/lib/api-keys";

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  if (!auth.isOwner) return NextResponse.json({ error: "Owner access required" }, { status: 403 });
  if (!auth.orgId) return NextResponse.json({ error: "No organisation" }, { status: 400 });

  const revoked = await revokeApiKey(params.id, auth.orgId);
  if (!revoked) return NextResponse.json({ error: "Key not found" }, { status: 404 });

  return NextResponse.json({ ok: true });
}
