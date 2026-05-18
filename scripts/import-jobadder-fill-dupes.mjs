#!/usr/bin/env node
/**
 * Companion to import-jobadder.mjs.
 *
 * Walks the JobAdder CSV and, for each row that matched an EXISTING
 * RecruitMe candidate (was skipped by the main import as a duplicate),
 * fills in two things on the existing record without creating anything:
 *
 *   1. jobAdderUrl — if the existing record didn't have one (e.g. the
 *      candidate was originally added via the LinkedIn extension and
 *      never had a JA link), set it to the canonical
 *      https://au6.jobadder.com/candidates/{candidateID} URL.
 *
 *   2. CV file — if the existing record has NO CandidateFile of type="cv",
 *      attach the JobAdder CV from cvs/{candidateID}_*.*. If they already
 *      have a CV (recruiter uploaded one manually), do nothing — assume
 *      what's already there is better than the JobAdder one.
 *
 * Newly-created jobadder_import candidates are skipped (their jobAdderUrl
 * and CV are already in place), so this is safe to run after the main
 * import + idempotent on re-runs.
 *
 * Usage (run from the RecruitMe repo root, with DATABASE_URL set):
 *   node scripts/import-jobadder-fill-dupes.mjs \
 *     --csv /Users/baeley/jobadder_exporter/output/candidates_<ts>.csv \
 *     --cvs /Users/baeley/jobadder_exporter/output/cvs \
 *     [--org <orgId>]
 *     [--dry-run]
 *     [--limit N]
 */

import { PrismaClient } from "@prisma/client";
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const prisma = new PrismaClient();
const args = parseArgs(process.argv.slice(2));
if (!args.csv || !args.cvs) {
  console.error("Required: --csv <path> --cvs <dir>");
  process.exit(2);
}
const CSV_PATH = args.csv;
const CVS_DIR  = args.cvs;
const LIMIT    = args.limit ? Number(args.limit) : null;
const CONCURRENCY = args.concurrency ? Number(args.concurrency) : 10;
const DRY_RUN  = args["dry-run"] === true;

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

// ─── Shared helpers (copies of those in import-jobadder.mjs) ───────────────

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false, i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === "") { inQuotes = true; i++; continue; }
    if (ch === ",") { row.push(field); field = ""; i++; continue; }
    if (ch === "\r") { i++; continue; }
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += ch; i++;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  if (rows.length === 0) return [];
  const header = rows[0];
  return rows.slice(1).map((r) => {
    const obj = {};
    for (let j = 0; j < header.length; j++) obj[header[j]] = r[j] ?? "";
    return obj;
  });
}

function normaliseLinkedInUrl(raw) {
  if (!raw) return "";
  const m = raw.match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  const slug = m ? m[1] : raw.replace(/[?#].*$/, "").replace(/\/$/, "");
  return `https://www.linkedin.com/in/${slug.toLowerCase()}`;
}

const MIME_BY_EXT = {
  ".pdf":  "application/pdf",
  ".doc":  "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".txt":  "text/plain",
  ".rtf":  "application/rtf",
};
function mimeFor(filename) {
  return MIME_BY_EXT[path.extname(filename).toLowerCase()] ?? "application/octet-stream";
}

async function buildCvIndex(cvsDir) {
  if (!existsSync(cvsDir)) return new Map();
  const files = await readdir(cvsDir);
  const idx = new Map();
  for (const f of files) {
    const u = f.indexOf("_");
    if (u < 1) continue;
    const cid = f.slice(0, u);
    if (!/^\d+$/.test(cid)) continue;
    if (!idx.has(cid)) idx.set(cid, path.join(cvsDir, f));
  }
  return idx;
}

async function resolveOrgId() {
  if (args.org) return args.org;
  const orgs = await prisma.org.findMany({ select: { id: true, name: true } });
  if (orgs.length === 0) { console.error("No orgs in DB."); process.exit(1); }
  if (orgs.length > 1) {
    console.error(`Multiple orgs — pass --org <id>. Orgs: ${orgs.map(o => `${o.id} (${o.name})`).join(", ")}`);
    process.exit(1);
  }
  console.log(`[fill-dupes] orgId=${orgs[0].id} (${orgs[0].name})`);
  return orgs[0].id;
}

// ─── Fill one row ──────────────────────────────────────────────────────────

async function fillRow(row, orgId, cvIndex, stats) {
  const cid = (row.candidateID || "").trim();
  if (!cid) { stats.errored++; return; }

  const linkedinUrl = row.linkedInUrl ? normaliseLinkedInUrl(row.linkedInUrl) : null;
  const jobAdderUrl = `https://au6.jobadder.com/candidates/${cid}`;

  // Find the existing record. Same matching rule as the main importer.
  const or = [];
  if (linkedinUrl) or.push({ linkedinUrl });
  or.push({ jobAdderUrl });
  const existing = await prisma.candidate.findFirst({
    where: { orgId, OR: or },
    select: {
      id: true,
      jobAdderUrl: true,
      source: true,
      _count: { select: { files: { where: { type: "cv" } } } },
    },
  });

  if (!existing) {
    // Should be rare — means the main importer didn't create it AND no
    // pre-existing record matched. Probably a no-LinkedIn/no-cid row that
    // the main run errored on. Count it but move on.
    stats.notFound++;
    return;
  }

  // Skip records that THIS importer just created — they already have
  // jobAdderUrl set + the right CV. Nothing to fill.
  if (existing.source === "jobadder_import" && existing.jobAdderUrl && existing._count.files > 0) {
    stats.skippedFreshlyImported++;
    return;
  }

  let didSomething = false;

  // 1. Backfill jobAdderUrl when missing.
  if (!existing.jobAdderUrl) {
    if (!DRY_RUN) {
      await prisma.candidate.update({
        where: { id: existing.id },
        data: { jobAdderUrl },
      });
    }
    stats.jobAdderUrlBackfilled++;
    didSomething = true;
  }

  // 2. Attach CV only if they have no CV at all. Don't clobber an
  //    existing recruiter-uploaded CV (that one is presumed better).
  if (existing._count.files === 0) {
    const cvPath = cvIndex.get(cid);
    if (!cvPath) {
      stats.noCvAvailable++;
    } else {
      try {
        const st = await stat(cvPath);
        if (st.size > 12 * 1024 * 1024) {
          stats.cvSkippedLarge++;
        } else {
          const buf  = await readFile(cvPath);
          const name = path.basename(cvPath).replace(/^\d+_/, "");
          if (!DRY_RUN) {
            await prisma.candidateFile.create({
              data: {
                candidateId: existing.id,
                type: "cv",
                filename: name,
                mimeType: mimeFor(name),
                data: buf.toString("base64"),
                size: st.size,
              },
            });
          }
          stats.cvsAttached++;
          stats.cvBytes += st.size;
          didSomething = true;
        }
      } catch (err) {
        stats.cvErrored++;
        console.error(`[fill-dupes] CV attach failed for cid=${cid}: ${err.message}`);
      }
    }
  } else {
    stats.cvAlreadyPresent++;
  }

  if (!didSomething) stats.nothingToFill++;
}

// ─── Driver ────────────────────────────────────────────────────────────────

async function runWithConcurrency(items, n, worker) {
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      await worker(items[idx], idx);
    }
  }));
}

async function main() {
  console.log(`[fill-dupes] csv: ${CSV_PATH}`);
  console.log(`[fill-dupes] cvs: ${CVS_DIR}`);
  console.log(`[fill-dupes] mode: ${DRY_RUN ? "DRY RUN" : "live"} concurrency=${CONCURRENCY}${LIMIT ? ` limit=${LIMIT}` : ""}`);

  const orgId = await resolveOrgId();
  const csvText = await readFile(CSV_PATH, "utf-8");
  let rows = parseCsv(csvText);
  if (LIMIT) rows = rows.slice(0, LIMIT);
  console.log(`[fill-dupes] ${rows.length.toLocaleString()} rows to scan`);

  const cvIndex = await buildCvIndex(CVS_DIR);
  console.log(`[fill-dupes] ${cvIndex.size.toLocaleString()} CV files indexed`);

  const stats = {
    notFound: 0,
    skippedFreshlyImported: 0,
    jobAdderUrlBackfilled: 0,
    cvsAttached: 0,
    cvBytes: 0,
    cvAlreadyPresent: 0,
    noCvAvailable: 0,
    cvSkippedLarge: 0,
    cvErrored: 0,
    nothingToFill: 0,
    errored: 0,
  };

  const started = Date.now();
  let lastTick = 0;
  await runWithConcurrency(rows, CONCURRENCY, async (row, idx) => {
    await fillRow(row, orgId, cvIndex, stats);
    if (idx - lastTick >= 500 || idx === rows.length - 1) {
      lastTick = idx;
      const pct = (((idx + 1) / rows.length) * 100).toFixed(1);
      console.log(`[fill-dupes] ${idx + 1}/${rows.length} (${pct}%) — url-backfilled=${stats.jobAdderUrlBackfilled} cvs-attached=${stats.cvsAttached} cv-already-there=${stats.cvAlreadyPresent}`);
    }
  });

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log("");
  console.log("─".repeat(60));
  console.log(`Done in ${elapsed}s${DRY_RUN ? " (DRY RUN — no writes)" : ""}`);
  console.log("─".repeat(60));
  console.log(`Scanned:                       ${rows.length.toLocaleString()}`);
  console.log(`Freshly imported (no-op):      ${stats.skippedFreshlyImported.toLocaleString()}`);
  console.log(`Records not found at all:      ${stats.notFound.toLocaleString()}`);
  console.log(`jobAdderUrl backfilled:        ${stats.jobAdderUrlBackfilled.toLocaleString()}`);
  console.log(`CVs attached:                  ${stats.cvsAttached.toLocaleString()}  (${(stats.cvBytes / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`  no CV file available:        ${stats.noCvAvailable.toLocaleString()}`);
  console.log(`  CV >12MB skipped:            ${stats.cvSkippedLarge.toLocaleString()}`);
  console.log(`  CV attach errors:            ${stats.cvErrored.toLocaleString()}`);
  console.log(`CV already present (kept):     ${stats.cvAlreadyPresent.toLocaleString()}`);
  console.log(`Existed but nothing to fill:   ${stats.nothingToFill.toLocaleString()}`);
  console.log(`Errored rows:                  ${stats.errored.toLocaleString()}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
