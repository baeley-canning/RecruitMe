-- User-named, re-runnable search definitions per job.
CREATE TABLE "SavedSearch" (
  "id"              TEXT NOT NULL PRIMARY KEY,
  "jobId"           TEXT NOT NULL,
  "orgId"           TEXT,
  "name"            TEXT NOT NULL,
  "queries"         TEXT NOT NULL,
  "location"        TEXT NOT NULL,
  "target"          INTEGER NOT NULL DEFAULT 20,
  "lastRunAt"       TIMESTAMP(3),
  "lastResultCount" INTEGER,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SavedSearch_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "SavedSearch_jobId_idx" ON "SavedSearch"("jobId");
CREATE INDEX "SavedSearch_orgId_idx" ON "SavedSearch"("orgId");
