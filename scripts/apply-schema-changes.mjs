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
//
//    SAFETY GUARD: this DELETE runs on EVERY boot/deploy. A regression in the
//    DISTINCT ON keep-set could silently wipe real candidates. So before the
//    destructive DELETE we dry-run the exact same NOT IN predicate as a SELECT
//    count, and ABORT (throw — no delete) if the would-delete count is
//    implausibly large (> 5% of the table OR > 500 rows). A legitimate dedupe
//    pass removes a handful of true duplicates; anything at that scale means
//    the keep-set is broken and a human must investigate before data is lost.
await step("deduplicate candidates", async () => {
  const [{ total, would_delete }] = await prisma.$queryRaw`
    SELECT
      (SELECT COUNT(*) FROM "Candidate")::int AS total,
      (
        SELECT COUNT(*)::int FROM "Candidate"
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
      ) AS would_delete
  `;
  const MAX_ROWS = 500;
  const MAX_FRACTION = 0.05;
  const fractionCap = Math.floor(total * MAX_FRACTION);
  if (would_delete > MAX_ROWS || would_delete > fractionCap) {
    throw new Error(
      `dedupe would delete ${would_delete} of ${total} candidate(s) — ` +
        `exceeds safety threshold (> ${MAX_ROWS} rows OR > ${MAX_FRACTION * 100}% = ${fractionCap} rows). ` +
        `Refusing to DELETE. The DISTINCT ON keep-set is likely broken — investigate before re-running.`
    );
  }

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
  console.log(`  removed ${deleted} duplicate(s) (of ${total} total, ${would_delete} predicted)`);
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

// 11b. Candidate.location trigram GIN index. The empty-query + location-filter
//      path in src/lib/talent-search/library.ts runs
//      `c."location" ILIKE '%'||$loc||'%'`, which can't use a btree index
//      because of the leading wildcard. A trigram GIN index makes that
//      substring match index-backed. pg_trgm is already created by the step
//      above, so no CREATE EXTENSION needed here. CREATE INDEX IF NOT EXISTS
//      is idempotent; building a GIN index is metadata-only-ish and safe on prod.
await step("Candidate.location trigram GIN index", async () => {
  await prisma.$executeRaw`
    CREATE INDEX IF NOT EXISTS "Candidate_location_trgm_idx"
    ON "Candidate" USING gin ("location" gin_trgm_ops)
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

// 21. Candidate.photoFileId column — pointer to the CandidateFile row holding
//     the recruiter-uploaded headshot. Nullable; the Avatar component falls
//     back to initials when this is NULL. Adding a nullable TEXT column on
//     Postgres ≥11 is metadata-only — sub-second on the 13.5k-row table.
await step("Candidate.photoFileId column", async () => {
  await prisma.$executeRaw`
    ALTER TABLE "Candidate" ADD COLUMN IF NOT EXISTS "photoFileId" TEXT
  `;
});

// 22. Drop Candidate.provisionalScore — write-only field never read by any
//     code path. Was a snippet-import snapshot for hypothetical delta-vs-
//     full-profile reporting that was never built. Idempotent: DROP COLUMN
//     IF EXISTS is a no-op when already dropped.
await step("drop Candidate.provisionalScore", async () => {
  await prisma.$executeRaw`
    ALTER TABLE "Candidate" DROP COLUMN IF EXISTS "provisionalScore"
  `;
});

// 23. Candidate.suitability — recruiter-set marker mirroring JobAdder's
//     Suitability field. "preferred" / "excluded" / null. Nullable column
//     add is metadata-only in Postgres ≥11. The library list + multi-source
//     search use it to gate recommendations.
await step("Candidate.suitability column", async () => {
  await prisma.$executeRaw`
    ALTER TABLE "Candidate" ADD COLUMN IF NOT EXISTS "suitability" TEXT
  `;
  await prisma.$executeRaw`
    CREATE INDEX IF NOT EXISTS "Candidate_suitability_idx" ON "Candidate"("suitability") WHERE "suitability" IS NOT NULL
  `;
});

// 24. SEEK provenance columns — Candidate.seekUrl + CandidateIdentity.seekUrl.
//     Nullable TEXT adds are metadata-only on Postgres ≥11. Set manually now
//     (paste-a-SEEK-URL affordance) and by the mini-PC scraper later; also a
//     Tier-1 identity key (lowest precedence after LinkedIn + JobAdder).
//
//     The CandidateIdentity @@unique([orgId, seekUrl]) constraint is created
//     HERE, with Prisma's exact generated name, NOT left to `prisma db push`.
//     Reason (regression fix): db push treats ADDING any unique constraint as
//     a potential-data-loss op and refuses without --accept-data-loss — which
//     start-production.mjs does NOT pass. Leaving it to db push made every
//     deploy fail its healthcheck and roll back (the seekUrl unique was the
//     sole blocker). Creating it here first means db push sees it already
//     exists and no-ops it. Same approach as the linkedinUrl/jobAdderUrl
//     uniques. Safe to build unconditionally: seekUrl starts all-NULL and
//     Postgres treats NULLs as distinct in unique indexes.
await step("Candidate.seekUrl + CandidateIdentity.seekUrl columns", async () => {
  await prisma.$executeRaw`
    ALTER TABLE "Candidate" ADD COLUMN IF NOT EXISTS "seekUrl" TEXT
  `;
  await prisma.$executeRaw`
    CREATE INDEX IF NOT EXISTS "Candidate_seekUrl_idx" ON "Candidate"("seekUrl") WHERE "seekUrl" IS NOT NULL
  `;
  await prisma.$executeRaw`
    ALTER TABLE "CandidateIdentity" ADD COLUMN IF NOT EXISTS "seekUrl" TEXT
  `;
  // Name MUST match Prisma's @@unique([orgId, seekUrl]) convention
  // (<Table>_<col1>_<col2>_key) so db push recognises it and skips the add.
  await prisma.$executeRaw`
    CREATE UNIQUE INDEX IF NOT EXISTS "CandidateIdentity_orgId_seekUrl_key" ON "CandidateIdentity"("orgId", "seekUrl")
  `;
});

// 25. CandidateTag table + its @@unique([orgId, label]) — created here (raw
//     SQL, Prisma's generated names) NOT by db push, which refuses to ADD a
//     unique constraint without --accept-data-loss (same class of failure as
//     the seekUrl regression). The other CRM/reminders tables (Client,
//     Submission, Placement, Reminder, CandidateTagAssignment) carry no NEW
//     unique constraints, so db push creates those additively on a fresh DB.
//     Prod is already fully migrated (via prisma migrate diff apply), so all
//     of this is a no-op there. Flag-gated FEATURES_CRM/REMINDERS_ENABLED.
await step("CandidateTag table + unique (CRM/reminders Stage)", async () => {
  await prisma.$executeRaw`
    CREATE TABLE IF NOT EXISTS "CandidateTag" (
      "id" TEXT NOT NULL,
      "orgId" TEXT NOT NULL,
      "label" TEXT NOT NULL,
      "color" TEXT NOT NULL DEFAULT '#6366f1',
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "CandidateTag_pkey" PRIMARY KEY ("id")
    )
  `;
  await prisma.$executeRaw`
    CREATE INDEX IF NOT EXISTS "CandidateTag_orgId_idx" ON "CandidateTag"("orgId")
  `;
  await prisma.$executeRaw`
    CREATE UNIQUE INDEX IF NOT EXISTS "CandidateTag_orgId_label_key" ON "CandidateTag"("orgId", "label")
  `;
});

// 27. Candidate.importBatchId (Phase E — group rows created in one bulk
//     import operation, e.g. a JobAdder library pull). Additive, nullable,
//     no constraint. Index by (orgId, importBatchId) so the library filter
//     query stays cheap as the column population grows.
await step("Candidate.importBatchId for batch-import grouping", async () => {
  await prisma.$executeRaw`
    ALTER TABLE "Candidate" ADD COLUMN IF NOT EXISTS "importBatchId" TEXT
  `;
  await prisma.$executeRaw`
    CREATE INDEX IF NOT EXISTS "Candidate_orgId_importBatchId_idx" ON "Candidate"("orgId", "importBatchId") WHERE "importBatchId" IS NOT NULL
  `;
});

// 28. Candidate.email (Phase E1 — primary contact email, surfaced on every
//     candidate view). Additive, nullable, no constraint. JobAdder import
//     and the scraper write this; no backfill needed for older rows.
await step("Candidate.email for primary contact email", async () => {
  await prisma.$executeRaw`
    ALTER TABLE "Candidate" ADD COLUMN IF NOT EXISTS "email" TEXT
  `;
});

// 31. CandidatePoolSync — pool-share opt-in audit + per-row sync state
//     (Phase J5). When the customer opts in (OPT_IN_CANDIDATE_POOL=true
//     in box.env, set after they sign the data-sharing T&Cs), a nightly
//     cron diffs Candidate rows updated since last sync and uploads the
//     non-PII canonical fields to the seller's central pool DB. This
//     table tracks the per-row "uploaded?" state so we don't re-upload
//     and so the customer can audit what's been shared.
//
//     The actual upload pipe lives in appliance/pool-sync/sync.mjs and
//     stays inert when the env flag is false. Schema is shipped now so
//     all boxes have the table ready when the customer flips the flag.
await step("CandidatePoolSync table (Phase J5 — opt-in pool share)", async () => {
  await prisma.$executeRaw`
    CREATE TABLE IF NOT EXISTS "CandidatePoolSync" (
      "id"            TEXT PRIMARY KEY,
      "candidateId"   TEXT NOT NULL UNIQUE,
      "uploadedAt"    TIMESTAMP(3),
      "uploadedHash"  TEXT,
      "lastError"     TEXT,
      "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;
  await prisma.$executeRaw`
    CREATE INDEX IF NOT EXISTS "CandidatePoolSync_uploadedAt_idx" ON "CandidatePoolSync"("uploadedAt")
  `;
});

// 30. ScrapeJob.priority — sort-key for worker poll order (Phase H).
//     Live recruiter searches enqueue with priority=100; background
//     flywheel discovery runs at the default 0. Old composite index
//     replaced with (status, priority, createdAt) for the priority-aware
//     poll ORDER BY. Idempotent; safe to re-run.
await step("ScrapeJob.priority for live-search queue jumping", async () => {
  await prisma.$executeRaw`
    ALTER TABLE "ScrapeJob" ADD COLUMN IF NOT EXISTS "priority" INTEGER NOT NULL DEFAULT 0
  `;
  await prisma.$executeRaw`
    CREATE INDEX IF NOT EXISTS "ScrapeJob_status_priority_createdAt_idx" ON "ScrapeJob"("status", "priority" DESC, "createdAt")
  `;
});

// 29. Candidate.searchTsv — generated weighted tsvector for boolean FTS
//     (Phase F). One GIN-indexed column built from name(A) / headline(B) /
//     location(C) / profileText(D), so ts_rank_cd ranks name hits higher
//     than body hits without needing per-field tsvectors. GENERATED column
//     means zero app-side maintenance — Postgres rebuilds it on every row
//     write. Prisma 5.22 has no first-class tsvector mapping; we declare
//     it as Unsupported("tsvector") in the schema so `prisma db push` leaves
//     it alone, and query through $queryRaw.
await step("Candidate.searchTsv generated tsvector + GIN (Phase F boolean search)", async () => {
  await prisma.$executeRaw`
    ALTER TABLE "Candidate" ADD COLUMN IF NOT EXISTS "searchTsv" tsvector
    GENERATED ALWAYS AS (
      setweight(to_tsvector('english', coalesce("name", '')), 'A') ||
      setweight(to_tsvector('english', coalesce("headline", '') || ' ' || coalesce("archivedJobTitle", '')), 'B') ||
      setweight(to_tsvector('english', coalesce("location", '') || ' ' || coalesce("archivedJobCompany", '')), 'C') ||
      setweight(to_tsvector('english', coalesce("profileText", '')), 'D')
    ) STORED
  `;
  await prisma.$executeRaw`
    CREATE INDEX IF NOT EXISTS "Candidate_searchTsv_gin_idx" ON "Candidate" USING gin ("searchTsv")
  `;
});

// 26. ScrapeJob.kind + searchQuery (Phase B — scraper-side LinkedIn search
//     discovery). Same additive raw-SQL approach as the others: profileUrl
//     becomes nullable (was NOT NULL — search jobs have no URL to scrape,
//     only a query to run), `kind` defaults to "profile" so existing rows
//     match today's behaviour, `searchQuery` is nullable and only set for
//     search jobs. All idempotent — `IF NOT EXISTS` on column adds, and the
//     DROP NOT NULL is a no-op when the column is already nullable. Safe to
//     re-run on every startup.
await step("ScrapeJob.kind + searchQuery (Phase B search jobs)", async () => {
  await prisma.$executeRaw`
    ALTER TABLE "ScrapeJob" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'profile'
  `;
  await prisma.$executeRaw`
    ALTER TABLE "ScrapeJob" ADD COLUMN IF NOT EXISTS "searchQuery" TEXT
  `;
  await prisma.$executeRaw`
    ALTER TABLE "ScrapeJob" ALTER COLUMN "profileUrl" DROP NOT NULL
  `;
});

// 41. ScrapeJob.scorePayload (Llama scoring offload). Nullable TEXT holding the
//     JSON {system,prompt,temperature,maxTokens,model?,finalizeCtx} the box
//     needs to run a kind="score" job's prompt against local Ollama and POST
//     back the raw text. Nullable add is metadata-only on Postgres ≥11. Safe
//     to re-run; only populated for kind="score" rows. Deploys 100% inert
//     until LLAMA_SCORE_OFFLOAD=1 is set AND the box is updated to poll for
//     score jobs.
await step("ScrapeJob.scorePayload (Llama scoring offload)", async () => {
  await prisma.$executeRaw`
    ALTER TABLE "ScrapeJob" ADD COLUMN IF NOT EXISTS "scorePayload" TEXT
  `;
});

// 36. SearchRun — durable org-scoped background search (Phase K).
await step("SearchRun table", async () => {
  await prisma.$executeRaw`
    CREATE TABLE IF NOT EXISTS "SearchRun" (
      "id"             TEXT NOT NULL,
      "orgId"          TEXT,
      "requestedBy"    TEXT,
      "rawQuery"       TEXT NOT NULL,
      "parsedQuery"    TEXT NOT NULL,
      "location"       TEXT,
      "sources"        TEXT NOT NULL,
      "status"         TEXT NOT NULL DEFAULT 'queued',
      "libraryStatus"  TEXT NOT NULL DEFAULT 'skipped',
      "linkedinStatus" TEXT NOT NULL DEFAULT 'skipped',
      "seekStatus"     TEXT NOT NULL DEFAULT 'skipped',
      "libraryCount"   INTEGER NOT NULL DEFAULT 0,
      "linkedinCount"  INTEGER NOT NULL DEFAULT 0,
      "seekCount"      INTEGER NOT NULL DEFAULT 0,
      "dedupedCount"   INTEGER NOT NULL DEFAULT 0,
      "totalCount"     INTEGER NOT NULL DEFAULT 0,
      "error"          TEXT,
      "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "completedAt"    TIMESTAMP(3),
      "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "SearchRun_pkey" PRIMARY KEY ("id")
    )
  `;
  await prisma.$executeRaw`CREATE INDEX IF NOT EXISTS "SearchRun_orgId_createdAt_idx" ON "SearchRun"("orgId", "createdAt")`;
  await prisma.$executeRaw`CREATE INDEX IF NOT EXISTS "SearchRun_orgId_status_idx" ON "SearchRun"("orgId", "status")`;
  await prisma.$executeRaw`CREATE INDEX IF NOT EXISTS "SearchRun_status_updatedAt_idx" ON "SearchRun"("status", "updatedAt")`;
});

// 37. SearchRunResult — per-result rows. The @@unique index is created here
//     with Prisma's exact generated name so `prisma db push` finds it in
//     place and skips its data-loss pre-check.
await step("SearchRunResult table + unique + FK", async () => {
  await prisma.$executeRaw`
    CREATE TABLE IF NOT EXISTS "SearchRunResult" (
      "id"                  TEXT NOT NULL,
      "searchRunId"         TEXT NOT NULL,
      "mergeKey"            TEXT NOT NULL,
      "sources"             TEXT NOT NULL DEFAULT '[]',
      "candidateId"         TEXT,
      "candidateIdentityId" TEXT,
      "profileUrl"          TEXT,
      "name"                TEXT,
      "headline"            TEXT,
      "location"            TEXT,
      "snippet"             TEXT,
      "matchScore"          INTEGER,
      "relevance"           DOUBLE PRECISION,
      "rank"                INTEGER,
      "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "SearchRunResult_pkey" PRIMARY KEY ("id")
    )
  `;
  await prisma.$executeRaw`
    CREATE UNIQUE INDEX IF NOT EXISTS "SearchRunResult_searchRunId_mergeKey_key"
    ON "SearchRunResult"("searchRunId", "mergeKey")
  `;
  await prisma.$executeRaw`CREATE INDEX IF NOT EXISTS "SearchRunResult_searchRunId_idx" ON "SearchRunResult"("searchRunId")`;
  await prisma.$executeRaw`CREATE INDEX IF NOT EXISTS "SearchRunResult_candidateId_idx" ON "SearchRunResult"("candidateId")`;
  await prisma.$executeRaw`CREATE INDEX IF NOT EXISTS "SearchRunResult_searchRunId_candidateId_idx" ON "SearchRunResult"("searchRunId", "candidateId")`;
  await prisma.$executeRaw`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SearchRunResult_searchRunId_fkey') THEN
        ALTER TABLE "SearchRunResult"
          ADD CONSTRAINT "SearchRunResult_searchRunId_fkey"
          FOREIGN KEY ("searchRunId") REFERENCES "SearchRun"("id")
          ON DELETE CASCADE ON UPDATE CASCADE;
      END IF;
    END $$
  `;
});

// 38. ScrapeJob.searchRunId — nullable add + index + FK (NOT VALID, then validate).
await step("ScrapeJob.searchRunId column + index + FK", async () => {
  await prisma.$executeRaw`ALTER TABLE "ScrapeJob" ADD COLUMN IF NOT EXISTS "searchRunId" TEXT`;
  await prisma.$executeRaw`CREATE INDEX IF NOT EXISTS "ScrapeJob_searchRunId_status_idx" ON "ScrapeJob"("searchRunId", "status")`;
  await prisma.$executeRaw`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ScrapeJob_searchRunId_fkey') THEN
        ALTER TABLE "ScrapeJob"
          ADD CONSTRAINT "ScrapeJob_searchRunId_fkey"
          FOREIGN KEY ("searchRunId") REFERENCES "SearchRun"("id")
          ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
      END IF;
    END $$
  `;
});

await step("validate ScrapeJob.searchRunId FK", async () => {
  await prisma.$executeRaw`
    DO $$ DECLARE is_valid BOOLEAN;
    BEGIN
      SELECT convalidated INTO is_valid FROM pg_constraint WHERE conname = 'ScrapeJob_searchRunId_fkey';
      IF is_valid IS FALSE THEN
        ALTER TABLE "ScrapeJob" VALIDATE CONSTRAINT "ScrapeJob_searchRunId_fkey";
      END IF;
    END $$
  `;
});

// 39. CandidateIdentity.currentInsightId → ProfileInsight FK (ON DELETE SET NULL).
//     The column has existed (bare TEXT) since the CandidateIdentity table was
//     created — a denormalised "latest valid insight" pointer the read path
//     follows — but with NO referential integrity. Deleting a ProfileInsight
//     left the pointer dangling at a row that no longer exists. Add the FK so a
//     deleted insight nulls the pointer instead of stranding it. Pre-null any
//     already-dangling values first (insights deleted before the FK existed),
//     else VALIDATE would fail. FK added NOT VALID then validated separately
//     (same low-lock pattern as the candidateIdentityId / searchRunId FKs).
//     Name matches Prisma's <Table>_<col>_fkey so `prisma db push` finds it
//     in place and no-ops (the relation is modelled in schema.prisma).
await step("CandidateIdentity.currentInsightId FK → ProfileInsight (pre-null + SET NULL)", async () => {
  // (a) Clear dangling pointers so the constraint can validate.
  await prisma.$executeRaw`
    UPDATE "CandidateIdentity" ci
    SET "currentInsightId" = NULL
    WHERE ci."currentInsightId" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "ProfileInsight" pi WHERE pi."id" = ci."currentInsightId")
  `;
  // (b) Add the FK if absent.
  await prisma.$executeRaw`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CandidateIdentity_currentInsightId_fkey') THEN
        ALTER TABLE "CandidateIdentity"
          ADD CONSTRAINT "CandidateIdentity_currentInsightId_fkey"
          FOREIGN KEY ("currentInsightId") REFERENCES "ProfileInsight"("id")
          ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
      END IF;
    END $$
  `;
});

await step("validate CandidateIdentity.currentInsightId FK", async () => {
  await prisma.$executeRaw`
    DO $$ DECLARE is_valid BOOLEAN;
    BEGIN
      SELECT convalidated INTO is_valid FROM pg_constraint WHERE conname = 'CandidateIdentity_currentInsightId_fkey';
      IF is_valid IS FALSE THEN
        ALTER TABLE "CandidateIdentity" VALIDATE CONSTRAINT "CandidateIdentity_currentInsightId_fkey";
      END IF;
    END $$
  `;
});

// 40. CandidateFile.storageKey — pointer to the S3/R2 object holding the
//     encrypted blob envelope. NULL = blob is inline in `data` (legacy /
//     no-bucket path). Set by the upload route when BLOB_S3_* is configured,
//     and by scripts/migrate-files-to-r2.mjs when moving existing rows out of
//     Postgres. Nullable TEXT add is metadata-only on Postgres ≥11. Inert
//     until a bucket is configured — see src/lib/blob-store.ts.
await step("CandidateFile.storageKey column (blob-store offload)", async () => {
  await prisma.$executeRaw`
    ALTER TABLE "CandidateFile" ADD COLUMN IF NOT EXISTS "storageKey" TEXT
  `;
});

// ScrapeJob.searchLocation — lets a kind="search" job carry its region filter
// when it has no SearchRun to enrich from (the job-context "Search talent"
// modal). Without it, SEEK ran nation-wide and harvested its 100-card cap
// instead of the location-scoped matches. Nullable TEXT add = metadata-only.
await step("ScrapeJob.searchLocation column (job-context search region filter)", async () => {
  await prisma.$executeRaw`
    ALTER TABLE "ScrapeJob" ADD COLUMN IF NOT EXISTS "searchLocation" TEXT
  `;
});

// ScraperHeartbeat — explicit worker-liveness row (Phase I2). Additive table,
// deployed BEFORE any code reads/writes it so a rollback can't hit a missing
// table. workerId is the PK; no orgId (single-org box).
await step("ScraperHeartbeat table (worker liveness)", async () => {
  await prisma.$executeRaw`
    CREATE TABLE IF NOT EXISTS "ScraperHeartbeat" (
      "workerId"   TEXT PRIMARY KEY,
      "lastPollAt" TIMESTAMP(3),
      "jobsOk"     INTEGER NOT NULL DEFAULT 0,
      "jobsFailed" INTEGER NOT NULL DEFAULT 0,
      "pollErrors" INTEGER NOT NULL DEFAULT 0,
      "detail"     TEXT,
      "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;
});

await prisma.$disconnect();

if (anyFailed) {
  console.error("[apply-schema] One or more steps failed — check logs above.");
  process.exit(1);
}
