import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized } from "@/lib/session";

const CreateTagSchema = z.object({
  label: z.string().min(1).max(50).trim(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

export async function GET() {
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const tags = await prisma.candidateTag.findMany({
    where: auth.isOwner ? {} : { orgId: auth.orgId ?? "__none__" },
    orderBy: { label: "asc" },
    include: { _count: { select: { assignments: true } } },
  });
  return NextResponse.json(tags);
}

export async function POST(req: Request) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  if (!auth.orgId) return NextResponse.json({ error: "No org assigned" }, { status: 400 });

  const result = CreateTagSchema.safeParse(await req.json().catch(() => ({})));
  if (!result.success) {
    return NextResponse.json({ error: result.error.flatten() }, { status: 422 });
  }

  try {
    const tag = await prisma.candidateTag.create({
      data: { orgId: auth.orgId, ...result.data },
    });
    return NextResponse.json(tag, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Tag already exists" }, { status: 409 });
  }
}
