/**
 * Runs before `prisma db push` on production startup.
 * Applies schema changes that db push can't do safely by itself:
 *   1. Deduplicates candidates so the unique (jobId, linkedinUrl) index can be created
 *   2. Adds Job.lastScoredAt if missing
 *   3. Creates UsageEvent table + index if missing
 *   4. Makes Candidate.jobId nullable (candidate persistence after job deletion)
 *   5. Adds Candidate.orgId, archivedJobTitle, archivedJobCompany
 *   6. Rewires Candidate→Job FK to ON DELETE SET NULL
 *   7. Backfills Candidate.orgId from Job
 *   8. Creates CandidateFile table + index + FK if missing
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

  // 4. Make Candidate.jobId nullable (candidates persist after job deletion)
  await prisma.$executeRaw`
    ALTER TABLE "Candidate" ALTER COLUMN "jobId" DROP NOT NULL
  `;
  console.log("[apply-schema] Candidate.jobId nullable ensured");

  // 5. Add Candidate library fields (all nullable, idempotent)
  await prisma.$executeRaw`
    ALTER TABLE "Candidate"
      ADD COLUMN IF NOT EXISTS "orgId"              TEXT,
      ADD COLUMN IF NOT EXISTS "archivedJobTitle"   TEXT,
      ADD COLUMN IF NOT EXISTS "archivedJobCompany" TEXT
  `;
  console.log("[apply-schema] Candidate library columns ensured");

  // 6. Rewire Candidate→Job FK to ON DELETE SET NULL
  //    Drops any existing Candidate→Job FK that isn't already SET NULL, then adds the correct one.
  await prisma.$executeRaw`
    DO $$
    DECLARE
      fk_name TEXT;
      fk_confdeltype CHAR;
    BEGIN
      SELECT conname, confdeltype INTO fk_name, fk_confdeltype
      FROM pg_constraint
      WHERE conrelid = 'public."Candidate"'::regclass
        AND contype = 'f'
        AND confrelid = 'public."Job"'::regclass
      LIMIT 1;

      -- confdeltype 'a' = NO ACTION, 'r' = RESTRICT, 'c' = CASCADE, 'n' = SET NULL, 'd' = SET DEFAULT
      IF fk_name IS NOT NULL AND fk_confdeltype != 'n' THEN
        EXECUTE format('ALTER TABLE "Candidate" DROP CONSTRAINT %I', fk_name);
      END IF;

      IF fk_name IS NULL OR fk_confdeltype != 'n' THEN
        ALTER TABLE "Candidate"
          ADD CONSTRAINT "Candidate_jobId_fkey"
          FOREIGN KEY ("jobId") REFERENCES "Job"("id")
          ON DELETE SET NULL ON UPDATE CASCADE;
      END IF;
    END $$
  `;
  console.log("[apply-schema] Candidate→Job FK ON DELETE SET NULL ensured");

  // 7. Backfill Candidate.orgId from Job (one-time, idempotent)
  const backfilled = await prisma.$executeRaw`
    UPDATE "Candidate" c
    SET "orgId" = j."orgId"
    FROM "Job" j
    WHERE c."jobId" = j."id"
      AND c."orgId" IS NULL
      AND j."orgId" IS NOT NULL
  `;
  console.log(`[apply-schema] Backfilled orgId for ${backfilled} candidate(s)`);

  // 8. CandidateFile table (CV / file attachments)
  await prisma.$executeRaw`
    CREATE TABLE IF NOT EXISTS "CandidateFile" (
      "id"          TEXT         NOT NULL,
      "candidateId" TEXT         NOT NULL,
      "type"        TEXT         NOT NULL,
      "filename"    TEXT         NOT NULL,
      "mimeType"    TEXT         NOT NULL,
      "data"        TEXT         NOT NULL,
      "size"        INTEGER      NOT NULL,
      "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "CandidateFile_pkey" PRIMARY KEY ("id")
    )
  `;
  await prisma.$executeRaw`
    CREATE INDEX IF NOT EXISTS "CandidateFile_candidateId_idx"
    ON "CandidateFile"("candidateId")
  `;
  await prisma.$executeRaw`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'CandidateFile_candidateId_fkey'
      ) THEN
        ALTER TABLE "CandidateFile"
          ADD CONSTRAINT "CandidateFile_candidateId_fkey"
          FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id")
          ON DELETE CASCADE ON UPDATE CASCADE;
      END IF;
    END $$
  `;
  console.log("[apply-schema] CandidateFile table ensured");

} catch (err) {
  console.error("[apply-schema] Failed:", err.message);
  process.exit(1);
} finally {
  await prisma.$disconnect();
}
