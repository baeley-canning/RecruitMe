/**
 * Runs before `prisma db push` on production startup.
 * Each step is independently wrapped so one failure doesn't block the rest.
 * All steps are idempotent — safe to run on every startup.
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

let anyFailed = false;

async function step(label, fn) {
  try {
    await fn();
    console.log(`[apply-schema] ✓ ${label}`);
  } catch (err) {
    console.error(`[apply-schema] ✗ ${label}: ${err.message}`);
    anyFailed = true;
  }
}

// 1. Deduplicate candidates on (jobId, linkedinUrl) so the unique index can exist.
//    Only deduplicates rows where BOTH jobId and linkedinUrl are non-null.
await step("deduplicate candidates", async () => {
  const deleted = await prisma.$executeRaw`
    DELETE FROM "Candidate"
    WHERE "linkedinUrl" IS NOT NULL
      AND "jobId" IS NOT NULL
      AND id NOT IN (
        SELECT DISTINCT ON ("jobId", "linkedinUrl") id
        FROM "Candidate"
        WHERE "linkedinUrl" IS NOT NULL
          AND "jobId" IS NOT NULL
        ORDER BY "jobId", "linkedinUrl",
                 COALESCE("matchScore", -1) DESC,
                 "updatedAt" DESC
      )
  `;
  console.log(`  removed ${deleted} duplicate(s)`);
});

// 2. Job.lastScoredAt
await step("Job.lastScoredAt", async () => {
  await prisma.$executeRaw`
    ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "lastScoredAt" TIMESTAMP(3)
  `;
});

// 3. UsageEvent table
await step("UsageEvent table", async () => {
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
});

// 4. Make Candidate.jobId nullable (candidates persist after job deletion)
await step("Candidate.jobId nullable", async () => {
  await prisma.$executeRaw`
    ALTER TABLE "Candidate" ALTER COLUMN "jobId" DROP NOT NULL
  `;
});

// 5. Add Candidate library fields
await step("Candidate library columns", async () => {
  await prisma.$executeRaw`
    ALTER TABLE "Candidate"
      ADD COLUMN IF NOT EXISTS "orgId"              TEXT,
      ADD COLUMN IF NOT EXISTS "archivedJobTitle"   TEXT,
      ADD COLUMN IF NOT EXISTS "archivedJobCompany" TEXT
  `;
});

// 6. Rewire Candidate→Job FK to ON DELETE SET NULL
//    Checks the current delete rule; only rewires if it isn't already SET NULL.
await step("Candidate→Job FK ON DELETE SET NULL", async () => {
  await prisma.$executeRaw`
    DO $$
    DECLARE
      fk_name       TEXT;
      fk_confdeltype CHAR;
    BEGIN
      SELECT conname, confdeltype INTO fk_name, fk_confdeltype
      FROM pg_constraint
      WHERE conrelid = '"Candidate"'::regclass
        AND contype   = 'f'
        AND confrelid = '"Job"'::regclass
      LIMIT 1;

      -- confdeltype: 'a'=NO ACTION, 'r'=RESTRICT, 'c'=CASCADE, 'n'=SET NULL
      IF fk_name IS NOT NULL AND fk_confdeltype != 'n' THEN
        EXECUTE format('ALTER TABLE "Candidate" DROP CONSTRAINT %I', fk_name);
        fk_name := NULL;
      END IF;

      IF fk_name IS NULL THEN
        ALTER TABLE "Candidate"
          ADD CONSTRAINT "Candidate_jobId_fkey"
          FOREIGN KEY ("jobId") REFERENCES "Job"("id")
          ON DELETE SET NULL ON UPDATE CASCADE;
      END IF;
    END $$
  `;
});

// 7. Backfill Candidate.orgId from their job (one-time, idempotent)
await step("backfill Candidate.orgId", async () => {
  const updated = await prisma.$executeRaw`
    UPDATE "Candidate" c
    SET "orgId" = j."orgId"
    FROM "Job" j
    WHERE c."jobId" = j."id"
      AND c."orgId" IS NULL
      AND j."orgId" IS NOT NULL
  `;
  console.log(`  backfilled ${updated} candidate(s)`);
});

// 8. CandidateFile table (CV / file attachments)
await step("CandidateFile table", async () => {
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
});

await prisma.$disconnect();

if (anyFailed) {
  console.error("[apply-schema] One or more steps failed — check logs above.");
  process.exit(1);
}
