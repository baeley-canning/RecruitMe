-- Composite indexes for common query patterns
CREATE INDEX IF NOT EXISTS "Candidate_orgId_createdAt_idx" ON "Candidate"("orgId", "createdAt");
CREATE INDEX IF NOT EXISTS "Candidate_orgId_profileCapturedAt_idx" ON "Candidate"("orgId", "profileCapturedAt");
-- Index for LoginAttempt cleanup query on resetAt
CREATE INDEX IF NOT EXISTS "LoginAttempt_resetAt_idx" ON "LoginAttempt"("resetAt");
