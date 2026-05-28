import { NextResponse } from "next/server";
import { getAuth, unauthorized } from "@/lib/session";
import { clusterArchetypes } from "@/lib/archetype/clustering";

export async function POST(_req: Request) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  if (!auth.isOwner) {
    return NextResponse.json({ error: "Owner access required" }, { status: 403 });
  }
  if (!auth.orgId) {
    return NextResponse.json({ error: "No organisation" }, { status: 400 });
  }

  try {
    const result = await clusterArchetypes(auth.orgId);
    return NextResponse.json({
      ok: true,
      created: result.created,
      updated: result.updated,
      antiArchetypes: result.antiArchetypes,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Clustering failed" },
      { status: 500 }
    );
  }
}
