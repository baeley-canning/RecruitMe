-- AlterTable: add provisionalScore — snapshot of matchScore at snippet-import time.
-- Never overwritten once set; used to compute score delta after full-profile scoring.
ALTER TABLE "Candidate" ADD COLUMN "provisionalScore" INTEGER;
