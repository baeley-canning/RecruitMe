#!/usr/bin/env node
/**
 * Diagnose the "Bede problem" — empty / under-filled candidates in the
 * library, mostly stragglers from the JobAdder bulk import where the
 * candidate row was created but the CV PDF blob was missing from the
 * local CV directory at import time, so profileText stayed null.
 *
 * READ-ONLY. Runs Prisma SELECTs only. No INSERT, UPDATE, or DELETE.
 * Safe to run anytime, in any environment, against any DB.
 *
 * Outputs four buckets:
 *   (a) library rows (jobId IS NULL) with empty / short profileText, by source
 *   (b) library rows with jobAdderUrl set but NO CandidateFile of type "cv"
 *   (c) per-job talent_pool candidates with empty profileText, grouped by job
 *   (d) jobadder_import candidates with profileText < 500 chars (any jobId)
 *
 * Usage:
 *   node scripts/diagnose-empty-library.mjs            # human-readable
 *   node scripts/diagnose-empty-library.mjs --json     # machine-readable
 *   railway run node scripts/diagnose-empty-library.mjs --json   # prod
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const args = parseArgs(process.argv.slice(2));
const JSON_OUT = args.json === true;
const SHORT_THRESHOLD = 500; // chars — anything below this is effectively useless content

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    const n = argv[i + 1];
    if (!n || n.startsWith("--")) out[k] = true;
    else { out[k] = n; i++; }
  }
  return out;
}

function log(...parts) { if (!JSON_OUT) console.log(...parts); }

async function bucketA() {
  // Library rows = jobId IS NULL. Group by source, count those with
  // profileText IS NULL OR length < SHORT_THRESHOLD. Prisma can't express
  // "length(text) < N" via groupBy, so we pull the slim rows and tally
  // in-process. Library rows are ~tens of thousands max — fine.
  const rows = await prisma.candidate.findMany({
    where: { jobId: null },
    select: { source: true, profileText: true },
  });
  const totals = {};        // source -> totalLibraryRows
  const empties = {};       // source -> short/empty count
  for (const r of rows) {
    const src = r.source ?? "(null)";
    totals[src] = (totals[src] ?? 0) + 1;
    const len = r.profileText?.length ?? 0;
    if (len < SHORT_THRESHOLD) empties[src] = (empties[src] ?? 0) + 1;
  }
  const bySource = Object.keys(totals).sort().map((src) => ({
    source: src,
    total: totals[src],
    emptyOrShort: empties[src] ?? 0,
  }));
  return { thresholdChars: SHORT_THRESHOLD, bySource };
}

async function bucketB() {
  // jobAdderUrl set + NO CandidateFile of type "cv". `files: { none: ... }`
  // is the Prisma idiom. We don't filter by jobId here — the "library
  // source row" view typically has jobId IS NULL, but some JobAdder
  // imports landed as per-job rows. The CV-attached question applies to
  // all of them.
  const where = {
    jobAdderUrl: { not: null },
    files: { none: { type: "cv" } },
  };
  const count = await prisma.candidate.count({ where });
  const sample = await prisma.candidate.findMany({
    where,
    select: { id: true, name: true, jobAdderUrl: true, jobId: true, source: true, profileText: true },
    take: 10,
    orderBy: { createdAt: "asc" }, // oldest first — earliest import stragglers
  });
  return {
    count,
    sample: sample.map((c) => ({
      id: c.id,
      name: c.name,
      jobAdderUrl: c.jobAdderUrl,
      jobId: c.jobId,
      source: c.source,
      profileTextLen: c.profileText?.length ?? 0,
    })),
  };
}

async function bucketC() {
  // source=talent_pool + jobId IS NOT NULL + empty/short profileText,
  // grouped by job (id, title, company). These are the rows that show up
  // in a real job's Talent pool column but have no content to score on.
  const rows = await prisma.candidate.findMany({
    where: {
      source: "talent_pool",
      jobId: { not: null },
    },
    select: {
      jobId: true,
      profileText: true,
      job: { select: { title: true, company: true } },
    },
  });
  const byJob = new Map(); // jobId -> { title, company, count }
  for (const r of rows) {
    if ((r.profileText?.length ?? 0) >= SHORT_THRESHOLD) continue;
    const key = r.jobId;
    const cur = byJob.get(key) ?? { jobId: key, title: r.job?.title ?? "(missing)", company: r.job?.company ?? null, count: 0 };
    cur.count++;
    byJob.set(key, cur);
  }
  const sorted = Array.from(byJob.values()).sort((a, b) => b.count - a.count);
  const total = sorted.reduce((s, j) => s + j.count, 0);
  return { thresholdChars: SHORT_THRESHOLD, totalEmptyOnJobs: total, jobs: sorted };
}

async function bucketD() {
  // source=jobadder_import with profileText < 500 chars. Includes nulls.
  // No jobId filter — this is the global "how much of the import is
  // still under-filled" question after extract-cv-text.mjs has run.
  const rows = await prisma.candidate.findMany({
    where: { source: "jobadder_import" },
    select: { profileText: true },
  });
  let short = 0, nullCount = 0, total = rows.length;
  for (const r of rows) {
    const len = r.profileText?.length ?? 0;
    if (r.profileText == null) nullCount++;
    if (len < SHORT_THRESHOLD) short++;
  }
  return {
    thresholdChars: SHORT_THRESHOLD,
    totalJobAdderImports: total,
    nullProfileText: nullCount,
    shortProfileText: short,
  };
}

async function main() {
  log(`[diagnose] read-only — querying Prisma…`);
  log(`[diagnose] threshold for "empty/short" profileText: < ${SHORT_THRESHOLD} chars`);

  const [a, b, c, d] = await Promise.all([bucketA(), bucketB(), bucketC(), bucketD()]);

  const report = {
    generatedAt: new Date().toISOString(),
    thresholdChars: SHORT_THRESHOLD,
    libraryEmptyBySource: a,
    libraryMissingCvFile: b,
    talentPoolEmptyByJob: c,
    jobadderImportShortText: d,
  };

  if (JSON_OUT) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }

  // ─── Human-readable ───────────────────────────────────────────────────
  console.log("");
  console.log("═".repeat(72));
  console.log("(a) Library rows (jobId IS NULL) by source — empty / < 500-char profile");
  console.log("═".repeat(72));
  for (const s of a.bySource) {
    const pct = s.total > 0 ? ((s.emptyOrShort / s.total) * 100).toFixed(1) : "0.0";
    console.log(`  ${s.source.padEnd(24)}  total=${String(s.total).padStart(7)}  empty/short=${String(s.emptyOrShort).padStart(7)}  (${pct}%)`);
  }

  console.log("");
  console.log("═".repeat(72));
  console.log("(b) Candidates with jobAdderUrl set but NO CV file attached");
  console.log("═".repeat(72));
  console.log(`  total: ${b.count.toLocaleString()}`);
  console.log(`  sample (10 oldest):`);
  for (const c of b.sample) {
    console.log(`    ${c.id}  ${(c.name ?? "(no name)").slice(0, 40).padEnd(40)}  src=${c.source}  jobId=${c.jobId ?? "—"}  ptLen=${c.profileTextLen}`);
    console.log(`      ${c.jobAdderUrl}`);
  }

  console.log("");
  console.log("═".repeat(72));
  console.log("(c) source=talent_pool ON A JOB with empty profileText, by job");
  console.log("═".repeat(72));
  console.log(`  total empty talent_pool rows across all jobs: ${c.totalEmptyOnJobs.toLocaleString()}`);
  for (const j of c.jobs) {
    const label = `${j.title}${j.company ? " · " + j.company : ""}`;
    console.log(`    ${String(j.count).padStart(5)}  ${j.jobId}  ${label}`);
  }
  if (c.jobs.length === 0) console.log(`    (none — clean)`);

  console.log("");
  console.log("═".repeat(72));
  console.log("(d) source=jobadder_import with profileText < 500 chars");
  console.log("═".repeat(72));
  console.log(`  total jobadder_import:       ${d.totalJobAdderImports.toLocaleString()}`);
  console.log(`  profileText IS NULL:         ${d.nullProfileText.toLocaleString()}`);
  console.log(`  profileText < 500 chars:     ${d.shortProfileText.toLocaleString()}`);

  console.log("");
  console.log("Done — read-only, no writes.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
