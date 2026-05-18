ALTER TABLE "Candidate"
  ADD COLUMN IF NOT EXISTS "fetchPriorityScore" INTEGER,
  ADD COLUMN IF NOT EXISTS "fetchPriorityReason" TEXT;
