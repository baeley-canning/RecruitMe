-- Per-job ScoringWeights override; null falls back to the org-level setting,
-- then to DEFAULT_SCORING_WEIGHTS.
ALTER TABLE "Job" ADD COLUMN "scoringWeights" TEXT;
