import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAuth, requireJobAccess, unauthorized } from "@/lib/session";

/** Delete all candidates for a single job. Owner-only. */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth?.isOwner) return unauthorized();

  const { id } = await params;
  const { job, error } = await requireJobAccess(id, auth);
  if (error || !job) return error;

  const { count } = await prisma.candidate.deleteMany({ where: { jobId: id } });

  console.warn(`[admin] job-wipe: ${count} candidates deleted from job ${id} by orgId=${auth.orgId ?? "owner"}`);
  return NextResponse.json({ deleted: count });
}
