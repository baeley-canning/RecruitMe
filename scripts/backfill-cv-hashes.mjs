#!/usr/bin/env node
/**
 * One-off backfill for CandidateFile.dataHash.
 *
 * The column was added in commit 155c0b0 to replace the duplicate-check
 * loop that loaded every existing file's base64 blob into memory. New
 * uploads set dataHash on insert; the upload route's fallback path also
 * lazily backfills any legacy row it encounters during a duplicate
 * check. This script eagerly backfills the rest so the slow fallback
 * path never has to run.
 *
 * Mirrors the existing extract-cv-text.mjs patterns:
 *   - per-row data fetch (never load all blobs into one query)
 *   - race-safe write (updateMany WHERE dataHash IS NULL)
 *   - retry on transient Postgres proxy drops
 *   - SIGINT/SIGTERM clean shutdown
 *
 * Usage:
 *   node scripts/backfill-cv-hashes.mjs              # full run
 *   node scripts/backfill-cv-hashes.mjs --limit 100  # test
 *   node scripts/backfill-cv-hashes.mjs --dry-run    # plan only
 *   railway run node scripts/backfill-cv-hashes.mjs  # against prod env
 */

import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";

const prisma = new PrismaClient();

const args = parseArgs(process.argv.slice(2));
const LIMIT       = args.limit ? Number(args.limit) : null;
const CONCURRENCY = args.concurrency ? Number(args.concurrency) : 10;
const DRY_RUN     = args["dry-run"] === true;

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

// Mirrors extract-cv-text.mjs#withDbRetry — same transient set, no
// $disconnect during retry (Prisma's pool recycles by itself).
async function withDbRetry(fn, label) {
  const transient = /P1017|P1001|P1002|P1008|P1011|P2024|Server has closed the connection|connection (?:terminated|closed)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|socket hang up/i;
  let last;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try { return await fn(); }
    catch (err) {
      last = err;
      const msg = err?.message ?? String(err);
      const code = err?.code ?? "";
      if (!transient.test(msg) && !transient.test(code)) throw err;
      const wait = 250 * attempt * attempt;
      console.warn(`[backfill] ${label} dropped (${code || "transient"}) — retrying in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw last;
}

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
  console.log(`[backfill] mode: ${DRY_RUN ? "DRY RUN (no writes)" : "live"} concurrency=${CONCURRENCY}${LIMIT ? ` limit=${LIMIT}` : ""}`);

  // IDs only — no `data` field. We fetch the blob per worker.
  const targets = await prisma.candidateFile.findMany({
    where: { dataHash: null },
    select: { id: true },
    ...(LIMIT ? { take: LIMIT } : {}),
    orderBy: { id: "asc" }, // stable; no createdAt-tie issue at this scale
  });
  console.log(`[backfill] ${targets.length.toLocaleString()} files need a hash`);

  if (targets.length === 0) {
    console.log("[backfill] nothing to do — all rows already hashed");
    await prisma.$disconnect();
    return;
  }

  const stats = { hashed: 0, skippedRaced: 0, errored: 0 };
  const started = Date.now();
  let lastTick = -1;

  await runWithConcurrency(targets, CONCURRENCY, async (row, idx) => {
    // Fetch just this file's bytes.
    const file = await withDbRetry(
      () => prisma.candidateFile.findUnique({
        where: { id: row.id },
        select: { data: true },
      }),
      `fetch ${row.id}`,
    );
    if (!file?.data) { stats.errored++; return; }

    const buf = Buffer.from(file.data, "base64");
    const hash = createHash("sha256").update(buf).digest("hex").slice(0, 32);

    if (DRY_RUN) {
      stats.hashed++;
      return;
    }

    // Race-safe: only write if STILL null. Avoids clobbering a hash
    // someone else (e.g. the upload route's lazy backfill) set in the
    // meantime.
    const upd = await withDbRetry(
      () => prisma.candidateFile.updateMany({
        where: { id: row.id, dataHash: null },
        data: { dataHash: hash },
      }),
      `update ${row.id}`,
    );
    if (upd.count === 1) stats.hashed++;
    else stats.skippedRaced++;

    if (idx - lastTick >= 500 || idx === targets.length - 1) {
      lastTick = idx;
      const pct = (((idx + 1) / targets.length) * 100).toFixed(1);
      console.log(`[backfill] ${idx + 1}/${targets.length} (${pct}%) — hashed=${stats.hashed} raced=${stats.skippedRaced} err=${stats.errored}`);
    }
  });

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log("");
  console.log("─".repeat(60));
  console.log(`Done in ${elapsed}s${DRY_RUN ? " (DRY RUN — no writes)" : ""}`);
  console.log("─".repeat(60));
  console.log(`Scanned:                  ${targets.length.toLocaleString()}`);
  console.log(`Hashed + written:         ${stats.hashed.toLocaleString()}`);
  console.log(`Skipped — raced:          ${stats.skippedRaced.toLocaleString()}  (concurrent writer beat us)`);
  console.log(`Errored:                  ${stats.errored.toLocaleString()}`);
}

let shuttingDown = false;
async function gracefulExit(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.warn(`\n[backfill] received ${signal} — shutting down cleanly`);
  try { await prisma.$disconnect(); } catch { /* ignore */ }
  process.exit(130);
}
process.on("SIGINT",  () => gracefulExit("SIGINT"));
process.on("SIGTERM", () => gracefulExit("SIGTERM"));

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
