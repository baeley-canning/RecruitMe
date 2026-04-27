-- Add per-job score-all cooldown timestamp (replaces in-memory Map).
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "lastScoredAt" TIMESTAMP(3);

-- Usage event log: tracks Claude calls, searches, and scoring runs per org.
-- Used for rate limiting and future billing metering.
CREATE TABLE IF NOT EXISTS "UsageEvent" (
    "id"        TEXT NOT NULL,
    "orgId"     TEXT,
    "userId"    TEXT,
    "type"      TEXT NOT NULL,
    "meta"      TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UsageEvent_pkey" PRIMARY KEY ("id")
);

-- Composite index for efficient per-org-per-type-per-window queries.
CREATE INDEX IF NOT EXISTS "UsageEvent_orgId_type_createdAt_idx"
    ON "UsageEvent"("orgId", "type", "createdAt");
