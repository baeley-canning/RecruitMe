#!/usr/bin/env node
/**
 * Off-Railway logical backup — gzipped NDJSON, one file per run.
 *
 * WHY THIS EXISTS: on 2026-07-28 an audit found the production volume had ZERO
 * Railway backup schedules and ZERO backups. 16,772 candidates / 2,493
 * identities / 13,520 CV records — the entire business asset — sat on a single
 * volume with nothing to restore from. This is the vendor-independent copy.
 *
 * Deliberately uses Prisma rather than pg_dump: this machine has no Postgres
 * client tools, and going through the schema means the backup automatically
 * covers every model — a new table can't be silently missed.
 *
 * Format: one line of JSON per row, prefixed by a `__meta` line per table.
 * Values are encoded losslessly (Date → {__t:"d"}, BigInt → {__t:"n"}) so a
 * restore reproduces types exactly.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/backup-db.mjs [outDir]
 *   (via Railway:  railway run --service Postgres node scripts/backup-db.mjs)
 *
 * Restore/verify with scripts/verify-backup.mjs.
 */

import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import path from "node:path";
import os from "node:os";
import { PrismaClient } from "@prisma/client";

const OUT_DIR = process.argv[2] || path.join(os.homedir(), "recruitme-backups");
const BATCH = 500;

const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!url) {
  console.error("No DATABASE_URL / DATABASE_PUBLIC_URL in the environment.");
  process.exit(1);
}
const prisma = new PrismaClient({ datasources: { db: { url } } });

/** Lossless JSON encoding for the types Prisma hands back. */
function encode(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return { __t: "d", v: value.toISOString() };
  if (typeof value === "bigint") return { __t: "n", v: value.toString() };
  if (Buffer.isBuffer(value)) return { __t: "b", v: value.toString("base64") };
  if (Array.isArray(value)) return value.map(encode);
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = encode(v);
    return out;
  }
  return value;
}

/** Model names straight from the generated client, so nothing is missed. */
function modelNames() {
  const dmmf = prisma._runtimeDataModel?.models ?? {};
  return Object.keys(dmmf).map((m) => m.charAt(0).toLowerCase() + m.slice(1));
}

async function* rowsFor(model) {
  let cursorSkip = 0;
  for (;;) {
    const batch = await prisma[model].findMany({ skip: cursorSkip, take: BATCH });
    if (batch.length === 0) return;
    for (const row of batch) yield row;
    cursorSkip += batch.length;
    if (batch.length < BATCH) return;
  }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(OUT_DIR, `recruitme-${stamp}.ndjson.gz`);
  const models = modelNames();
  console.log(`[backup] ${models.length} models → ${file}`);

  const counts = {};
  async function* lines() {
    yield JSON.stringify({ __meta: "backup", startedAt: new Date().toISOString(), models }) + "\n";
    for (const model of models) {
      let n = 0;
      yield JSON.stringify({ __meta: "table", model }) + "\n";
      try {
        for await (const row of rowsFor(model)) {
          yield JSON.stringify({ m: model, r: encode(row) }) + "\n";
          n++;
          if (n % 2000 === 0) console.log(`  ${model}: ${n}…`);
        }
      } catch (err) {
        // A model the client knows but the DB lacks (drift) must not abort the
        // whole backup — record it and carry on.
        console.warn(`  ! ${model}: ${err.message.split("\n")[0]}`);
      }
      counts[model] = n;
      if (n > 0) console.log(`  ${model}: ${n} rows`);
    }
    yield JSON.stringify({ __meta: "end", counts, finishedAt: new Date().toISOString() }) + "\n";
  }

  await pipeline(Readable.from(lines()), createGzip({ level: 6 }), createWriteStream(file));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`[backup] DONE — ${total} rows across ${Object.keys(counts).length} models`);
  console.log(`[backup] file: ${file}`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[backup] FAILED:", err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
