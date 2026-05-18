-- Public shortlist tokens now expire after 30 days by default. Existing
-- non-null tokens get a 30-day expiry from now so live shares keep working
-- but can't outlive the rotation window.
ALTER TABLE "Job" ADD COLUMN "shareTokenExpiresAt" TIMESTAMP(3);
UPDATE "Job" SET "shareTokenExpiresAt" = NOW() + INTERVAL '30 days' WHERE "shareToken" IS NOT NULL;
