import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { getAuth, requireJobAccess, unauthorized } from "@/lib/session";

// Generate (or rotate) the read-only public shortlist URL token.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;

  const { error } = await requireJobAccess(id, auth);
  if (error) return error;

  // 32 bytes → 43-char URL-safe token. Plenty of entropy; not guessable.
  const token = randomBytes(32).toString("base64url");
  await prisma.job.update({ where: { id }, data: { shareToken: token } });

  return NextResponse.json({ token });
}

// Revoke the share token; existing public URLs stop working.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;

  const { error } = await requireJobAccess(id, auth);
  if (error) return error;

  await prisma.job.update({ where: { id }, data: { shareToken: null } });
  return NextResponse.json({ ok: true });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;

  const { job, error } = await requireJobAccess(id, auth);
  if (error || !job) return error;

  return NextResponse.json({ token: job.shareToken });
}
