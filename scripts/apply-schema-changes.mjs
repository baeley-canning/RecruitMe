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

// 2. Job.lastScoredAt + lastParsedAt
await step("Job.lastScoredAt + lastParsedAt", async () => {
  await prisma.$executeRaw`
    ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "lastScoredAt" TIMESTAMP(3)
  `;
  await prisma.$executeRaw`
    ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "lastParsedAt" TIMESTAMP(3)
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

// 9. Candidate.linkedinUrl index for cross-job talent pool lookups
await step("Candidate.linkedinUrl index", async () => {
  await prisma.$executeRaw`
    CREATE INDEX IF NOT EXISTS "Candidate_linkedinUrl_idx" ON "Candidate"("linkedinUrl")
  `;
});

// 10. SearchSession self-evaluation columns
await step("SearchSession evaluation columns", async () => {
  await prisma.$executeRaw`
    ALTER TABLE "SearchSession"
      ADD COLUMN IF NOT EXISTS "avgScore"           DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS "candidatesRejected" INTEGER,
      ADD COLUMN IF NOT EXISTS "totalExamined"      INTEGER,
      ADD COLUMN IF NOT EXISTS "evaluation"         TEXT
  `;
});

// 10. JobParseHistory table
await step("JobParseHistory table", async () => {
  await prisma.$executeRaw`
    CREATE TABLE IF NOT EXISTS "JobParseHistory" (
      "id"            TEXT         NOT NULL,
      "jobId"         TEXT         NOT NULL,
      "parsedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "anchorTerms"   TEXT         NOT NULL,
      "mustHaveCount" INTEGER      NOT NULL,
      "changes"       TEXT         NOT NULL,
      "evaluation"    TEXT         NOT NULL,
      CONSTRAINT "JobParseHistory_pkey" PRIMARY KEY ("id")
    )
  `;
  await prisma.$executeRaw`
    CREATE INDEX IF NOT EXISTS "JobParseHistory_jobId_idx"
    ON "JobParseHistory"("jobId")
  `;
  await prisma.$executeRaw`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'JobParseHistory_jobId_fkey'
      ) THEN
        ALTER TABLE "JobParseHistory"
          ADD CONSTRAINT "JobParseHistory_jobId_fkey"
          FOREIGN KEY ("jobId") REFERENCES "Job"("id")
          ON DELETE CASCADE ON UPDATE CASCADE;
      END IF;
    END $$
  `;
});

// 11. pg_trgm extension + GIN index on Candidate.profileText.
//     Lets the talent-pool route push must-have keyword pre-filtering
//     down to SQL (was loading 12k profiles into JS to substring-match).
//     CREATE EXTENSION needs superuser on stock Postgres; Railway grants
//     it. CREATE INDEX IF NOT EXISTS is idempotent.
await step("pg_trgm + Candidate.profileText GIN index", async () => {
  await prisma.$executeRaw`CREATE EXTENSION IF NOT EXISTS pg_trgm`;
  await prisma.$executeRaw`
    CREATE INDEX IF NOT EXISTS "Candidate_profileText_trgm_idx"
    ON "Candidate" USING gin ("profileText" gin_trgm_ops)
  `;
});

// 12. CandidateFile.dataHash column + index (paired with the duplicate-
//     detection fix in /api/candidates/[id]/files/route.ts and the
//     scripts/backfill-cv-hashes.mjs backfill).
await step("CandidateFile.dataHash column + index", async () => {
  await prisma.$executeRaw`
    ALTER TABLE "CandidateFile" ADD COLUMN IF NOT EXISTS "dataHash" TEXT
  `;
  await prisma.$executeRaw`
    CREATE INDEX IF NOT EXISTS "CandidateFile_candidateId_dataHash_idx"
    ON "CandidateFile"("candidateId", "dataHash")
  `;
});

// 13. Promote (candidateId, dataHash) to a UNIQUE index so race-condition
//     double-uploads collide instead of silently doubling up.
//     Two-step pattern (same shape as the candidate dedupe at step 1):
//     (a) collapse existing duplicate hashes per candidate, keeping the
//         newest row, then (b) create the unique index. CREATE UNIQUE INDEX
//         IF NOT EXISTS is idempotent; ALTER TABLE ADD CONSTRAINT is not.
//     The POST route catches the resulting P2002 from concurrent writes and
//     returns the existing row.
await step("CandidateFile (candidateId, dataHash) unique constraint", async () => {
  const deleted = await prisma.$executeRaw`
    DELETE FROM "CandidateFile"
    WHERE "dataHash" IS NOT NULL
      AND id NOT IN (
        SELECT DISTINCT ON ("candidateId", "dataHash") id
        FROM "CandidateFile"
        WHERE "dataHash" IS NOT NULL
        ORDER BY "candidateId", "dataHash", "createdAt" DESC
      )
  `;
  console.log(`  removed ${deleted} duplicate CandidateFile row(s)`);
  await prisma.$executeRaw`
    CREATE UNIQUE INDEX IF NOT EXISTS "CandidateFile_candidateId_dataHash_key"
    ON "CandidateFile"("candidateId", "dataHash")
  `;
});

// 14. CandidateIdentity table — per-(org, real-person) identity row.
//     One row per human as recognised by recruiter-truth keys; multiple
//     Candidate rows (per-job) point at the same identity. Per-org isolation
//     is enforced via @@unique([orgId, linkedinUrl]) + @@unique([orgId, jobAdderUrl]).
//
//     Adding the table is metadata-only at sub-second cost on 13.5k rows.
//     The FK from Candidate.candidateIdentityId comes in step 17 as
//     NOT VALID to skip the revalidation lock; step 18 validates outside the
//     hot path.
await step("CandidateIdentity table", async () => {
  await prisma.$executeRaw`
    CREATE TABLE IF NOT EXISTS "CandidateIdentity" (
      "id"                   TEXT         NOT NULL,
      "orgId"                TEXT         NOT NULL,
      "canonicalName"        TEXT         NOT NULL,
      "primaryEmail"         TEXT,
      "primaryPhone"         TEXT,
      "linkedinUrl"          TEXT,
      "jobAdderUrl"          TEXT,
      "mergedIntoIdentityId" TEXT,
      "currentInsightId"     TEXT,
      "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "CandidateIdentity_pkey" PRIMARY KEY ("id")
    )
  `;
  // Unique indexes are created in step 20 (after deduplication) with the
  // exact names Prisma expects, so db push finds them in place and skips its
  // GROUP-BY-based data-loss pre-check. Do not create or drop them here.
  await prisma.$executeRaw`
    CREATE INDEX IF NOT EXISTS "CandidateIdentity_orgId_idx"
    ON "CandidateIdentity"("orgId")
  `;
  await prisma.$executeRaw`
    CREATE INDEX IF NOT EXISTS "CandidateIdentity_orgId_primaryEmail_idx"
    ON "CandidateIdentity"("orgId", "primaryEmail")
  `;
  await prisma.$executeRaw`
    CREATE INDEX IF NOT EXISTS "CandidateIdentity_mergedIntoIdentityId_idx"
    ON "CandidateIdentity"("mergedIntoIdentityId")
  `;
  // FK to Org. ON DELETE CASCADE because identity is per-org; if the org
  // itself is deleted, everything beneath it dies.
  await prisma.$executeRaw`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'CandidateIdentity_orgId_fkey'
      ) THEN
        ALTER TABLE "CandidateIdentity"
          ADD CONSTRAINT "CandidateIdentity_orgId_fkey"
          FOREIGN KEY ("orgId") REFERENCES "Org"("id")
          ON DELETE CASCADE ON UPDATE CASCADE;
      END IF;
    END $$
  `;
});

// 15. CandidateIdentityAlias — history of identity-resolution keys. Lets an
//     identity survive a LinkedIn URL rename / email change without splitting.
await step("CandidateIdentityAlias table", async () => {
  await prisma.$executeRaw`
    CREATE TABLE IF NOT EXISTS "CandidateIdentityAlias" (
      "id"         TEXT         NOT NULL,
      "identityId" TEXT         NOT NULL,
      "kind"       TEXT         NOT NULL,
      "value"      TEXT         NOT NULL,
      "source"     TEXT         NOT NULL,
      "validFrom"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "validTo"    TIMESTAMP(3),
      CONSTRAINT "CandidateIdentityAlias_pkey" PRIMARY KEY ("id")
    )
  `;
  await prisma.$executeRaw`
    CREATE INDEX IF NOT EXISTS "CandidateIdentityAlias_identityId_idx"
    ON "CandidateIdentityAlias"("identityId")
  `;
  await prisma.$executeRaw`
    CREATE INDEX IF NOT EXISTS "CandidateIdentityAlias_kind_value_idx"
    ON "CandidateIdentityAlias"("kind", "value")
  `;
  await prisma.$executeRaw`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'CandidateIdentityAlias_identityId_fkey'
      ) THEN
        ALTER TABLE "CandidateIdentityAlias"
          ADD CONSTRAINT "CandidateIdentityAlias_identityId_fkey"
          FOREIGN KEY ("identityId") REFERENCES "CandidateIdentity"("id")
          ON DELETE CASCADE ON UPDATE CASCADE;
      END IF;
    END $$
  `;
});

// 16. CandidateIdentityMerge — merge audit + tombstone blocker.
//     Tombstone rows prevent the next clustering pass from re-collapsing a
//     pair that a recruiter has manually split.
await step("CandidateIdentityMerge table", async () => {
  await prisma.$executeRaw`
    CREATE TABLE IF NOT EXISTS "CandidateIdentityMerge" (
      "id"                 TEXT         NOT NULL,
      "orgId"              TEXT         NOT NULL,
      "sourceIdentityId"   TEXT         NOT NULL,
      "survivorIdentityId" TEXT         NOT NULL,
      "mergedByUserId"     TEXT,
      "mergedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "reason"             TEXT         NOT NULL,
      "isTombstone"        BOOLEAN      NOT NULL DEFAULT FALSE,
      CONSTRAINT "CandidateIdentityMerge_pkey" PRIMARY KEY ("id")
    )
  `;
  await prisma.$executeRaw`
    CREATE INDEX IF NOT EXISTS "CandidateIdentityMerge_orgId_survivor_idx"
    ON "CandidateIdentityMerge"("orgId", "survivorIdentityId")
  `;
  await prisma.$executeRaw`
    CREATE INDEX IF NOT EXISTS "CandidateIdentityMerge_orgId_source_idx"
    ON "CandidateIdentityMerge"("orgId", "sourceIdentityId")
  `;
  await prisma.$executeRaw`
    CREATE UNIQUE INDEX IF NOT EXISTS "CandidateIdentityMerge_unique_tombstone_key"
    ON "CandidateIdentityMerge"("orgId", "sourceIdentityId", "survivorIdentityId", "isTombstone")
  `;
});

// 17. ProfileInsight — versioned AI-extracted facts about an identity.
//     Per-(orgId, identityId, hash, version). The unique constraint makes
//     re-extraction idempotent: same inputs → upsert to same row, no-op.
//
//     PR 2 wires the extractor; PR 1 just ships the table so the FK from
//     CandidateIdentity.currentInsightId has a target.
await step("ProfileInsight table", async () => {
  await prisma.$executeRaw`
    CREATE TABLE IF NOT EXISTS "ProfileInsight" (
      "id"                    TEXT         NOT NULL,
      "orgId"                 TEXT         NOT NULL,
      "identityId"            TEXT         NOT NULL,
      "factsJson"             TEXT         NOT NULL,
      "extractionVersion"     INTEGER      NOT NULL,
      "promptVersion"         TEXT         NOT NULL,
      "extractedBy"           TEXT         NOT NULL,
      "modelId"               TEXT         NOT NULL,
      "sourceProfileTextHash" TEXT         NOT NULL,
      "sourceCandidateId"     TEXT,
      "extractedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "supersededAt"          TIMESTAMP(3),
      CONSTRAINT "ProfileInsight_pkey" PRIMARY KEY ("id")
    )
  `;
  await prisma.$executeRaw`
    CREATE UNIQUE INDEX IF NOT EXISTS "ProfileInsight_unique_extraction_key"
    ON "ProfileInsight"("orgId", "identityId", "sourceProfileTextHash", "extractionVersion")
  `;
  await prisma.$executeRaw`
    CREATE INDEX IF NOT EXISTS "ProfileInsight_orgId_identity_superseded_idx"
    ON "ProfileInsight"("orgId", "identityId", "supersededAt")
  `;
  await prisma.$executeRaw`
    CREATE INDEX IF NOT EXISTS "ProfileInsight_orgId_extractionVersion_idx"
    ON "ProfileInsight"("orgId", "extractionVersion")
  `;
  await prisma.$executeRaw`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ProfileInsight_identityId_fkey'
      ) THEN
        ALTER TABLE "ProfileInsight"
          ADD CONSTRAINT "ProfileInsight_identityId_fkey"
          FOREIGN KEY ("identityId") REFERENCES "CandidateIdentity"("id")
          ON DELETE CASCADE ON UPDATE CASCADE;
      END IF;
    END $$
  `;
});

// 18. Candidate.candidateIdentityId column + index + FK.
//     Adding a nullable column on a 13.5k-row table is metadata-only in
//     Postgres ≥11. FK added NOT VALID so existing rows don't trigger a
//     revalidation lock. Step 19 validates the constraint outside the hot path.
await step("Candidate.candidateIdentityId column + index", async () => {
  await prisma.$executeRaw`
    ALTER TABLE "Candidate"
      ADD COLUMN IF NOT EXISTS "candidateIdentityId" TEXT
  `;
  await prisma.$executeRaw`
    CREATE INDEX IF NOT EXISTS "Candidate_candidateIdentityId_idx"
    ON "Candidate"("candidateIdentityId")
  `;
  await prisma.$executeRaw`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'Candidate_candidateIdentityId_fkey'
      ) THEN
        ALTER TABLE "Candidate"
          ADD CONSTRAINT "Candidate_candidateIdentityId_fkey"
          FOREIGN KEY ("candidateIdentityId") REFERENCES "CandidateIdentity"("id")
          ON DELETE SET NULL ON UPDATE CASCADE
          NOT VALID;
      END IF;
    END $$
  `;
});

// 19. Validate the Candidate.candidateIdentityId FK added NOT VALID in step 18.
//     Runs separately so the long-locking validation doesn't block step 18's
//     creation. VALIDATE CONSTRAINT takes a SHARE UPDATE EXCLUSIVE lock —
//     blocks DDL but not normal reads/writes. Idempotent: re-validating an
//     already-valid constraint is a no-op.
await step("validate Candidate.candidateIdentityId FK", async () => {
  await prisma.$executeRaw`
    DO $$
    DECLARE
      is_valid BOOLEAN;
    BEGIN
      SELECT convalidated INTO is_valid
      FROM pg_constraint
      WHERE conname = 'Candidate_candidateIdentityId_fkey';

      IF is_valid IS FALSE THEN
        ALTER TABLE "Candidate"
          VALIDATE CONSTRAINT "Candidate_candidateIdentityId_fkey";
      END IF;
    END $$
  `;
});

// 20. Deduplicate CandidateIdentity and create its unique indexes directly.
//
//     Why not let prisma db push create them?
//     Prisma's data-loss pre-check uses GROUP BY on the nullable columns, which
//     treats NULL = NULL. So multiple rows with (orgId=X, linkedinUrl=NULL) look
//     like "duplicates" to Prisma even though PostgreSQL unique indexes treat
//     NULLs as distinct and would happily accept them. The pre-check fires,
//     prisma db push refuses, and the container dies.
//
//     Fix: (a) deduplicate any real duplicates where the value IS NOT NULL, then
//     (b) CREATE UNIQUE INDEX IF NOT EXISTS with Prisma's expected names. When
//     prisma db push introspects the DB and finds the indexes already present it
//     skips them entirely — no pre-check, no false alarm. Idempotent on every
//     subsequent startup.
await step("deduplicate CandidateIdentity (linkedinUrl + jobAdderUrl)", async () => {
  // ── linkedinUrl pass ──────────────────────────────────────────────────────
  const repointed1 = await prisma.$executeRaw`
    WITH ranked AS (
      SELECT id,
        FIRST_VALUE(id) OVER (
          PARTITION BY "orgId", "linkedinUrl"
          ORDER BY "updatedAt" DESC, id
        ) AS survivor_id
      FROM "CandidateIdentity"
      WHERE "linkedinUrl" IS NOT NULL
    )
    UPDATE "Candidate"
    SET "candidateIdentityId" = r.survivor_id
    FROM ranked r
    WHERE "Candidate"."candidateIdentityId" = r.id
      AND r.id != r.survivor_id
  `;
  const deleted1 = await prisma.$executeRaw`
    DELETE FROM "CandidateIdentity"
    WHERE id IN (
      SELECT id FROM (
        SELECT id,
          ROW_NUMBER() OVER (
            PARTITION BY "orgId", "linkedinUrl"
            ORDER BY "updatedAt" DESC, id
          ) AS rn
        FROM "CandidateIdentity"
        WHERE "linkedinUrl" IS NOT NULL
      ) t
      WHERE rn > 1
    )
  `;

  // ── jobAdderUrl pass ──────────────────────────────────────────────────────
  const repointed2 = await prisma.$executeRaw`
    WITH ranked AS (
      SELECT id,
        FIRST_VALUE(id) OVER (
          PARTITION BY "orgId", "jobAdderUrl"
          ORDER BY "updatedAt" DESC, id
        ) AS survivor_id
      FROM "CandidateIdentity"
      WHERE "jobAdderUrl" IS NOT NULL
    )
    UPDATE "Candidate"
    SET "candidateIdentityId" = r.survivor_id
    FROM ranked r
    WHERE "Candidate"."candidateIdentityId" = r.id
      AND r.id != r.survivor_id
  `;
  const deleted2 = await prisma.$executeRaw`
    DELETE FROM "CandidateIdentity"
    WHERE id IN (
      SELECT id FROM (
        SELECT id,
          ROW_NUMBER() OVER (
            PARTITION BY "orgId", "jobAdderUrl"
            ORDER BY "updatedAt" DESC, id
          ) AS rn
        FROM "CandidateIdentity"
        WHERE "jobAdderUrl" IS NOT NULL
      ) t
      WHERE rn > 1
    )
  `;
  console.log(`  re-pointed ${repointed1 + repointed2} candidate(s), removed ${deleted1 + deleted2} duplicate identity row(s)`);

  // Create the unique indexes with Prisma's expected names so db push finds
  // them already in place and skips its GROUP-BY-based data-loss pre-check.
  // PostgreSQL treats NULLs as distinct in unique indexes, so multiple rows
  // with (orgId=X, linkedinUrl=NULL) are fine — but Prisma's check isn't.
  await prisma.$executeRaw`
    CREATE UNIQUE INDEX IF NOT EXISTS "CandidateIdentity_orgId_linkedinUrl_key"
    ON "CandidateIdentity"("orgId", "linkedinUrl")
  `;
  await prisma.$executeRaw`
    CREATE UNIQUE INDEX IF NOT EXISTS "CandidateIdentity_orgId_jobAdderUrl_key"
    ON "CandidateIdentity"("orgId", "jobAdderUrl")
  `;
});

// ── Step 21: Create Client table ─────────────────────────────────────────
await step(21, "create Client table", async () => {
  await prisma.$executeRaw`
    CREATE TABLE IF NOT EXISTS "Client" (
      "id"             TEXT NOT NULL,
      "orgId"          TEXT NOT NULL,
      "name"           TEXT NOT NULL,
      "industry"       TEXT,
      "website"        TEXT,
      "primaryContact" TEXT,
      "email"          TEXT,
      "phone"          TEXT,
      "notes"          TEXT,
      "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "Client_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "Client_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE RESTRICT ON UPDATE CASCADE
    )
  `;
  await prisma.$executeRaw`
    CREATE INDEX IF NOT EXISTS "Client_orgId_idx" ON "Client"("orgId")
  `;
});

// ── Step 22: Add clientId FK to Job ──────────────────────────────────────
await step(22, "add clientId to Job", async () => {
  await prisma.$executeRaw`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'Job' AND column_name = 'clientId'
      ) THEN
        ALTER TABLE "Job" ADD COLUMN "clientId" TEXT;
        ALTER TABLE "Job" ADD CONSTRAINT "Job_clientId_fkey"
          FOREIGN KEY ("clientId") REFERENCES "Client"("id")
          ON DELETE SET NULL ON UPDATE CASCADE;
      END IF;
    END $$
  `;
  await prisma.$executeRaw`
    CREATE INDEX IF NOT EXISTS "Job_clientId_idx" ON "Job"("clientId")
  `;
});

await prisma.$disconnect();

if (anyFailed) {
  console.error("[apply-schema] One or more steps failed — check logs above.");
  process.exit(1);
}
