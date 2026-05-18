import { NextResponse } from "next/server";
import { getAuth, unauthorized } from "@/lib/session";
import { prisma } from "@/lib/db";

export async function DELETE(req: Request) {
  const auth = await getAuth();
  if (!auth?.isOwner) return unauthorized();

  if (!auth.orgId) {
    return NextResponse.json(
      { error: "No organisation on this account — cannot scope deletion safely." },
      { status: 400 }
    );
  }

  const { count } = await prisma.candidate.deleteMany({
    where: { orgId: auth.orgId, source: "jobadder_import" },
  });

  // Clean up CandidateIdentity rows that no longer have any candidates.
  const orphans = await prisma.$executeRaw`
    DELETE FROM "CandidateIdentity"
    WHERE "orgId" = ${auth.orgId}
      AND id NOT IN (
        SELECT DISTINCT "candidateIdentityId"
        FROM "Candidate"
        WHERE "candidateIdentityId" IS NOT NULL
          AND "orgId" = ${auth.orgId}
      )
  `;

  console.warn(`[admin] purge-jobadder-imports: ${count} candidates + ${orphans} identity rows deleted by orgId=${auth.orgId}`);
  return NextResponse.json({ deleted: count, identityRowsRemoved: orphans });
}
