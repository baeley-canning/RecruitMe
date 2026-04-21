import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { z } from "zod";

type AnySession = { user?: { role?: string } } | null;

function isOwner(session: AnySession) {
  return session?.user?.role === "owner";
}

export async function GET() {
  const session = await getServerSession(authOptions) as AnySession;
  if (!isOwner(session)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const orgs = await prisma.org.findMany({
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      createdAt: true,
      _count: { select: { users: true, jobs: true } },
    },
  });
  return NextResponse.json(orgs);
}

const CreateOrgSchema = z.object({
  name: z.string().min(1).max(100).trim(),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions) as AnySession;
  if (!isOwner(session)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const result = CreateOrgSchema.safeParse(await req.json().catch(() => ({})));
  if (!result.success) {
    return NextResponse.json({ error: result.error.flatten() }, { status: 422 });
  }

  const { name } = result.data;
  const existing = await prisma.org.findUnique({ where: { name } });
  if (existing) {
    return NextResponse.json({ error: "An organisation with that name already exists" }, { status: 409 });
  }

  const org = await prisma.org.create({
    data: { name },
    select: {
      id: true, name: true, createdAt: true,
      _count: { select: { users: true, jobs: true } },
    },
  });
  return NextResponse.json(org, { status: 201 });
}

const DeleteOrgSchema = z.object({ id: z.string() });

export async function DELETE(req: Request) {
  const session = await getServerSession(authOptions) as AnySession;
  if (!isOwner(session)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const result = DeleteOrgSchema.safeParse(await req.json().catch(() => ({})));
  if (!result.success) return NextResponse.json({ error: "Invalid request" }, { status: 422 });

  const { id } = result.data;
  // Null out orgId on users and jobs before deleting to avoid dangling references
  await prisma.$transaction([
    prisma.user.updateMany({ where: { orgId: id }, data: { orgId: null } }),
    prisma.job.updateMany({ where: { orgId: id }, data: { orgId: null } }),
    prisma.org.delete({ where: { id } }),
  ]);

  return NextResponse.json({ ok: true });
}
