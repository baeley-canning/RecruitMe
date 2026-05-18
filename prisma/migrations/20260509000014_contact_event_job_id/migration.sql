-- Add jobId to ContactEvent so a "messaged" / "called" event can be tied to
-- the specific role it was about. Lets the bubble overlay show "Kasia
-- messaged · 2d ago · re: [Role]" when a candidate is on multiple jobs.

ALTER TABLE "ContactEvent" ADD COLUMN "jobId" TEXT;
CREATE INDEX IF NOT EXISTS "ContactEvent_jobId_idx" ON "ContactEvent"("jobId");
