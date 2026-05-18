import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAuth, requireJobAccess, unauthorized } from "@/lib/session";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; savedId: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id, savedId } = await params;

  const { error } = await requireJobAccess(id, auth);
  if (error) return error;

  // Scope by both jobId and savedId so a malicious user can't pass another job's
  // saved-search ID and delete it via a job they happen to own.
  const result = await prisma.savedSearch.deleteMany({
    where: { id: savedId, jobId: id },
  });

  if (result.count === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
