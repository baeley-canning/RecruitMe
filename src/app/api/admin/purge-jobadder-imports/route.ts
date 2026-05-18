import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getAuth, unauthorized } from "@/lib/session";
import { prisma } from "@/lib/db";

function secretsMatch(provided: string | null | undefined, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  try {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export async function GET(req: Request) {
  const cronSecret = req.headers.get("x-cron-secret");
  const cronAuth = secretsMatch(cronSecret, process.env.CONTACT_SYNC_CRON_SECRET);
  if (!cronAuth) {
    const auth = await getAuth();
    if (!auth?.isOwner) return unauthorized();
  }

  const rows = await prisma.$queryRaw<{ source: string; count: bigint }[]>`
    SELECT source, COUNT(*) as count FROM "Candidate" GROUP BY source ORDER BY count DESC
  `;
  const total = await prisma.candidate.count();
  return NextResponse.json({ total, bySource: rows.map(r => ({ source: r.source, count: Number(r.count) })) });
}

export async function DELETE(req: Request) {
  const cronSecret = req.headers.get("x-cron-secret");
  const cronAuth = secretsMatch(cronSecret, process.env.CONTACT_SYNC_CRON_SECRET);

  if (!cronAuth) {
    const auth = await getAuth();
    if (!auth?.isOwner) return unauthorized();
  }

  const { count } = await prisma.candidate.deleteMany({
    where: { source: "jobadder_import" },
  });

  const orphans = await prisma.$executeRaw`
    DELETE FROM "CandidateIdentity"
    WHERE id NOT IN (
      SELECT DISTINCT "candidateIdentityId"
      FROM "Candidate"
      WHERE "candidateIdentityId" IS NOT NULL
    )
  `;

  console.warn(`[admin] purge-jobadder-imports: ${count} candidates + ${orphans} identity rows deleted`);
  return NextResponse.json({ deleted: count, identityRowsRemoved: orphans });
}
