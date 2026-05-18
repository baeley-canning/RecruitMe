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
import { writeFile, unlink, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import {
  deriveHeadlineFromCv,
  existingHeadlineLooksCorrect,
  formatHeadline,
} from "./_cv-headline.mjs";

const require = createRequire(import.meta.url);
const prisma = new PrismaClient();

// Detect macOS textutil at startup — handles legacy .doc files for free.
// On Linux / Windows this resolves to null and .doc files stay bucketed
// as unsupported (their current behaviour).
const TEXTUTIL_PATH = await detectBin("textutil");
async function detectBin(name) {
  return new Promise((resolve) => {
    const p = spawn("which", [name]);
    let out = "";
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.on("close", (code) => resolve(code === 0 ? out.trim() : null));
    p.on("error", () => resolve(null));
  });
}

const args = parseArgs(process.argv.slice(2));
const LIMIT       = args.limit ? Number(args.limit) : null;
const CONCURRENCY = args.concurrency ? Number(args.concurrency) : 5;
const DRY_RUN     = args["dry-run"] === true;
const ORG_FILTER  = args.org ?? null;
// New "headline-from-CV" feature: derive a better headline from the freshly
// extracted profileText and overwrite the JobAdder-CSV one when it looks
// wrong (e.g. Bede's "High-Performance Coordinator..." → "Junior Software
// Engineer at Integration Technologies Limited"). Default-off so an
// existing extract run keeps doing exactly what it did before; pass
// --commit to enable the headline write. --dry-run still wins (it
// suppresses every write).
const COMMIT_HEADLINE = args.commit === true;

// Bumped from 100 → 200 — the prior threshold let through two near-empty
// CVs (173- and 441-char garbage from heavily-templated docs). 200 still
// keeps a 1-page CV in, but kills genuine OCR noise.
const MIN_USABLE_CHARS = 200;
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

// Legacy .doc (pre-2007 binary format). mammoth + pdf-parse both refuse;
// macOS textutil reads it natively. We spawn one short-lived process per
// file, with a temp-file round-trip because textutil's -stdin path is
// flaky on binary input.
async function extractDocViaTextutil(buffer) {
  if (!TEXTUTIL_PATH) throw new Error("textutil not available (macOS only)");
  const dir  = await mkdtemp(path.join(tmpdir(), "cv-doc-"));
  const docPath = path.join(dir, "in.doc");
  const txtPath = path.join(dir, "in.txt");
  try {
    await writeFile(docPath, buffer);
    await new Promise((resolve, reject) => {
      const p = spawn(TEXTUTIL_PATH, ["-convert", "txt", docPath, "-output", txtPath]);
      let stderr = "";
      p.stderr.on("data", (d) => { stderr += d.toString(); });
      p.on("close", (code) => code === 0 ? resolve() : reject(new Error(`textutil exit ${code}: ${stderr.trim()}`)));
      p.on("error", reject);
    });
    return await readFile(txtPath, "utf-8");
  } finally {
    // rm -rf the whole temp dir — `unlink` left the directory itself behind,
    // and on SIGKILL the temp files would have leaked CV bytes onto /tmp.
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
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
    case "doc_legacy":
      if (!TEXTUTIL_PATH) throw new Error("legacy .doc needs textutil (macOS) — run this on macOS");
      return { text: await extractDocViaTextutil(buf), kind };
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

// Railway's Postgres public proxy closes idle / long-lived connections.
// Retry transient errors a few times with backoff. The transient set was
// broadened after a code review: P2024 (pool timeout) and EAI_AGAIN (DNS
// hiccup) used to slip through. We no longer force $disconnect/$connect —
// at high concurrency that aborted in-flight peer queries and caused
// retry storms. Prisma's pool will replace the poisoned socket on the
// next call by itself.
async function withDbRetry(fn, label) {
  const transient = /P1017|P1001|P1002|P1008|P1011|P2024|Server has closed the connection|connection (?:terminated|closed)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|socket hang up/i;
  let last;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      const msg = err?.message ?? String(err);
      const code = err?.code ?? "";
      if (!transient.test(msg) && !transient.test(code)) throw err;
      const wait = 250 * attempt * attempt; // 250, 1000, 2250, 4000, 6250 ms
      console.warn(`[extract] ${label} dropped (${code || "transient"}) — retrying in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw last;
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[extract] mode: ${DRY_RUN ? "DRY RUN (no writes)" : "live"} concurrency=${CONCURRENCY}${LIMIT ? ` limit=${LIMIT}` : ""}${ORG_FILTER ? ` org=${ORG_FILTER}` : ""}`);
  console.log(`[extract] headline rewrite: ${COMMIT_HEADLINE && !DRY_RUN ? "ENABLED (will overwrite obviously-wrong headlines)" : "dry-run (pass --commit to enable writes)"}`);
  console.log(`[extract] legacy .doc support: ${TEXTUTIL_PATH ? `enabled via ${TEXTUTIL_PATH}` : "DISABLED (textutil not found — .doc files will be skipped)"}`);

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
      // Needed by the headline-rewrite gate: we only override a headline
      // that obviously LACKS a technical role keyword.
      headline: true,
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
    scanned: 0,
    extracted: 0,
    skippedShortText: 0,
    skippedUnsupportedKind: 0,
    errored: 0,
    charsWritten: 0,
    byKind: { pdf: 0, docx: 0, txt: 0, doc_legacy: 0, unknown: 0 },
    // Headline-rewrite counters (independent of profileText path).
    headlineDerived: 0,        // deriveHeadlineFromCv returned non-null
    headlineKeptCorrect: 0,    // existing headline already looked correct — skipped
    headlineUpdated: 0,        // wrote a new headline
    headlineDryRunOnly: 0,     // derived a change but --commit wasn't set
  };
  stats.scanned = targets.length;
  const failures = [];

  const started = Date.now();
  let lastTick = -1;

  await runWithConcurrency(targets, CONCURRENCY, async (row, idx) => {
    const meta = row.files[0];
    if (!meta) { stats.errored++; failures.push({ candidateId: row.id, reason: "no cv file (race?)" }); return; }

    const kind = detectKind(meta.filename, meta.mimeType);
    stats.byKind[kind] = (stats.byKind[kind] ?? 0) + 1;
    // unknown mime + .doc-when-textutil-missing: skip up-front. .doc with
    // textutil present falls through to the normal extraction path.
    const isUnsupportedHere = kind === "unknown" || (kind === "doc_legacy" && !TEXTUTIL_PATH);
    if (isUnsupportedHere) {
      stats.skippedUnsupportedKind++;
      failures.push({ candidateId: row.id, fileId: meta.id, filename: meta.filename, mimeType: meta.mimeType, reason: kind });
      return;
    }

    // Fetch just THIS file's bytes — keeps peak memory ≈ CONCURRENCY × 1 CV.
    const fileWithData = await withDbRetry(
      () => prisma.candidateFile.findUnique({
        where: { id: meta.id },
        select: { data: true },
      }),
      `file fetch (cid=${row.id})`,
    );
    if (!fileWithData?.data) {
      stats.errored++;
      failures.push({ candidateId: row.id, fileId: meta.id, reason: "file data missing" });
      return;
    }
    const file = { ...meta, data: fileWithData.data };

    let text = "";
    try {
      const out = await extractFromFile(file);
      // Strip:
      //   - C0 control bytes that pdf-parse sometimes emits for malformed
      //     PDFs (Postgres TEXT rejects 0x00 outright; the others are noise)
      //   - lone UTF-16 surrogates (0xD800-0xDFFF unpaired) — pdfjs's text
      //     extractor occasionally leaks one mid-string and Postgres'
      //     UTF-8 validator chokes on them
      // Keep \t (0x09) and \n (0x0A).
      text = (out.text ?? "")
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
        .replace(/[\uD800-\uDFFF]/g, "")
        .trim();
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
      // Race-safe: only write if the row STILL has profileText IS NULL.
      // If a recruiter (or LinkedIn capture) populated it between our
      // initial findMany and now, we don't clobber their content.
      // updateMany returns count=0 in that case → bucket as "raced", skip.
      const upd = await withDbRetry(
        () => prisma.candidate.updateMany({
          where: { id: row.id, profileText: null },
          data: {
            profileText:       text,
            profileCapturedAt: new Date(),
            // Clear stale score-cache markers so any next score-all re-runs
            // these candidates against the new full content rather than
            // hitting a stub from the import time.
            profileTextHash:   null,
          },
        }),
        `update (cid=${row.id})`,
      );
      if (upd.count === 0) {
        stats.racedSkipped = (stats.racedSkipped ?? 0) + 1;
        return;
      }
    }
    stats.extracted++;
    stats.charsWritten += text.length;

    // ── Headline rewrite, gated on the new profileText we just wrote.
    // Independent of the profileText write outcome above only conceptually:
    // we still skip the headline path if --dry-run is set (no writes at
    // all in that mode) or if we never got here because the row errored.
    const derived = deriveHeadlineFromCv(text);
    if (derived) {
      stats.headlineDerived++;
      const wantsOverride = !existingHeadlineLooksCorrect(row.headline);
      if (!wantsOverride) {
        stats.headlineKeptCorrect++;
      } else {
        const next = formatHeadline(derived);
        if (next === row.headline) {
          // Already equal — nothing to do.
        } else if (DRY_RUN || !COMMIT_HEADLINE) {
          stats.headlineDryRunOnly++;
          console.log(
            `[headline] DRY ${row.id}: "${row.headline ?? "(null)"}" → "${next}"`,
          );
        } else {
          // Race-safe: only write if the headline is still whatever we
          // observed at query time. If a recruiter edited it in the
          // meantime we leave their value alone.
          const headUpd = await withDbRetry(
            () => prisma.candidate.updateMany({
              where: { id: row.id, headline: row.headline },
              data: { headline: next },
            }),
            `headline update (cid=${row.id})`,
          );
          if (headUpd.count === 1) {
            stats.headlineUpdated++;
            console.log(
              `[headline] ${row.id}: "${row.headline ?? "(null)"}" → "${next}"`,
            );
          }
        }
      }
    }

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
  console.log(`Skipped — raced:          ${(stats.racedSkipped ?? 0).toLocaleString()}  (another writer populated profileText first)`);
  console.log(`Errored:                  ${stats.errored.toLocaleString()}`);
  console.log(`By kind:                  pdf=${stats.byKind.pdf} docx=${stats.byKind.docx} txt=${stats.byKind.txt} doc_legacy=${stats.byKind.doc_legacy} unknown=${stats.byKind.unknown}`);
  console.log(`Headlines derived:        ${stats.headlineDerived.toLocaleString()}  (deriveHeadlineFromCv returned a value)`);
  console.log(`Headlines kept (already correct): ${stats.headlineKeptCorrect.toLocaleString()}`);
  console.log(`Headlines updated:        ${stats.headlineUpdated.toLocaleString()}  ${COMMIT_HEADLINE ? "" : "(would update if --commit was passed)"}`);
  console.log(`Headlines dry-run only:   ${stats.headlineDryRunOnly.toLocaleString()}`);
  if (failures.length > 0 && !DRY_RUN) console.log(`Failures logged to:       ${FAILURES_FILE}`);
}

// Graceful shutdown — close Prisma + write a partial failures file so the
// next re-run starts from a clean state and any /tmp/cv-doc-* dirs created
// inside extractDocViaTextutil have already been rm'd by their finally
// blocks. Without this handler a Ctrl-C would leak DB connections.
let shuttingDown = false;
async function gracefulExit(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.warn(`\n[extract] received ${signal} — shutting down cleanly`);
  try { await prisma.$disconnect(); } catch { /* ignore */ }
  process.exit(130);
}
process.on("SIGINT",  () => gracefulExit("SIGINT"));
process.on("SIGTERM", () => gracefulExit("SIGTERM"));

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
