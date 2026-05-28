import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized } from "@/lib/session";

const MergeSchema = z.object({
  primaryId:   z.string(),
  duplicateIds: z.array(z.string()).min(1).max(20),
});

export async function POST(req: Request) {
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const result = MergeSchema.safeParse(await req.json().catch(() => ({})));
  if (!result.success) {
    return NextResponse.json({ error: result.error.flatten() }, { status: 422 });
  }

  const { primaryId, duplicateIds } = result.data;
  const orgFilter = auth.isOwner ? {} : { orgId: auth.orgId ?? "__none__" };

  // Verify all candidates belong to the same org
  const all = await prisma.candidate.findMany({
    where: { id: { in: [primaryId, ...duplicateIds] }, ...orgFilter },
    select: { id: true, files: { select: { id: true } } },
  });

  if (all.length !== 1 + duplicateIds.length) {
    return NextResponse.json({ error: "One or more candidates not found" }, { status: 404 });
  }

  // Merge: transfer files from duplicates to primary, then delete duplicates
  await prisma.$transaction(async tx => {
    for (const dupId of duplicateIds) {
      // Reparent files
      await tx.candidateFile.updateMany({
        where: { candidateId: dupId },
        data: { candidateId: primaryId },
      });
      // Reparent submissions
      await tx.submission.updateMany({
        where: { candidateId: dupId },
        data: { candidateId: primaryId },
      });
      // Delete the duplicate
      await tx.candidate.delete({ where: { id: dupId } });
    }
  });

  return NextResponse.json({ merged: duplicateIds.length, primaryId });
}
