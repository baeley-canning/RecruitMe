/**
 * Runs before `prisma db push` on production startup.
 * Applies schema changes that db push can't do safely by itself:
 *   1. Deduplicates candidates so the unique (jobId, linkedinUrl) index can be created
 *   2. Adds Job.lastScoredAt if missing
 *   3. Creates UsageEvent table + index if missing
 *
 * Uses Prisma $executeRaw — idempotent, no migration history required.
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

try {
  // 1. Remove duplicate (jobId, linkedinUrl) candidates.
  const deleted = await prisma.$executeRaw`
    DELETE FROM "Candidate"
    WHERE "linkedinUrl" IS NOT NULL
      AND id NOT IN (
        SELECT DISTINCT ON ("jobId", "linkedinUrl") id
        FROM "Candidate"
        WHERE "linkedinUrl" IS NOT NULL
        ORDER BY "jobId", "linkedinUrl",
                 COALESCE("matchScore", -1) DESC,
                 "updatedAt" DESC
      )
  `;
  console.log(`[apply-schema] Removed ${deleted} duplicate candidate(s)`);

  // 2. Job.lastScoredAt
  await prisma.$executeRaw`
    ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "lastScoredAt" TIMESTAMP(3)
  `;
  console.log("[apply-schema] Job.lastScoredAt ensured");

  // 3. UsageEvent table
  await prisma.$executeRaw`
    CREATE TABLE IF NOT EXISTS "UsageEvent" (
      "id"        TEXT         NOT NULL,
      "orgId"     TEXT,
      "userId"    TEXT,
      "type"      TEXT         NOT NULL,
      "meta"      TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "UsageEvent_pkey" PRIMARY KEY ("id")
    )
  `;
  await prisma.$executeRaw`
    CREATE INDEX IF NOT EXISTS "UsageEvent_orgId_type_createdAt_idx"
    ON "UsageEvent"("orgId", "type", "createdAt")
  `;
  console.log("[apply-schema] UsageEvent table ensured");

} catch (err) {
  console.error("[apply-schema] Failed:", err.message);
  process.exit(1);
} finally {
  await prisma.$disconnect();
}
