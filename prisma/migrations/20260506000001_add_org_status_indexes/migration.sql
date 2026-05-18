-- Add indexes for org-scoped queries and status filtering
-- These prevent full table scans when listing jobs/candidates by org

CREATE INDEX IF NOT EXISTS "Job_orgId_idx" ON "Job"("orgId");
CREATE INDEX IF NOT EXISTS "Job_status_idx" ON "Job"("status");
CREATE INDEX IF NOT EXISTS "Candidate_orgId_idx" ON "Candidate"("orgId");
CREATE INDEX IF NOT EXISTS "Candidate_status_idx" ON "Candidate"("status");
