import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getAuth, verifyAnyAuth, unauthorized } from "@/lib/session";

async function requireAccess(candidateId: string, orgId: string | null, isOwner: boolean) {
  const c = await prisma.candidate.findUnique({ where: { id: candidateId }, select: { orgId: true } });
  if (!c) return false;
  return isOwner || c.orgId === orgId;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;
  if (!await requireAccess(id, auth.orgId, auth.isOwner)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const events = await prisma.contactEvent.findMany({
    where: { candidateId: id },
    orderBy: { createdAt: "desc" },
    select: { id: true, type: true, note: true, userName: true, userId: true, createdAt: true },
  });
  return NextResponse.json(events);
}

const PostSchema = z.object({
  type: z.enum(["message", "call", "email", "other"]),
  note: z.string().max(500).optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // Accept both NextAuth session (web UI) and Basic auth (browser extension)
  const auth = await verifyAnyAuth(req) ?? await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;
  if (!await requireAccess(id, auth.orgId, auth.isOwner)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const parsed = PostSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 });

  const { type, note } = parsed.data;
  const user = await prisma.user.findUnique({ where: { id: auth.userId }, select: { username: true } });
  const event = await prisma.contactEvent.create({
    data: {
      candidateId: id,
      orgId:    auth.orgId,
      userId:   auth.userId,
      userName: user?.username ?? auth.userId,
      type,
      note: note?.trim() || null,
    },
  });
  return NextResponse.json(event, { status: 201 });
}
