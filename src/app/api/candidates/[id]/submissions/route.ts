import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized } from "@/lib/session";
import { isCrmEnabled } from "@/lib/feature-flags";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isCrmEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const { id: candidateId } = await params;

  const submissions = await prisma.submission.findMany({
    where: {
      candidateId,
      ...(auth.isOwner ? {} : { orgId: auth.orgId ?? "__none__" }),
    },
    orderBy: { submittedAt: "desc" },
    include: {
      client: { select: { id: true, name: true } },
    },
  });

  return NextResponse.json(submissions);
}
