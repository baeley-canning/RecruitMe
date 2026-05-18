CREATE TABLE "ContactEvent" (
  "id"          TEXT NOT NULL PRIMARY KEY,
  "candidateId" TEXT NOT NULL,
  "orgId"       TEXT,
  "userId"      TEXT NOT NULL,
  "userName"    TEXT NOT NULL,
  "type"        TEXT NOT NULL,
  "note"        TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContactEvent_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ContactEvent_candidateId_idx" ON "ContactEvent"("candidateId");
CREATE INDEX "ContactEvent_orgId_idx" ON "ContactEvent"("orgId");
