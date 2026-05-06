-- Review-pass tightening: composite index for the common matchScore-desc orderBy
-- on shortlist/job views, and unique-per-scope name constraints on saved searches
-- and scoring presets so duplicate-name confusion can't happen via the UI.
CREATE INDEX IF NOT EXISTS "Candidate_jobId_matchScore_idx" ON "Candidate"("jobId", "matchScore");

CREATE UNIQUE INDEX IF NOT EXISTS "SavedSearch_jobId_name_key" ON "SavedSearch"("jobId", "name");
CREATE UNIQUE INDEX IF NOT EXISTS "ScoringWeightPreset_orgId_name_key" ON "ScoringWeightPreset"("orgId", "name");
