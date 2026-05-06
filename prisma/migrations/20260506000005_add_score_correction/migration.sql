-- Recruiter "Train it" score corrections — fed back into the scoring prompt
-- as calibration examples so similar future candidates score closer to the
-- recruiter's mental model.
CREATE TABLE "ScoreCorrection" (
  "id"             TEXT NOT NULL PRIMARY KEY,
  "candidateId"    TEXT NOT NULL,
  "jobId"          TEXT,
  "orgId"          TEXT,
  "originalScore"  INTEGER NOT NULL,
  "recruiterScore" INTEGER NOT NULL,
  "reason"         TEXT,
  "roleTitle"      TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScoreCorrection_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ScoreCorrection_orgId_idx"       ON "ScoreCorrection"("orgId");
CREATE INDEX "ScoreCorrection_candidateId_idx" ON "ScoreCorrection"("candidateId");
