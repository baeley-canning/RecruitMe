import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/db";
import bcrypt from "bcryptjs";
import { z } from "zod";

type AnySession = { user?: { role?: string; id?: string; name?: string | null } } | null;

function isOwner(session: AnySession) {
  return session?.user?.role === "owner";
}

export async function GET() {
  const session = await getServerSession(authOptions) as AnySession;
  if (!isOwner(session)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const users = await prisma.user.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true, username: true, role: true, createdAt: true },
  });
  return NextResponse.json(users);
}

const CreateUserSchema = z.object({
  username: z.string().min(2).max(50).trim(),
  password: z.string().min(6).max(100),
  role: z.enum(["user", "owner"]).default("user"),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions) as AnySession;
  if (!isOwner(session)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const result = CreateUserSchema.safeParse(await req.json().catch(() => ({})));
  if (!result.success) {
    return NextResponse.json({ error: result.error.flatten() }, { status: 422 });
  }

  const { username, password, role } = result.data;
  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) {
    return NextResponse.json({ error: "Username already exists" }, { status: 409 });
  }

  const hashed = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({
    data: { username, password: hashed, role },
    select: { id: true, username: true, role: true, createdAt: true },
  });
  return NextResponse.json(user, { status: 201 });
}

const DeleteSchema = z.object({ id: z.string() });

export async function DELETE(req: Request) {
  const session = await getServerSession(authOptions) as AnySession;
  if (!isOwner(session)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const result = DeleteSchema.safeParse(await req.json().catch(() => ({})));
  if (!result.success) return NextResponse.json({ error: "Invalid request" }, { status: 422 });

  const currentId = session?.user?.id;
  if (result.data.id === currentId) {
    return NextResponse.json({ error: "You cannot delete your own account" }, { status: 400 });
  }

  await prisma.user.delete({ where: { id: result.data.id } });
  return NextResponse.json({ ok: true });
}
