#!/usr/bin/env node
/**
 * Backfill CandidateFile rows for JobAdder candidates that already exist
 * in the library but have no CV file. Pair to scripts/import-jobadder.mjs:
 * the main importer only attaches CVs to NEWLY-created rows (it short-
 * circuits on dupes). This script handles the existing-row case:
 *
 *   - Scans the CV directory (filenames `{cid}_<original>`)
 *   - For each file, looks up the Candidate by jobAdderUrl
 *   - If the candidate exists AND has no CV file yet, creates one
 *
 * Idempotent — re-running skips candidates that already have any file
 * (so a partial run can be safely resumed).
 *
 * Usage:
 *   node scripts/import-jobadder-cvs.mjs --cvs /home/baeley/jobadder_exporter_output/cvs --org cmov8v9tv0000o8qctlf6ztmm
 */

import { PrismaClient } from "@prisma/client";
import { readdir, stat, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const prisma = new PrismaClient();

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, idx, arr) => {
    if (cur.startsWith("--") && arr[idx + 1] && !arr[idx + 1].startsWith("--")) {
      acc.push([cur.slice(2), arr[idx + 1]]);
    }
    return acc;
  }, [])
);

const CVS_DIR = args.cvs;
const ORG_ID  = args.org;

if (!CVS_DIR || !ORG_ID) {
  console.error("Required: --cvs <dir> --org <orgId>");
  process.exit(2);
}
if (!existsSync(CVS_DIR)) {
  console.error(`CV directory not found: ${CVS_DIR}`);
  process.exit(2);
}

const MAX_BYTES = 12 * 1024 * 1024;
const MIME = {
  ".pdf":  "application/pdf",
  ".doc":  "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".rtf":  "application/rtf",
  ".txt":  "text/plain",
};
const mimeFor = (n) => MIME[path.extname(n).toLowerCase()] || "application/octet-stream";

async function buildCvIndex(dir) {
  const files = await readdir(dir);
  const idx = new Map();
  for (const f of files) {
    const underscore = f.indexOf("_");
    if (underscore < 1) continue;
    const cid = f.slice(0, underscore);
    if (!/^\d+$/.test(cid)) continue;
    if (!idx.has(cid)) idx.set(cid, path.join(dir, f));
  }
  return idx;
}

async function main() {
  console.log(`[cv-backfill] org:       ${ORG_ID}`);
  console.log(`[cv-backfill] cvs dir:   ${CVS_DIR}`);

  const cvIndex = await buildCvIndex(CVS_DIR);
  console.log(`[cv-backfill] ${cvIndex.size.toLocaleString()} CV files indexed`);

  const stats = {
    attached: 0,
    skippedHasFile: 0,
    skippedNoCandidate: 0,
    skippedLarge: 0,
    errored: 0,
    bytes: 0,
  };

  let processed = 0;
  for (const [cid, cvPath] of cvIndex) {
    processed++;
    const jobAdderUrl = `https://au6.jobadder.com/candidates/${cid}`;
    try {
      const candidate = await prisma.candidate.findFirst({
        where: { orgId: ORG_ID, jobAdderUrl },
        select: { id: true, _count: { select: { files: true } } },
      });
      if (!candidate) {
        stats.skippedNoCandidate++;
        continue;
      }
      if (candidate._count.files > 0) {
        stats.skippedHasFile++;
        continue;
      }

      const st = await stat(cvPath);
      if (st.size > MAX_BYTES) {
        stats.skippedLarge++;
        continue;
      }

      const buf = await readFile(cvPath);
      const filename = path.basename(cvPath).replace(/^\d+_/, "");
      await prisma.candidateFile.create({
        data: {
          candidateId: candidate.id,
          type: "cv",
          filename,
          mimeType: mimeFor(filename),
          data: buf.toString("base64"),
          size: st.size,
        },
      });
      stats.attached++;
      stats.bytes += st.size;
    } catch (err) {
      stats.errored++;
      console.error(`[cv-backfill] cid=${cid} failed: ${err.message}`);
    }
    if (processed % 200 === 0) {
      console.log(`[cv-backfill] ${processed}/${cvIndex.size}  attached=${stats.attached} hasFile=${stats.skippedHasFile} noCand=${stats.skippedNoCandidate}`);
    }
  }

  console.log("\n────────────────────────────────────────────────────────────");
  console.log("SUMMARY");
  console.log("────────────────────────────────────────────────────────────");
  console.log(`Files indexed:           ${cvIndex.size.toLocaleString()}`);
  console.log(`CVs attached:            ${stats.attached.toLocaleString()}  (${(stats.bytes / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`Skipped (already had):   ${stats.skippedHasFile.toLocaleString()}`);
  console.log(`Skipped (no candidate):  ${stats.skippedNoCandidate.toLocaleString()}`);
  console.log(`Skipped (>12MB):         ${stats.skippedLarge.toLocaleString()}`);
  console.log(`Errors:                  ${stats.errored.toLocaleString()}`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
