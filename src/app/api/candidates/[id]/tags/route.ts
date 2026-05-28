import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized } from "@/lib/session";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const { id: candidateId } = await params;
  const assignments = await prisma.candidateTagAssignment.findMany({
    where: { candidateId },
    include: { tag: true },
  });
  return NextResponse.json(assignments.map(a => a.tag));
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const { id: candidateId } = await params;
  const body = await req.json().catch(() => ({})) as { tagIds?: string[] };
  const tagIds: string[] = Array.isArray(body.tagIds) ? body.tagIds : [];

  // Replace all tag assignments atomically
  await prisma.$transaction([
    prisma.candidateTagAssignment.deleteMany({ where: { candidateId } }),
    ...(tagIds.length > 0
      ? [prisma.candidateTagAssignment.createMany({
          data: tagIds.map(tagId => ({ candidateId, tagId })),
          skipDuplicates: true,
        })]
      : []),
  ]);

  const assignments = await prisma.candidateTagAssignment.findMany({
    where: { candidateId },
    include: { tag: true },
  });
  return NextResponse.json(assignments.map(a => a.tag));
}
