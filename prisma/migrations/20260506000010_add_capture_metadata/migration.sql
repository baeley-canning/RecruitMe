-- Records the proof that the extension's deep-section fetches actually ran:
-- per-section HTTP status, finalUrl after redirects, chars added, merge mode.
-- JSON-stringified to keep schema flexible while we iterate on the shape.
ALTER TABLE "Candidate" ADD COLUMN "captureMetadata" TEXT;
