-- DB-backed brute-force protection — replaces in-memory Map in auth.ts
CREATE TABLE "LoginAttempt" (
  "id"      TEXT NOT NULL,
  "key"     TEXT NOT NULL,
  "count"   INTEGER NOT NULL DEFAULT 0,
  "resetAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LoginAttempt_key_key" ON "LoginAttempt"("key");
CREATE INDEX "LoginAttempt_key_idx" ON "LoginAttempt"("key");
