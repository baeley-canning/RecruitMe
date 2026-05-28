import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized } from "@/lib/session";

const ClientSchema = z.object({
  name:           z.string().min(1).max(200).trim(),
  industry:       z.string().max(100).trim().optional().nullable(),
  website:        z.string().max(500).trim().optional().nullable(),
  primaryContact: z.string().max(200).trim().optional().nullable(),
  email:          z.string().email().max(200).trim().optional().nullable(),
  phone:          z.string().max(50).trim().optional().nullable(),
  notes:          z.string().max(5000).trim().optional().nullable(),
});

export async function GET() {
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const where = auth.isOwner ? {} : { orgId: auth.orgId ?? "__none__" };
  const clients = await prisma.client.findMany({
    where,
    orderBy: { name: "asc" },
    include: { _count: { select: { jobs: true } } },
  });
  return NextResponse.json(clients);
}

export async function POST(req: Request) {
  const auth = await getAuth();
  if (!auth) return unauthorized();

  if (!auth.orgId) {
    return NextResponse.json({ error: "Account has no organisation assigned" }, { status: 400 });
  }

  const result = ClientSchema.safeParse(await req.json().catch(() => ({})));
  if (!result.success) {
    return NextResponse.json({ error: result.error.flatten() }, { status: 422 });
  }

  const client = await prisma.client.create({
    data: { ...result.data, orgId: auth.orgId },
  });

  return NextResponse.json(client, { status: 201 });
}
