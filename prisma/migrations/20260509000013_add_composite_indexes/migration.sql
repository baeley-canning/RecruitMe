-- Composite indexes for hot query paths identified by performance audit.
-- FetchSession: recovery-on-mount filters by (jobId, status); popup queries
-- by (orgId, status). Without composites these force scans of the single-column
-- index then in-memory filtering on the other column.
-- SearchSession: search-funnel filters by (jobId, status).

CREATE INDEX IF NOT EXISTS "FetchSession_jobId_status_idx" ON "FetchSession"("jobId", "status");
CREATE INDEX IF NOT EXISTS "FetchSession_orgId_status_idx" ON "FetchSession"("orgId", "status");
CREATE INDEX IF NOT EXISTS "SearchSession_jobId_status_idx" ON "SearchSession"("jobId", "status");
