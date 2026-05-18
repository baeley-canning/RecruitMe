/**
 * One-time script: delete all candidates imported from JobAdder.
 *
 * Run via Railway CLI:
 *   railway run node scripts/purge-jobadder-imports.mjs
 *
 * Cascade deletes: CandidateFile, ContactEvent, ScoreCorrection,
 * ReferenceCheck, FetchSession are all ON DELETE CASCADE — gone automatically.
 * CandidateIdentity rows are left; orphans are cleaned up at the end.
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const count = await prisma.candidate.count({
  where: { source: "jobadder_import" },
});

console.log(`Found ${count} jobadder_import candidates — deleting...`);

if (count === 0) {
  console.log("Nothing to do.");
  await prisma.$disconnect();
  process.exit(0);
}

const { count: deleted } = await prisma.candidate.deleteMany({
  where: { source: "jobadder_import" },
});

console.log(`Deleted ${deleted} candidates (+ cascaded files, events, corrections).`);

// Clean up CandidateIdentity rows that no longer have any candidates.
const orphans = await prisma.$executeRaw`
  DELETE FROM "CandidateIdentity"
  WHERE id NOT IN (
    SELECT DISTINCT "candidateIdentityId"
    FROM "Candidate"
    WHERE "candidateIdentityId" IS NOT NULL
  )
`;
console.log(`Removed ${orphans} orphaned CandidateIdentity row(s).`);

await prisma.$disconnect();
