import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized } from "@/lib/session";

async function getClient(id: string, orgId: string | null, isOwner: boolean) {
  return prisma.client.findFirst({
    where: { id, ...(isOwner ? {} : { orgId: orgId ?? "__none__" }) },
  });
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const { id } = await params;
  const client = await prisma.client.findFirst({
    where: { id, ...(auth.isOwner ? {} : { orgId: auth.orgId ?? "__none__" }) },
    include: {
      jobs: {
        select: { id: true, title: true, status: true, createdAt: true, _count: { select: { candidates: true } } },
        orderBy: { createdAt: "desc" },
      },
    },
  });

  if (!client) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(client);
}

const PatchSchema = z.object({
  name:           z.string().min(1).max(200).trim().optional(),
  industry:       z.string().max(100).trim().nullable().optional(),
  website:        z.string().max(500).trim().nullable().optional(),
  primaryContact: z.string().max(200).trim().nullable().optional(),
  email:          z.string().email().max(200).trim().nullable().optional(),
  phone:          z.string().max(50).trim().nullable().optional(),
  notes:          z.string().max(5000).trim().nullable().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const { id } = await params;
  const existing = await getClient(id, auth.orgId, auth.isOwner);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const result = PatchSchema.safeParse(await req.json().catch(() => ({})));
  if (!result.success) {
    return NextResponse.json({ error: result.error.flatten() }, { status: 422 });
  }

  const updated = await prisma.client.update({ where: { id }, data: result.data });
  return NextResponse.json(updated);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const { id } = await params;
  const existing = await getClient(id, auth.orgId, auth.isOwner);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Unlink jobs before deleting to avoid FK constraint failure
  await prisma.job.updateMany({ where: { clientId: id }, data: { clientId: null } });
  await prisma.client.delete({ where: { id } });

  return NextResponse.json({ deleted: true });
}
