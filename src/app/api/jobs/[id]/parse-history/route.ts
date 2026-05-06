import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAuth, requireJobAccess, unauthorized } from "@/lib/session";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;
  const { error } = await requireJobAccess(id, auth);
  if (error) return error;

  const history = await prisma.jobParseHistory.findMany({
    where: { jobId: id },
    orderBy: { parsedAt: "desc" },
    take: 10,
    select: {
      id: true,
      parsedAt: true,
      anchorTerms: true,
      mustHaveCount: true,
      changes: true,
      evaluation: true,
    },
  });

  return NextResponse.json(history);
}
