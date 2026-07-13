import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/db";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { isOwner } from "@/lib/access";
import { parsePermissions, serializePermissions, ALL_CAPABILITIES } from "@/lib/permissions";

type AnySession = { user?: { role?: string; id?: string; name?: string | null } } | null;

export async function GET() {
  const session = await getServerSession(authOptions) as AnySession;
  if (!isOwner(session)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const users = await prisma.user.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      username: true,
      role: true,
      permissions: true,
      createdAt: true,
      orgId: true,
      org: { select: { name: true } },
    },
  });
  return NextResponse.json(
    users.map(({ org, permissions, ...u }) => ({
      ...u,
      orgName: org?.name ?? null,
      // Owners implicitly hold everything; surface that so the UI can show all
      // toggles checked-and-locked for them.
      permissions: u.role === "owner" ? ALL_CAPABILITIES : parsePermissions(permissions),
    }))
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
  const session = await getServerSession(authOptions) as AnySession;
  if (!isOwner(session)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

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

const PatchUserSchema = z.object({
  id:          z.string(),
  username:    z.string().min(2).max(50).trim().optional(),
  password:    z.string().min(8).max(100)
                 .regex(/[0-9!@#$%^&*()_\-+=[\]{};':"\\|,.<>/?]/, "Password must contain at least one number or special character")
                 .optional(),
  role:        z.enum(["user", "owner"]).optional(),
  orgId:       z.string().nullable().optional(),
  // Per-user capability grants (RBAC). Unknown slugs are dropped on serialize.
  permissions: z.array(z.string()).optional(),
});

export async function PATCH(req: Request) {
  const session = await getServerSession(authOptions) as AnySession;
  if (!isOwner(session)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const result = PatchUserSchema.safeParse(await req.json().catch(() => ({})));
  if (!result.success) return NextResponse.json({ error: result.error.flatten() }, { status: 422 });

  const { id, username, password, role, orgId, permissions } = result.data;

  // Can't demote yourself — would lock you out
  if (id === session?.user?.id && role === "user") {
    return NextResponse.json({ error: "You cannot demote your own account" }, { status: 400 });
  }

  if (username) {
    const conflict = await prisma.user.findFirst({ where: { username, NOT: { id } } });
    if (conflict) return NextResponse.json({ error: "Username already taken" }, { status: 409 });
  }

  const data: Record<string, unknown> = {};
  if (username)            data.username = username;
  if (password)            data.password = await bcrypt.hash(password, 12);
  if (role !== undefined)  data.role     = role;
  if (orgId !== undefined) data.orgId    = role === "owner" ? null : orgId;
  // Store the granted capability set (owners don't need it — they hold all).
  if (permissions !== undefined) data.permissions = serializePermissions(permissions);

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const updated = await prisma.user.update({
    where: { id },
    data,
    select: { id: true, username: true, role: true, orgId: true },
  });
  return NextResponse.json(updated);
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
