-- Reusable scoring-weight presets per org (e.g. "Sales-heavy", "Engineer · Wellington").
CREATE TABLE "ScoringWeightPreset" (
  "id"        TEXT NOT NULL PRIMARY KEY,
  "orgId"     TEXT,
  "name"      TEXT NOT NULL,
  "weights"   TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE INDEX "ScoringWeightPreset_orgId_idx" ON "ScoringWeightPreset"("orgId");
