import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAuth } from "@/lib/session";

const migrations = [
  "ALTER TABLE Candidate ADD COLUMN screeningData TEXT",
  "ALTER TABLE Candidate ADD COLUMN interviewNotes TEXT",
  "ALTER TABLE Candidate ADD COLUMN statusHistory TEXT",
  "ALTER TABLE Candidate ADD COLUMN contactedAt DATETIME",
  "ALTER TABLE Candidate ADD COLUMN profileCapturedAt DATETIME",
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
  `CREATE TABLE IF NOT EXISTS "Org" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL UNIQUE,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  "ALTER TABLE Job ADD COLUMN orgId TEXT",
  "ALTER TABLE User ADD COLUMN orgId TEXT",
];

export async function POST() {
  const auth = await getAuth();
  if (!auth || !auth.isOwner) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const results: { sql: string; result: string }[] = [];

  for (const sql of migrations) {
    const label = sql.slice(0, 60).replace(/\n/g, " ");
    try {
      await prisma.$executeRawUnsafe(sql);
      results.push({ sql: label, result: "applied" });
    } catch (e) {
      const msg = (e as Error).message ?? "";
      if (
        msg.includes("duplicate column") ||
        msg.includes("already exists") ||
        msg.includes("table") && msg.includes("exists")
      ) {
        results.push({ sql: label, result: "already exists" });
      } else {
        results.push({ sql: label, result: `error: ${msg.slice(0, 100)}` });
      }
    }
  }

  return NextResponse.json({ results });
}
