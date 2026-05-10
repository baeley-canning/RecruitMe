import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { getAuth, requireJobAccess, unauthorized } from "@/lib/session";

const SHARE_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Generate (or rotate) the read-only public shortlist URL token. Tokens
// expire after 30 days so a stray copy in someone's inbox doesn't outlive
// the engagement; recruiter can rotate any time to extend.
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
  const expiresAt = new Date(Date.now() + SHARE_TOKEN_TTL_MS);
  await prisma.job.update({
    where: { id },
    data: { shareToken: token, shareTokenExpiresAt: expiresAt },
  });

  return NextResponse.json({ token, expiresAt: expiresAt.toISOString() });
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

  await prisma.job.update({ where: { id }, data: { shareToken: null, shareTokenExpiresAt: null } });
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

  return NextResponse.json({
    token: job.shareToken,
    expiresAt: job.shareTokenExpiresAt?.toISOString() ?? null,
  });
}
