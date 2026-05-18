#!/usr/bin/env node
/**
 * CV extraction sanity report for the JobAdder bulk-import population.
 *
 * Prints a 7-section summary: total/withText/null counts, 10 random
 * profileText samples, length-bucket distribution, C0 control-char scan,
 * tab-ratio outliers, mimetype/extension breakdown, RTF spot checks, and
 * a cross-check of extract-cv-failures.json entries against current DB
 * state (still-null vs leaked-populated).
 *
 * READ-ONLY. Runs Prisma SELECTs/counts only. No INSERT / UPDATE / DELETE.
 * Safe to run anytime, in any environment, against any DB.
 *
 * Usage:  node scripts/cv-extract-sanity.mjs
 *
 * Companion to scripts/extract-cv-text.mjs, which writes the
 * extract-cv-failures.json log read in section 7.
 */
import { PrismaClient } from "@prisma/client";
import { readFile } from "node:fs/promises";

const prisma = new PrismaClient();
const ORG_ID = "cmov8v9tv0000o8qctlf6ztmm";
const SOURCE = "jobadder_import";

function head(s, n = 250) {
  return (s ?? "").slice(0, n).replace(/\s+/g, " ");
}

function hasC0(s) {
  // anything < 0x20 except \t (0x09), \n (0x0a), \r (0x0d)
  return /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(s);
}

async function main() {
  const where = { orgId: ORG_ID, source: SOURCE };

  const total = await prisma.candidate.count({ where });
  const withText = await prisma.candidate.count({ where: { ...where, profileText: { not: null } } });
  const nullText = await prisma.candidate.count({ where: { ...where, profileText: null } });

  console.log("=== POPULATION ===");
  console.log({ total, withText, nullText });

  // ---- 1. Random 10 samples ----
  console.log("\n=== 1. RANDOM 10 SAMPLES ===");
  const ids = await prisma.$queryRawUnsafe(
    `SELECT id FROM "Candidate" WHERE "orgId"=$1 AND source=$2 AND "profileText" IS NOT NULL ORDER BY random() LIMIT 10`,
    ORG_ID, SOURCE
  );
  const sample = await prisma.candidate.findMany({
    where: { id: { in: ids.map((r) => r.id) } },
    select: { id: true, name: true, profileText: true },
  });
  for (const c of sample) {
    console.log(`- ${c.name} [${c.id.slice(-6)}] len=${c.profileText.length}`);
    console.log(`    ${head(c.profileText, 250)}`);
  }

  // ---- 2. Length distribution ----
  console.log("\n=== 2. LENGTH BUCKETS ===");
  const buckets = await prisma.$queryRawUnsafe(
    `SELECT
       SUM(CASE WHEN length("profileText") < 500 THEN 1 ELSE 0 END)::int AS lt500,
       SUM(CASE WHEN length("profileText") BETWEEN 500 AND 1999 THEN 1 ELSE 0 END)::int AS b500_1999,
       SUM(CASE WHEN length("profileText") BETWEEN 2000 AND 9999 THEN 1 ELSE 0 END)::int AS b2000_9999,
       SUM(CASE WHEN length("profileText") >= 10000 THEN 1 ELSE 0 END)::int AS ge10000,
       COUNT(*)::int AS total
     FROM "Candidate"
     WHERE "orgId"=$1 AND source=$2 AND "profileText" IS NOT NULL`,
    ORG_ID, SOURCE
  );
  console.log(buckets[0]);
  console.log("Expected: 0 / ~300 / ~10000 / ~1600");

  // ---- 3. C0 control chars ----
  console.log("\n=== 3. C0 CONTROL CHAR SCAN (100 random) ===");
  const ctrlSample = await prisma.$queryRawUnsafe(
    `SELECT id, "profileText" FROM "Candidate" WHERE "orgId"=$1 AND source=$2 AND "profileText" IS NOT NULL ORDER BY random() LIMIT 100`,
    ORG_ID, SOURCE
  );
  let withCtrl = 0;
  const offenders = [];
  for (const c of ctrlSample) {
    if (hasC0(c.profileText)) {
      withCtrl++;
      if (offenders.length < 3) offenders.push(c.id);
    }
  }
  console.log({ scanned: ctrlSample.length, withCtrl, sampleOffenders: offenders });

  // Postgres won't accept literal NUL bytes in either text columns or query
  // strings (encoding "UTF8"; "ERROR: null character not permitted"), which
  // means a NUL-byte row can't physically exist in profileText. So we only
  // need to scan for the OTHER C0 control chars.
  const c0Count = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM "Candidate"
     WHERE "orgId"=$1 AND source=$2
       AND ( position(chr(1) in "profileText") > 0
          OR position(chr(2) in "profileText") > 0
          OR position(chr(3) in "profileText") > 0
          OR position(chr(4) in "profileText") > 0
          OR position(chr(5) in "profileText") > 0
          OR position(chr(6) in "profileText") > 0
          OR position(chr(7) in "profileText") > 0
          OR position(chr(8) in "profileText") > 0
          OR position(chr(11) in "profileText") > 0
          OR position(chr(12) in "profileText") > 0
          OR position(chr(14) in "profileText") > 0
          OR position(chr(15) in "profileText") > 0
          OR position(chr(16) in "profileText") > 0
          OR position(chr(17) in "profileText") > 0
          OR position(chr(18) in "profileText") > 0
          OR position(chr(19) in "profileText") > 0
          OR position(chr(20) in "profileText") > 0
          OR position(chr(21) in "profileText") > 0
          OR position(chr(22) in "profileText") > 0
          OR position(chr(23) in "profileText") > 0
          OR position(chr(24) in "profileText") > 0
          OR position(chr(25) in "profileText") > 0
          OR position(chr(26) in "profileText") > 0
          OR position(chr(27) in "profileText") > 0
          OR position(chr(28) in "profileText") > 0
          OR position(chr(29) in "profileText") > 0
          OR position(chr(30) in "profileText") > 0
          OR position(chr(31) in "profileText") > 0 )`,
    ORG_ID, SOURCE
  );
  console.log("Full-table non-NUL C0 control rows (excl tab/LF/CR):", c0Count[0].n);

  // ---- 4. Suspect-low quality ----
  console.log("\n=== 4. SUSPECT-LOW QUALITY ===");
  const lowq = await prisma.$queryRawUnsafe(
    `SELECT
       SUM(CASE WHEN btrim("profileText") = '' THEN 1 ELSE 0 END)::int AS whitespace_only,
       SUM(CASE WHEN "profileText" ~ '^[0-9\\s]+$' THEN 1 ELSE 0 END)::int AS digits_only,
       SUM(CASE WHEN length("profileText") < 500 THEN 1 ELSE 0 END)::int AS under_500
     FROM "Candidate"
     WHERE "orgId"=$1 AND source=$2 AND "profileText" IS NOT NULL`,
    ORG_ID, SOURCE
  );
  console.log(lowq[0]);
  // Show a few under-500 samples
  const tiny = await prisma.$queryRawUnsafe(
    `SELECT id, name, length("profileText") AS len, "profileText"
     FROM "Candidate"
     WHERE "orgId"=$1 AND source=$2 AND "profileText" IS NOT NULL AND length("profileText") < 500
     ORDER BY random() LIMIT 5`,
    ORG_ID, SOURCE
  );
  console.log("Tiny samples (up to 5):");
  for (const t of tiny) {
    console.log(`  ${t.name} [${t.id.slice(-6)}] len=${Number(t.len)}: ${head(t.profileText, 200)}`);
  }

  // ---- 5. profileCapturedAt + profileTextHash state ----
  console.log("\n=== 5. profileCapturedAt / profileTextHash STATE ===");
  const stateSample = await prisma.$queryRawUnsafe(
    `SELECT id, "profileCapturedAt", "profileTextHash"
     FROM "Candidate" WHERE "orgId"=$1 AND source=$2 AND "profileText" IS NOT NULL
     ORDER BY random() LIMIT 100`,
    ORG_ID, SOURCE
  );
  const now = Date.now();
  const HRS_24 = 24 * 3600 * 1000;
  let nullCaptured = 0, oldCaptured = 0, hashNotNull = 0;
  let minTs = Infinity, maxTs = -Infinity;
  for (const r of stateSample) {
    if (!r.profileCapturedAt) nullCaptured++;
    else {
      const ts = new Date(r.profileCapturedAt).getTime();
      minTs = Math.min(minTs, ts);
      maxTs = Math.max(maxTs, ts);
      if (now - ts > HRS_24) oldCaptured++;
    }
    if (r.profileTextHash !== null) hashNotNull++;
  }
  console.log({
    scanned: stateSample.length,
    nullCaptured,
    olderThan24h: oldCaptured,
    hashNotNull,
    capturedRange: minTs === Infinity ? null : { from: new Date(minTs).toISOString(), to: new Date(maxTs).toISOString() },
  });

  // Full-population hash check
  const hashFull = await prisma.candidate.count({
    where: { orgId: ORG_ID, source: SOURCE, profileText: { not: null }, profileTextHash: { not: null } },
  });
  console.log("Whole-population profileTextHash NOT NULL:", hashFull);

  // ---- 6. Mismatched files ----
  console.log("\n=== 6. FILE/MIME vs CONTENT SHAPE (10 samples) ===");
  const fileSample = await prisma.$queryRawUnsafe(
    `SELECT c.id, c.name, c."profileText", f.filename, f."mimeType"
     FROM "Candidate" c
     LEFT JOIN LATERAL (
       SELECT filename, "mimeType" FROM "CandidateFile" WHERE "candidateId" = c.id
       ORDER BY "createdAt" DESC LIMIT 1
     ) f ON true
     WHERE c."orgId"=$1 AND c.source=$2 AND c."profileText" IS NOT NULL
     ORDER BY random() LIMIT 10`,
    ORG_ID, SOURCE
  );
  for (const r of fileSample) {
    const txt = r.profileText ?? "";
    const tabRatio = (txt.match(/\t/g) || []).length / Math.max(txt.length, 1);
    const ext = (r.filename || "").split(".").pop()?.toLowerCase();
    console.log(`  ${r.name} | ${r.filename} | mime=${r.mimeType} | len=${txt.length} | tabRatio=${tabRatio.toExponential(2)}`);
    console.log(`     -> ${head(txt, 180)}`);
  }

  // ---- 7. 89 errored candidates ----
  console.log("\n=== 7. FAILURE LOG SPOT CHECK ===");
  let failures = [];
  try {
    const raw = await readFile("/Users/baeley/RecruitMe/extract-cv-failures.json", "utf8");
    failures = JSON.parse(raw);
  } catch (e) {
    console.log("failure log read error:", e.message);
  }
  console.log("failure log entries:", failures.length);
  const failIds = [...new Set(failures.map((f) => f.candidateId || f.id).filter(Boolean))];
  console.log("unique candidateIds in log:", failIds.length);
  if (failIds.length) {
    const stillNull = await prisma.candidate.count({
      where: { id: { in: failIds }, profileText: null },
    });
    const populated = await prisma.candidate.count({
      where: { id: { in: failIds }, profileText: { not: null } },
    });
    console.log({ stillNull, populated });
    if (populated > 0) {
      const leaks = await prisma.candidate.findMany({
        where: { id: { in: failIds }, profileText: { not: null } },
        select: { id: true, name: true, profileText: true },
        take: 5,
      });
      for (const l of leaks) {
        console.log(`  LEAK ${l.id} ${l.name} len=${l.profileText.length}: ${head(l.profileText, 150)}`);
      }
    }
  }

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
