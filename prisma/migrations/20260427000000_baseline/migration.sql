-- Baseline migration: idempotent full-schema creation for PostgreSQL.
-- Uses IF NOT EXISTS throughout so this is safe to run against a DB that was
-- previously managed by `prisma db push` (all tables already exist).

CREATE TABLE IF NOT EXISTS "Org" (
    "id"        TEXT NOT NULL,
    "name"      TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Org_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "User" (
    "id"        TEXT NOT NULL,
    "username"  TEXT NOT NULL,
    "password"  TEXT NOT NULL,
    "role"      TEXT NOT NULL DEFAULT 'user',
    "orgId"     TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Setting" (
    "key"       TEXT NOT NULL,
    "value"     TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

CREATE TABLE IF NOT EXISTS "Job" (
    "id"         TEXT    NOT NULL,
    "title"      TEXT    NOT NULL,
    "company"    TEXT,
    "location"   TEXT,
    "rawJd"      TEXT    NOT NULL,
    "parsedRole" TEXT,
    "salaryMin"  INTEGER,
    "salaryMax"  INTEGER,
    "isRemote"   BOOLEAN NOT NULL DEFAULT false,
    "status"     TEXT    NOT NULL DEFAULT 'active',
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL,
    "orgId"      TEXT,
    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Candidate" (
    "id"               TEXT NOT NULL,
    "jobId"            TEXT NOT NULL,
    "name"             TEXT NOT NULL,
    "headline"         TEXT,
    "location"         TEXT,
    "linkedinUrl"      TEXT,
    "profileText"      TEXT,
    "profileTextHash"  TEXT,
    "matchScore"       INTEGER,
    "matchReason"      TEXT,
    "acceptanceScore"  INTEGER,
    "acceptanceReason" TEXT,
    "scoreBreakdown"   TEXT,
    "notes"            TEXT,
    "screeningData"    TEXT,
    "interviewNotes"   TEXT,
    "status"           TEXT NOT NULL DEFAULT 'new',
    "statusHistory"    TEXT,
    "contactedAt"      TIMESTAMP(3),
    "source"           TEXT NOT NULL DEFAULT 'manual',
    "profileCapturedAt" TIMESTAMP(3),
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Candidate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CandidateFile" (
    "id"          TEXT    NOT NULL,
    "candidateId" TEXT    NOT NULL,
    "type"        TEXT    NOT NULL,
    "filename"    TEXT    NOT NULL,
    "mimeType"    TEXT    NOT NULL,
    "data"        TEXT    NOT NULL,
    "size"        INTEGER NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CandidateFile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "FetchSession" (
    "id"            TEXT NOT NULL,
    "jobId"         TEXT NOT NULL,
    "candidateId"   TEXT NOT NULL,
    "linkedinUrl"   TEXT NOT NULL,
    "candidateName" TEXT NOT NULL DEFAULT '',
    "status"        TEXT NOT NULL DEFAULT 'pending',
    "message"       TEXT NOT NULL DEFAULT '',
    "error"         TEXT,
    "completedAt"   TIMESTAMP(3),
    "orgId"         TEXT,
    "userId"        TEXT,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FetchSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SearchSession" (
    "id"          TEXT    NOT NULL,
    "jobId"       TEXT    NOT NULL,
    "status"      TEXT    NOT NULL DEFAULT 'running',
    "queries"     TEXT    NOT NULL,
    "location"    TEXT    NOT NULL,
    "collected"   INTEGER NOT NULL DEFAULT 0,
    "target"      INTEGER NOT NULL,
    "page"        INTEGER NOT NULL DEFAULT 0,
    "importedIds" TEXT    NOT NULL DEFAULT '[]',
    "message"     TEXT,
    "orgId"       TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SearchSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ReferenceCheck" (
    "id"             TEXT NOT NULL,
    "candidateId"    TEXT NOT NULL,
    "refereeName"    TEXT NOT NULL,
    "refereeTitle"   TEXT,
    "refereeCompany" TEXT,
    "refereeEmail"   TEXT,
    "refereePhone"   TEXT,
    "relationship"   TEXT,
    "status"         TEXT NOT NULL DEFAULT 'pending',
    "questions"      TEXT,
    "responses"      TEXT,
    "summary"        TEXT,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ReferenceCheck_pkey" PRIMARY KEY ("id")
);

-- Deduplicate candidates before creating the unique index.
-- The search route previously used candidate.create which could insert
-- duplicates on concurrent searches. Keep the row with the best score
-- (highest matchScore, then most recent updatedAt) for each (jobId, linkedinUrl).
DELETE FROM "Candidate"
WHERE "linkedinUrl" IS NOT NULL
  AND id NOT IN (
    SELECT DISTINCT ON ("jobId", "linkedinUrl") id
    FROM "Candidate"
    WHERE "linkedinUrl" IS NOT NULL
    ORDER BY "jobId", "linkedinUrl", COALESCE("matchScore", -1) DESC, "updatedAt" DESC
  );

-- Unique indexes
CREATE UNIQUE INDEX IF NOT EXISTS "Org_name_key"                    ON "Org"("name");
CREATE UNIQUE INDEX IF NOT EXISTS "User_username_key"               ON "User"("username");
CREATE UNIQUE INDEX IF NOT EXISTS "Candidate_jobId_linkedinUrl_key" ON "Candidate"("jobId", "linkedinUrl");
CREATE UNIQUE INDEX IF NOT EXISTS "FetchSession_candidateId_key"    ON "FetchSession"("candidateId");

-- Regular indexes
CREATE INDEX IF NOT EXISTS "FetchSession_jobId_idx"   ON "FetchSession"("jobId");
CREATE INDEX IF NOT EXISTS "FetchSession_status_idx"  ON "FetchSession"("status");
CREATE INDEX IF NOT EXISTS "SearchSession_jobId_idx"  ON "SearchSession"("jobId");

-- Foreign keys (idempotent via DO blocks)
DO $$ BEGIN ALTER TABLE "User"         ADD CONSTRAINT "User_orgId_fkey"           FOREIGN KEY ("orgId")       REFERENCES "Org"("id")       ON DELETE SET NULL  ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "Job"          ADD CONSTRAINT "Job_orgId_fkey"            FOREIGN KEY ("orgId")       REFERENCES "Org"("id")       ON DELETE SET NULL  ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "Candidate"    ADD CONSTRAINT "Candidate_jobId_fkey"      FOREIGN KEY ("jobId")       REFERENCES "Job"("id")       ON DELETE CASCADE   ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "CandidateFile"  ADD CONSTRAINT "CandidateFile_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "FetchSession" ADD CONSTRAINT "FetchSession_jobId_fkey"   FOREIGN KEY ("jobId")       REFERENCES "Job"("id")       ON DELETE CASCADE   ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "FetchSession" ADD CONSTRAINT "FetchSession_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "SearchSession" ADD CONSTRAINT "SearchSession_jobId_fkey" FOREIGN KEY ("jobId")       REFERENCES "Job"("id")       ON DELETE CASCADE   ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "ReferenceCheck" ADD CONSTRAINT "ReferenceCheck_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
