#!/usr/bin/env node
/**
 * Backfill Candidate.profileText from attached CV files (JobAdder bulk import).
 *
 * 13.5k candidates from the JobAdder import have a CV blob attached but no
 * extracted profileText — which means: search anchors skip them, scoring
 * has no content to evaluate, and the candidate-library "captured profile"
 * gates exclude them. This script reads each CV, runs the same PDF/DOCX
 * extraction the upload route already uses, and writes the text back.
 *
 * Idempotent — skips rows where profileText is already non-null. Safe to
 * re-run after a partial run.
 *
 * Usage:
 *   node scripts/extract-cv-text.mjs              # full run, concurrency 5
 *   node scripts/extract-cv-text.mjs --limit 20 --dry-run
 *   railway run node scripts/extract-cv-text.mjs  # against prod env vars
 */

import { PrismaClient } from "@prisma/client";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const prisma = new PrismaClient();

const args = parseArgs(process.argv.slice(2));
const LIMIT       = args.limit ? Number(args.limit) : null;
const CONCURRENCY = args.concurrency ? Number(args.concurrency) : 5;
const DRY_RUN     = args["dry-run"] === true;
const ORG_FILTER  = args.org ?? null;

const MIN_USABLE_CHARS = 100;  // below this we assume image-only PDF / extraction failure
const FAILURES_FILE = path.join(process.cwd(), "extract-cv-failures.json");

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

// ─── PDF extraction (mirrors src/lib/pdf.ts) ───────────────────────────────

const PDF_VERSIONS = ["v2.0.550", "v1.10.100", "v1.10.88", "v1.9.426"];

async function extractPdf(buffer) {
  const pdfParse = require("pdf-parse");
  let lastError;
  for (const version of PDF_VERSIONS) {
    try {
      const data = await pdfParse(buffer, { version });
      const text = (data?.text ?? "");
      if (text.trim().length > 0) return text;
    } catch (err) { lastError = err; }
  }
  throw lastError ?? new Error("All PDF parsing attempts failed");
}

async function extractDocx(buffer) {
  const mammoth = require("mammoth");
  const result = await mammoth.extractRawText({ buffer });
  return result.value ?? "";
}

// ─── Per-file dispatch ─────────────────────────────────────────────────────

function detectKind(filename, mimeType) {
  const ext = (path.extname(filename ?? "") || "").toLowerCase();
  const mt  = (mimeType ?? "").toLowerCase();
  if (mt === "application/pdf" || ext === ".pdf") return "pdf";
  if (mt.includes("wordprocessingml") || ext === ".docx") return "docx";
  if (mt === "text/plain" || ext === ".txt") return "txt";
  // legacy .doc — mammoth doesn't support it, pdf-parse won't either.
  if (mt === "application/msword" || ext === ".doc") return "doc_legacy";
  return "unknown";
}

async function extractFromFile(file) {
  const buf  = Buffer.from(file.data, "base64");
  const kind = detectKind(file.filename, file.mimeType);
  switch (kind) {
    case "pdf":        return { text: await extractPdf(buf),  kind };
    case "docx":       return { text: await extractDocx(buf), kind };
    case "txt":        return { text: buf.toString("utf-8"),  kind };
    case "doc_legacy": throw new Error("legacy .doc not supported (mammoth only handles .docx)");
    default:           throw new Error(`unsupported file type — mimeType="${file.mimeType}" filename="${file.filename}"`);
  }
}

// ─── Concurrency driver ────────────────────────────────────────────────────

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

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[extract] mode: ${DRY_RUN ? "DRY RUN (no writes)" : "live"} concurrency=${CONCURRENCY}${LIMIT ? ` limit=${LIMIT}` : ""}${ORG_FILTER ? ` org=${ORG_FILTER}` : ""}`);

  // Pull candidate IDs + file metadata only — NOT the file bytes. Loading
  // 12k × ~270KB base64 strings in one query crashes Prisma's Rust→JS
  // serialiser ("Failed to convert rust String into napi string"). Each
  // worker fetches the bytes for its own row via a second query.
  console.log("[extract] querying candidates needing extraction…");
  const targets = await prisma.candidate.findMany({
    where: {
      source:      "jobadder_import",
      profileText: null,
      ...(ORG_FILTER ? { orgId: ORG_FILTER } : {}),
      files:       { some: { type: "cv" } },
    },
    select: {
      id: true,
      files: {
        where: { type: "cv" },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { id: true, filename: true, mimeType: true, size: true },
      },
    },
    ...(LIMIT ? { take: LIMIT } : {}),
  });
  console.log(`[extract] ${targets.length.toLocaleString()} candidates to process`);

  const stats = {
    scanned: targets.length,
    extracted: 0,
    skippedShortText: 0,
    skippedUnsupportedKind: 0,
    errored: 0,
    charsWritten: 0,
    byKind: { pdf: 0, docx: 0, txt: 0, doc_legacy: 0, unknown: 0 },
  };
  const failures = [];

  const started = Date.now();
  let lastTick = -1;

  await runWithConcurrency(targets, CONCURRENCY, async (row, idx) => {
    const meta = row.files[0];
    if (!meta) { stats.errored++; failures.push({ candidateId: row.id, reason: "no cv file (race?)" }); return; }

    const kind = detectKind(meta.filename, meta.mimeType);
    stats.byKind[kind] = (stats.byKind[kind] ?? 0) + 1;
    if (kind === "doc_legacy" || kind === "unknown") {
      stats.skippedUnsupportedKind++;
      failures.push({ candidateId: row.id, fileId: meta.id, filename: meta.filename, mimeType: meta.mimeType, reason: kind });
      return;
    }

    // Fetch just THIS file's bytes — keeps peak memory ≈ CONCURRENCY × 1 CV.
    const fileWithData = await prisma.candidateFile.findUnique({
      where: { id: meta.id },
      select: { data: true },
    });
    if (!fileWithData?.data) {
      stats.errored++;
      failures.push({ candidateId: row.id, fileId: meta.id, reason: "file data missing" });
      return;
    }
    const file = { ...meta, data: fileWithData.data };

    let text = "";
    try {
      const out = await extractFromFile(file);
      text = (out.text ?? "").trim();
    } catch (err) {
      stats.errored++;
      failures.push({
        candidateId: row.id, fileId: file.id, filename: file.filename, mimeType: file.mimeType,
        reason: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (text.length < MIN_USABLE_CHARS) {
      stats.skippedShortText++;
      failures.push({
        candidateId: row.id, fileId: file.id, filename: file.filename, mimeType: file.mimeType,
        reason: `extracted ${text.length} chars (< ${MIN_USABLE_CHARS}) — likely image-only / scanned`,
      });
      return;
    }

    if (!DRY_RUN) {
      await prisma.candidate.update({
        where: { id: row.id },
        data: {
          profileText:       text,
          profileCapturedAt: new Date(),
          // Clear stale score-cache markers so any next score-all re-runs
          // these candidates against the new full content rather than
          // hitting a stub from the import time.
          profileTextHash:   null,
        },
      });
    }
    stats.extracted++;
    stats.charsWritten += text.length;

    if (idx - lastTick >= 250 || idx === targets.length - 1) {
      lastTick = idx;
      const pct = (((idx + 1) / targets.length) * 100).toFixed(1);
      console.log(`[extract] ${idx + 1}/${targets.length} (${pct}%) — extracted=${stats.extracted} errored=${stats.errored} short=${stats.skippedShortText}`);
    }
  });

  if (failures.length > 0 && !DRY_RUN) {
    await writeFile(FAILURES_FILE, JSON.stringify(failures, null, 2), "utf-8");
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log("");
  console.log("─".repeat(60));
  console.log(`Done in ${elapsed}s${DRY_RUN ? " (DRY RUN — no writes)" : ""}`);
  console.log("─".repeat(60));
  console.log(`Scanned:                  ${stats.scanned.toLocaleString()}`);
  console.log(`Extracted + written:      ${stats.extracted.toLocaleString()}`);
  console.log(`Chars written:            ${stats.charsWritten.toLocaleString()}`);
  console.log(`Skipped — too short:      ${stats.skippedShortText.toLocaleString()}  (likely image-only / scanned PDFs)`);
  console.log(`Skipped — unsupported:    ${stats.skippedUnsupportedKind.toLocaleString()}  (legacy .doc or unknown mime)`);
  console.log(`Errored:                  ${stats.errored.toLocaleString()}`);
  console.log(`By kind:                  pdf=${stats.byKind.pdf} docx=${stats.byKind.docx} txt=${stats.byKind.txt} doc_legacy=${stats.byKind.doc_legacy} unknown=${stats.byKind.unknown}`);
  if (failures.length > 0 && !DRY_RUN) console.log(`Failures logged to:       ${FAILURES_FILE}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
