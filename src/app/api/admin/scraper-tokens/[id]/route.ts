/**
 * DELETE /api/admin/scraper-tokens/[id] — REVOKE a scraper token (owner-only).
 *
 * Soft revoke: sets revokedAt rather than deleting the row, so the audit trail
 * (label, org, lastUsedAt) survives. verifyScraperAuth rejects any token with
 * revokedAt set, so the box using it is locked out immediately.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { isOwner } from "@/lib/access";

type AnySession = { user?: { role?: string } } | null;

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = (await getServerSession(authOptions)) as AnySession;
  if (!isOwner(session)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  // Guarded: only flip an as-yet-unrevoked token, so a double-click doesn't
  // move revokedAt forward and the response honestly reflects "already revoked".
  const res = await prisma.scraperApiToken.updateMany({
    where: { id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (res.count === 0) {
    const exists = await prisma.scraperApiToken.findUnique({ where: { id }, select: { id: true } });
    if (!exists) return NextResponse.json({ error: "Token not found" }, { status: 404 });
    return NextResponse.json({ ok: true, alreadyRevoked: true });
  }
  return NextResponse.json({ ok: true });
}
