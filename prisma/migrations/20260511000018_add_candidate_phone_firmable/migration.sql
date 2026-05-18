-- Phone number + Firmable enrichment metadata on Candidate.
-- `phone` is the primary display value (preferred mobile / first available).
-- `firmableData` is the full Firmable People response as JSON so other phones,
-- emails, and DND flags remain reachable without a re-lookup.
-- `firmableEnrichedAt` gates the 90-day staleness check.
ALTER TABLE "Candidate" ADD COLUMN "phone" TEXT;
ALTER TABLE "Candidate" ADD COLUMN "firmableData" TEXT;
ALTER TABLE "Candidate" ADD COLUMN "firmableEnrichedAt" TIMESTAMP(3);
