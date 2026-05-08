import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { withJobAuth } from "@/lib/session";

export const GET = withJobAuth(async ({ params }) => {
  const history = await prisma.jobParseHistory.findMany({
    where: { jobId: params.id },
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
});
