-- Opaque random token for read-only public shortlist URL.
-- null means sharing is disabled for this job.
ALTER TABLE "Job" ADD COLUMN "shareToken" TEXT;
CREATE UNIQUE INDEX "Job_shareToken_key" ON "Job"("shareToken");
