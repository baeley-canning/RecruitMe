import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized } from "@/lib/session";

async function requireFileAccess(
  candidateId: string,
  fileId: string,
  auth: NonNullable<Awaited<ReturnType<typeof getAuth>>>
) {
  const file = await prisma.candidateFile.findFirst({
    where: { id: fileId, candidateId },
    include: { candidate: { include: { job: { select: { orgId: true } } } } },
  });
  if (!file) return null;
  if (!auth.isOwner && file.candidate.job.orgId !== auth.orgId) return null;
  return file;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; fileId: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id, fileId } = await params;

  const file = await requireFileAccess(id, fileId, auth);
  if (!file) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const buffer = Buffer.from(file.data, "base64");
  return new Response(buffer, {
    headers: {
      "Content-Type": file.mimeType,
      "Content-Disposition": `attachment; filename="${encodeURIComponent(file.filename)}"`,
      "Content-Length": String(buffer.length),
    },
  });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; fileId: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id, fileId } = await params;

  const file = await requireFileAccess(id, fileId, auth);
  if (!file) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.candidateFile.delete({ where: { id: fileId } });
  return NextResponse.json({ ok: true });
}
