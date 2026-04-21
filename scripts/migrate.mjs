/**
 * Run this script once after stopping the dev server to apply schema changes.
 * Usage: node scripts/migrate.mjs
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({
  datasources: { db: { url: "file:./prisma/dev.db" } },
});

const migrations = [
  // Candidate fields
  "ALTER TABLE Candidate ADD COLUMN screeningData TEXT",
  "ALTER TABLE Candidate ADD COLUMN interviewNotes TEXT",
  "ALTER TABLE Candidate ADD COLUMN statusHistory TEXT",
  "ALTER TABLE Candidate ADD COLUMN contactedAt DATETIME",
  "ALTER TABLE Candidate ADD COLUMN profileCapturedAt DATETIME",
  // ReferenceCheck table
  `CREATE TABLE IF NOT EXISTS "ReferenceCheck" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "candidateId" TEXT NOT NULL,
    "refereeName" TEXT NOT NULL,
    "refereeTitle" TEXT,
    "refereeCompany" TEXT,
    "refereeEmail" TEXT,
    "refereePhone" TEXT,
    "relationship" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "questions" TEXT,
    "responses" TEXT,
    "summary" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReferenceCheck_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate" ("id") ON DELETE CASCADE ON UPDATE CASCADE
  )`,
  // Org + auth fields
  `CREATE TABLE IF NOT EXISTS "Org" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL UNIQUE,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  "ALTER TABLE Job ADD COLUMN orgId TEXT",
  "ALTER TABLE User ADD COLUMN orgId TEXT",
];

let ok = 0;
let skipped = 0;
for (const sql of migrations) {
  try {
    await prisma.$executeRawUnsafe(sql);
    console.log("✓", sql.slice(0, 70));
    ok++;
  } catch (e) {
    const msg = e.message ?? "";
    if (
      msg.includes("duplicate column") ||
      msg.includes("already exists") ||
      msg.includes("UNIQUE constraint failed")
    ) {
      console.log("–", sql.slice(0, 70), "(already exists)");
      skipped++;
    } else {
      console.error("✗", sql.slice(0, 70));
      console.error("  ", msg);
    }
  }
}

await prisma.$disconnect();
console.log(`\nDone — ${ok} applied, ${skipped} skipped.`);
