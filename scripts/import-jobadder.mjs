#!/usr/bin/env node
/**
 * One-off importer for JobAdder candidates → RecruitMe library.
 *
 * Reads the CSV produced by /Users/baeley/jobadder_exporter/exporter.py
 * plus the matching cvs/ directory, and inserts each candidate into the
 * RecruitMe library (Candidate rows with jobId=null, orgId set).
 *
 * Dedupe:
 *   - within import: each row's candidateID is unique (the exporter
 *     guarantees this after the pagination fix)
 *   - against existing library: skip when there's already a Candidate in
 *     the same orgId with matching normalised linkedinUrl OR matching
 *     jobAdderUrl. Re-runs of this script are idempotent.
 *
 * CV upload: if cvs/{candidateID}_*.* exists for the row, it's loaded,
 * base64-encoded, and inserted as a CandidateFile of type="cv".
 *
 * Usage:
 *   node scripts/import-jobadder.mjs \
 *     --csv /Users/baeley/jobadder_exporter/output/candidates_<ts>.csv \
 *     --cvs /Users/baeley/jobadder_exporter/output/cvs \
 *     [--org <orgId>]   (default: auto-resolve single-org deployment)
 *     [--dry-run]       (print plan, no writes)
 *     [--limit N]       (process only the first N rows — test runs)
 *     [--concurrency N] (default 5)
 */

import { PrismaClient } from "@prisma/client";
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const prisma = new PrismaClient();

// ─── CLI parsing ───────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
if (!args.csv || !args.cvs) {
  console.error("Required: --csv <path> --cvs <dir>");
  process.exit(2);
}
const CSV_PATH = args.csv;
const CVS_DIR  = args.cvs;
const LIMIT    = args.limit ? Number(args.limit) : null;
const CONCURRENCY = args.concurrency ? Number(args.concurrency) : 5;
const DRY_RUN  = args["dry-run"] === true;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) { out[key] = true; }
    else { out[key] = next; i++; }
  }
  return out;
}

// ─── Resolve orgId ─────────────────────────────────────────────────────────

async function resolveOrgId() {
  if (args.org) return args.org;
  const orgs = await prisma.org.findMany({ select: { id: true, name: true } });
  if (orgs.length === 0) {
    console.error("No orgs exist in DB. Create one before importing.");
    process.exit(1);
  }
  if (orgs.length > 1) {
    console.error(`Multiple orgs found — pass --org <id>. Orgs: ${orgs.map(o => `${o.id} (${o.name})`).join(", ")}`);
    process.exit(1);
  }
  console.log(`[import] auto-resolved orgId=${orgs[0].id} (${orgs[0].name})`);
  return orgs[0].id;
}

// ─── CSV parsing (RFC 4180-ish, handles quoted fields + embedded commas/quotes) ─

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
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

// ─── Helpers ───────────────────────────────────────────────────────────────

// Mirrors src/lib/linkedin.ts:normaliseLinkedInUrl. Reimplemented inline so
// this .mjs has no TS-compile dependency.
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
  const ext = path.extname(filename).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

function buildLocation(suburb, state, postcode, country) {
  return [suburb, state, postcode, country].filter((s) => s && s.trim()).join(", ") || null;
}

function buildHeadline(position, employer) {
  if (position && employer) return `${position} at ${employer}`;
  return position || employer || null;
}

function buildNotes(row) {
  // Preserve everything we can't fold into a real column so the import is
  // lossless — the recruiter can read it on the candidate card.
  const lines = [];
  lines.push(`[Imported from JobAdder ${new Date().toISOString().slice(0,10)} — id ${row.candidateID}]`);
  if (row.email) lines.push(`Email: ${row.email}`);
  if (row.status_name) lines.push(`JobAdder pipeline status: ${row.status_name}`);
  if (row.seeking_status) lines.push(`Seeking: ${row.seeking_status}`);
  if (row.availability_type && row.availability_type !== "NotSpecified") {
    lines.push(`Availability: ${row.availability_type}${row.availability_date ? ` (${row.availability_date})` : ""}`);
  }
  if (row.dateResumeUpdated) lines.push(`Resume last updated: ${row.dateResumeUpdated}`);
  if (row.talentPoolIDs) lines.push(`JobAdder talent pools: ${row.talentPoolIDs}`);
  return lines.join("\n");
}

function buildFirmableData(row) {
  // Stash structured contact data + the full socialLinks blob in the same
  // field Firmable uses, so existing UI that reads firmableData picks them up.
  const data = {};
  if (row.email) data.email = row.email;
  if (row.phone) data.phone = row.phone;
  if (row.mobile) data.mobile = row.mobile;
  if (row.socialLinks_json) {
    try { data.socialLinks = JSON.parse(row.socialLinks_json); } catch { /* ignore */ }
  }
  data._source = "jobadder_import";
  return JSON.stringify(data);
}

// ─── CV file lookup ────────────────────────────────────────────────────────

async function buildCvIndex(cvsDir) {
  if (!existsSync(cvsDir)) {
    console.warn(`[import] CV directory not found: ${cvsDir} — candidates will import without CVs`);
    return new Map();
  }
  const files = await readdir(cvsDir);
  const idx = new Map();
  for (const f of files) {
    const underscore = f.indexOf("_");
    if (underscore < 1) continue;
    const cid = f.slice(0, underscore);
    if (!/^\d+$/.test(cid)) continue;
    // First-write-wins; the exporter only writes one file per cid anyway.
    if (!idx.has(cid)) idx.set(cid, path.join(cvsDir, f));
  }
  return idx;
}

// ─── Existence check ───────────────────────────────────────────────────────

async function findExisting(orgId, linkedinUrl, jobAdderUrl) {
  const or = [];
  if (linkedinUrl) or.push({ linkedinUrl });
  if (jobAdderUrl) or.push({ jobAdderUrl });
  if (or.length === 0) return null;
  return prisma.candidate.findFirst({
    where: { orgId, OR: or },
    select: { id: true, name: true, linkedinUrl: true, jobAdderUrl: true },
  });
}

// ─── Per-row work ──────────────────────────────────────────────────────────

async function importRow(row, orgId, cvIndex, stats) {
  const cid = (row.candidateID || "").trim();
  if (!cid) { stats.errored++; return; }

  const linkedinUrl = row.linkedInUrl ? normaliseLinkedInUrl(row.linkedInUrl) : null;
  const jobAdderUrl = `https://au6.jobadder.com/candidates/${cid}`;

  // Dedup against existing library.
  const existing = await findExisting(orgId, linkedinUrl, jobAdderUrl);
  if (existing) {
    stats.duplicates++;
    return;
  }

  const name = (row.name || `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim() || `JobAdder ${cid}`).trim();

  const data = {
    orgId,
    jobId: null,
    name,
    headline:    buildHeadline(row.currentPosition, row.currentEmployer),
    location:    buildLocation(row.address_suburb, row.address_state, row.address_postcode, row.address_country),
    linkedinUrl,
    jobAdderUrl,
    phone:       row.mobile?.trim() || row.phone?.trim() || null,
    firmableData: buildFirmableData(row),
    notes:       buildNotes(row),
    source:      "jobadder_import",
  };

  if (DRY_RUN) {
    stats.created++;
    return;
  }

  let candidateId;
  try {
    const created = await prisma.candidate.create({ data, select: { id: true } });
    candidateId = created.id;
    stats.created++;
  } catch (err) {
    stats.errored++;
    console.error(`[import] failed to create candidate for cid=${cid}: ${err.message}`);
    return;
  }

  // CV upload — best-effort, doesn't fail the candidate insert.
  const cvPath = cvIndex.get(cid);
  if (!cvPath) { stats.noCv++; return; }
  try {
    const st = await stat(cvPath);
    if (st.size > 12 * 1024 * 1024) {
      // The web UI rejects > 10MB. Anything past 12 here we silently skip
      // rather than blow up the row.
      stats.cvSkippedLarge++;
      return;
    }
    const buf  = await readFile(cvPath);
    const b64  = buf.toString("base64");
    const name = path.basename(cvPath).replace(/^\d+_/, ""); // strip the cid_ prefix
    await prisma.candidateFile.create({
      data: {
        candidateId,
        type: "cv",
        filename: name,
        mimeType: mimeFor(name),
        data: b64,
        size: st.size,
      },
    });
    stats.cvsUploaded++;
    stats.cvBytes += st.size;
  } catch (err) {
    stats.cvErrored++;
    console.error(`[import] CV upload failed for cid=${cid}: ${err.message}`);
  }
}

// ─── Concurrency-bounded driver ───────────────────────────────────────────

async function runWithConcurrency(items, n, worker) {
  let next = 0;
  const workers = Array.from({ length: n }, async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[import] csv:    ${CSV_PATH}`);
  console.log(`[import] cvs:    ${CVS_DIR}`);
  console.log(`[import] mode:   ${DRY_RUN ? "DRY RUN (no writes)" : "live"}`);
  if (LIMIT) console.log(`[import] limit:  ${LIMIT}`);
  console.log(`[import] concur: ${CONCURRENCY}`);

  const orgId = await resolveOrgId();

  console.log("[import] reading CSV…");
  const csvText = await readFile(CSV_PATH, "utf-8");
  let rows = parseCsv(csvText);
  if (LIMIT) rows = rows.slice(0, LIMIT);
  console.log(`[import] ${rows.length.toLocaleString()} rows to process`);

  console.log("[import] indexing CVs…");
  const cvIndex = await buildCvIndex(CVS_DIR);
  console.log(`[import] ${cvIndex.size.toLocaleString()} CV files indexed`);

  const stats = {
    created: 0, duplicates: 0, errored: 0,
    cvsUploaded: 0, noCv: 0, cvSkippedLarge: 0, cvErrored: 0, cvBytes: 0,
  };

  const started = Date.now();
  let lastTick = 0;
  await runWithConcurrency(rows, CONCURRENCY, async (row, idx) => {
    await importRow(row, orgId, cvIndex, stats);
    if (idx - lastTick >= 100 || idx === rows.length - 1) {
      lastTick = idx;
      const pct = (((idx + 1) / rows.length) * 100).toFixed(1);
      console.log(`[import] ${idx + 1}/${rows.length} (${pct}%) — created=${stats.created} dupes=${stats.duplicates} cvs=${stats.cvsUploaded} err=${stats.errored}`);
    }
  });

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log("");
  console.log("─".repeat(60));
  console.log(`Done in ${elapsed}s${DRY_RUN ? " (DRY RUN — no writes)" : ""}`);
  console.log("─".repeat(60));
  console.log(`Candidates created:    ${stats.created.toLocaleString()}`);
  console.log(`  duplicates skipped:  ${stats.duplicates.toLocaleString()}`);
  console.log(`  errors:              ${stats.errored.toLocaleString()}`);
  console.log(`CVs uploaded:          ${stats.cvsUploaded.toLocaleString()}  (${(stats.cvBytes / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`  no CV file:          ${stats.noCv.toLocaleString()}`);
  console.log(`  skipped (>12MB):     ${stats.cvSkippedLarge.toLocaleString()}`);
  console.log(`  upload errors:       ${stats.cvErrored.toLocaleString()}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
