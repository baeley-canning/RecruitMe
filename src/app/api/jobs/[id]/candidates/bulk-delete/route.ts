import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAuth, requireJobAccess, unauthorized } from "@/lib/session";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;
  const { error } = await requireJobAccess(id, auth);
  if (error) return error;
  const { ids } = await req.json() as { ids?: string[] };

  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: "No IDs provided" }, { status: 422 });
  }

  const { count } = await prisma.candidate.deleteMany({
    where: { id: { in: ids }, jobId: id },
  });

  return NextResponse.json({ deleted: count });
}
