#!/usr/bin/env node
/**
 * List JobAdder candidates in the library that have NO CV file attached.
 *
 * Walks every Candidate with `jobAdderUrl` set and emits one CSV row per
 * candidate that has no `CandidateFile` of type "cv". The JobAdder
 * candidate ID (the trailing path segment of jobAdderUrl) is the key
 * signal — the user pipes this list into JobAdder's bulk CV export, then
 * re-runs scripts/import-jobadder.mjs to backfill profileText.
 *
 * READ-ONLY. No writes.
 *
 * Output (CSV to stdout):
 *   jobAdderCid,candidateId,name,headline,jobAdderUrl
 *
 * Usage:
 *   node scripts/list-jobadder-without-cv.mjs > missing-cvs.csv
 *   railway run node scripts/list-jobadder-without-cv.mjs > missing-cvs.csv
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function parseCid(url) {
  if (!url) return "";
  // Match the last numeric (or alphanumeric) path segment. JobAdder URLs
  // look like https://au6.jobadder.com/candidates/12345 — but also tolerate
  // a trailing slash or query string.
  const m = url.match(/\/candidates\/([^/?#]+)/i);
  return m ? m[1] : "";
}

function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  // Quote if contains a comma, quote, or newline. Escape internal quotes
  // by doubling. RFC 4180.
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function main() {
  const rows = await prisma.candidate.findMany({
    where: {
      jobAdderUrl: { not: null },
      files: { none: { type: "cv" } },
    },
    select: {
      id: true,
      name: true,
      headline: true,
      jobAdderUrl: true,
    },
    orderBy: { createdAt: "asc" },
  });

  // Header
  process.stdout.write("jobAdderCid,candidateId,name,headline,jobAdderUrl\n");
  for (const r of rows) {
    const cid = parseCid(r.jobAdderUrl);
    const line = [cid, r.id, r.name ?? "", r.headline ?? "", r.jobAdderUrl ?? ""]
      .map(csvEscape)
      .join(",");
    process.stdout.write(line + "\n");
  }

  // Summary line to stderr so it doesn't pollute the CSV when piped.
  process.stderr.write(`\n[list-jobadder-without-cv] ${rows.length.toLocaleString()} candidates missing a CV file\n`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
