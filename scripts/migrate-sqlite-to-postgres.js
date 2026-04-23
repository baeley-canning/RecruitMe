/**
 * Migrates data from local SQLite (prisma/dev.db) to Railway PostgreSQL.
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." node scripts/migrate-sqlite-to-postgres.js
 *
 * The DATABASE_URL should be the Railway Postgres EXTERNAL connection string
 * (from Railway → Postgres service → Variables → DATABASE_PUBLIC_URL).
 */

const Database = require("better-sqlite3");
const { PrismaClient } = require("@prisma/client");
const path = require("path");

const SQLITE_PATH = path.join(__dirname, "../prisma/dev.db");

async function main() {
  console.log("Opening SQLite:", SQLITE_PATH);
  const sqlite = new Database(SQLITE_PATH, { readonly: true });
  const pg = new PrismaClient();

  const read = (table) => sqlite.prepare(`SELECT * FROM "${table}"`).all();

  // ── Orgs ──────────────────────────────────────────────────────────────────
  const orgs = read("Org");
  console.log(`Migrating ${orgs.length} orgs...`);
  for (const r of orgs) {
    await pg.org.upsert({
      where: { id: r.id },
      update: {},
      create: { id: r.id, name: r.name, createdAt: new Date(r.createdAt), updatedAt: new Date(r.updatedAt) },
    });
  }

  // ── Users ─────────────────────────────────────────────────────────────────
  const users = read("User");
  console.log(`Migrating ${users.length} users...`);
  for (const r of users) {
    await pg.user.upsert({
      where: { id: r.id },
      update: {},
      create: { id: r.id, username: r.username, password: r.password, role: r.role, orgId: r.orgId ?? null, createdAt: new Date(r.createdAt), updatedAt: new Date(r.updatedAt) },
    });
  }

  // ── Settings ──────────────────────────────────────────────────────────────
  const settings = read("Setting");
  console.log(`Migrating ${settings.length} settings...`);
  for (const r of settings) {
    await pg.setting.upsert({
      where: { key: r.key },
      update: { value: r.value },
      create: { key: r.key, value: r.value, updatedAt: new Date(r.updatedAt) },
    });
  }

  // ── Jobs ──────────────────────────────────────────────────────────────────
  const jobs = read("Job");
  console.log(`Migrating ${jobs.length} jobs...`);
  for (const r of jobs) {
    await pg.job.upsert({
      where: { id: r.id },
      update: {},
      create: {
        id: r.id, title: r.title, company: r.company ?? null, location: r.location ?? null,
        rawJd: r.rawJd, parsedRole: r.parsedRole ?? null,
        salaryMin: r.salaryMin ?? null, salaryMax: r.salaryMax ?? null,
        isRemote: r.isRemote === 1 || r.isRemote === true,
        status: r.status, orgId: r.orgId ?? null,
        createdAt: new Date(r.createdAt), updatedAt: new Date(r.updatedAt),
      },
    });
  }

  // ── Candidates ────────────────────────────────────────────────────────────
  const candidates = read("Candidate");
  console.log(`Migrating ${candidates.length} candidates...`);
  for (const r of candidates) {
    await pg.candidate.upsert({
      where: { id: r.id },
      update: {},
      create: {
        id: r.id, jobId: r.jobId, name: r.name,
        headline: r.headline ?? null, location: r.location ?? null, linkedinUrl: r.linkedinUrl ?? null,
        profileText: r.profileText ?? null, profileCapturedAt: r.profileCapturedAt ? new Date(r.profileCapturedAt) : null,
        matchScore: r.matchScore ?? null, matchReason: r.matchReason ?? null,
        acceptanceScore: r.acceptanceScore ?? null, acceptanceReason: r.acceptanceReason ?? null,
        scoreBreakdown: r.scoreBreakdown ?? null, notes: r.notes ?? null,
        screeningData: r.screeningData ?? null, interviewNotes: r.interviewNotes ?? null,
        status: r.status, statusHistory: r.statusHistory ?? null,
        contactedAt: r.contactedAt ? new Date(r.contactedAt) : null,
        source: r.source,
        createdAt: new Date(r.createdAt), updatedAt: new Date(r.updatedAt),
      },
    });
  }

  // ── CandidateFiles ────────────────────────────────────────────────────────
  const files = read("CandidateFile");
  console.log(`Migrating ${files.length} candidate files...`);
  for (const r of files) {
    await pg.candidateFile.upsert({
      where: { id: r.id },
      update: {},
      create: {
        id: r.id, candidateId: r.candidateId, type: r.type,
        filename: r.filename, mimeType: r.mimeType, data: r.data, size: r.size,
        createdAt: new Date(r.createdAt),
      },
    });
  }

  // ── ReferenceChecks ───────────────────────────────────────────────────────
  const refs = read("ReferenceCheck");
  console.log(`Migrating ${refs.length} reference checks...`);
  for (const r of refs) {
    await pg.referenceCheck.upsert({
      where: { id: r.id },
      update: {},
      create: {
        id: r.id, candidateId: r.candidateId,
        refereeName: r.refereeName, refereeTitle: r.refereeTitle ?? null,
        refereeCompany: r.refereeCompany ?? null, refereeEmail: r.refereeEmail ?? null,
        refereePhone: r.refereePhone ?? null, relationship: r.relationship ?? null,
        status: r.status, questions: r.questions ?? null, responses: r.responses ?? null,
        summary: r.summary ?? null,
        createdAt: new Date(r.createdAt), updatedAt: new Date(r.updatedAt),
      },
    });
  }

  await pg.$disconnect();
  sqlite.close();
  console.log("Migration complete.");
}

main().catch((e) => { console.error(e); process.exit(1); });
