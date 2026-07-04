/**
 * POST /api/admin/users/links — owner generates a single-use auth link.
 *
 * Two kinds:
 *  - { kind: "invite", orgId?, role? }  → /join/<token>   (new user sets their
 *    own username + password; the owner never knows or transmits a password)
 *  - { kind: "reset", userId }          → /reset-password/<token> (locked-out
 *    user sets a new password)
 *
 * Email-free by design: the response carries the URL; the owner hands it over
 * out-of-band. Owner-only, same gate as the rest of /api/admin/users.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { isOwner } from "@/lib/access";
import { createInviteToken, createResetToken, linkBaseUrl } from "@/lib/auth-tokens";

type AnySession = { user?: { role?: string; id?: string } } | null;

const BodySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("invite"),
    orgId: z.string().optional().nullable(),
    role: z.enum(["user", "owner"]).default("user"),
  }),
  z.object({
    kind: z.literal("reset"),
    userId: z.string().min(1),
  }),
]);

export async function POST(req: Request) {
  const session = (await getServerSession(authOptions)) as AnySession;
  if (!isOwner(session)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 });

  const base = linkBaseUrl(req);
  const createdBy = session?.user?.id ?? null;

  if (parsed.data.kind === "invite") {
    const orgId = parsed.data.role === "owner" ? null : (parsed.data.orgId || null);
    if (orgId) {
      const org = await prisma.org.findUnique({ where: { id: orgId }, select: { id: true } });
      if (!org) return NextResponse.json({ error: "Org not found" }, { status: 404 });
    }
    const { raw, expiresAt } = await createInviteToken({ orgId, role: parsed.data.role, createdBy });
    return NextResponse.json({ url: `${base}/join/${raw}`, expiresAt }, { status: 201 });
  }

  const user = await prisma.user.findUnique({
    where: { id: parsed.data.userId },
    select: { id: true, username: true },
  });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
  const { raw, expiresAt } = await createResetToken({ userId: user.id, createdBy });
  return NextResponse.json(
    { url: `${base}/reset-password/${raw}`, expiresAt, username: user.username },
    { status: 201 },
  );
}
