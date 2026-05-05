import { auth } from "@/auth";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import bcrypt from "bcryptjs";
import { z } from "zod";

type AnySession = { user?: { role?: string; id?: string; name?: string | null } } | null;


export async function GET() {
  const session = await auth();
  if (session?.user?.role !== "owner") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const users = await prisma.user.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      username: true,
      role: true,
      createdAt: true,
      orgId: true,
      org: { select: { name: true } },
    },
  });
  return NextResponse.json(
    users.map(({ org, ...u }) => ({ ...u, orgName: org?.name ?? null }))
  );
}

const CreateUserSchema = z.object({
  username: z.string().min(2).max(50).trim(),
  password: z.string().min(8, "Password must be at least 8 characters").max(100)
    .regex(/[0-9!@#$%^&*()_\-+=[\]{};':"\\|,.<>/?]/, "Password must contain at least one number or special character"),
  role: z.enum(["user", "owner"]).default("user"),
  orgId: z.string().optional(),
});

export async function POST(req: Request) {
  const session = await auth();
  if (session?.user?.role !== "owner") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const result = CreateUserSchema.safeParse(await req.json().catch(() => ({})));
  if (!result.success) {
    return NextResponse.json({ error: result.error.flatten() }, { status: 422 });
  }

  const { username, password, role, orgId } = result.data;
  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) {
    return NextResponse.json({ error: "Username already exists" }, { status: 409 });
  }

  const hashed = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({
    data: {
      username,
      password: hashed,
      role,
      orgId: role === "owner" ? null : (orgId || null),
    },
    select: { id: true, username: true, role: true, createdAt: true },
  });
  return NextResponse.json(user, { status: 201 });
}

const DeleteSchema = z.object({ id: z.string() });

export async function DELETE(req: Request) {
  const session = await auth();
  if (session?.user?.role !== "owner") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const result = DeleteSchema.safeParse(await req.json().catch(() => ({})));
  if (!result.success) return NextResponse.json({ error: "Invalid request" }, { status: 422 });

  const currentId = session?.user?.id;
  if (result.data.id === currentId) {
    return NextResponse.json({ error: "You cannot delete your own account" }, { status: 400 });
  }

  await prisma.user.delete({ where: { id: result.data.id } });
  return NextResponse.json({ ok: true });
}
