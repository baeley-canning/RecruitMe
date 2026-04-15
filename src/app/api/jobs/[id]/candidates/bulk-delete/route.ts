import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { ids } = await req.json() as { ids?: string[] };

  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: "No IDs provided" }, { status: 422 });
  }

  const { count } = await prisma.candidate.deleteMany({
    where: { id: { in: ids }, jobId: id },
  });

  return NextResponse.json({ deleted: count });
}
