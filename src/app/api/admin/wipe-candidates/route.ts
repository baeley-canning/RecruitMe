import { NextResponse } from "next/server";
import { getAuth, unauthorized } from "@/lib/session";
import { prisma } from "@/lib/db";

export async function DELETE(req: Request) {
  const auth = await getAuth();
  if (!auth?.isOwner) return unauthorized();

  // Require explicit confirmation in the request body to prevent accidental wipes.
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  if (body.confirm !== "DELETE_ALL_CANDIDATES") {
    return NextResponse.json(
      { error: "Pass { confirm: 'DELETE_ALL_CANDIDATES' } in the request body to confirm." },
      { status: 400 }
    );
  }

  // Scope to the owner's org — never wipe across all orgs.
  const where = auth.orgId ? { orgId: auth.orgId } : {};
  const { count } = await prisma.candidate.deleteMany({ where });

  console.warn(`[admin] wipe-candidates: ${count} records deleted by orgId=${auth.orgId ?? "owner"}`);
  return NextResponse.json({ deleted: count });
}
