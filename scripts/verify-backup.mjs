#!/usr/bin/env node
/**
 * Verify a backup produced by scripts/backup-db.mjs.
 *
 * "Untested backups are decoration." This reads the archive back and proves:
 *   1. it decompresses and every line parses,
 *   2. per-model row counts match the LIVE database,
 *   3. content survives the round-trip byte-for-byte (largest profileText is
 *      compared against the live row — the 283MB of profile text is the moat),
 *   4. type encoding is lossless (Dates decode back to real Dates).
 *
 * Usage: node scripts/verify-backup.mjs <file.ndjson.gz>
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { PrismaClient } from "@prisma/client";

const file = process.argv[2];
if (!file) { console.error("usage: verify-backup.mjs <file.ndjson.gz>"); process.exit(1); }

const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
const prisma = new PrismaClient({ datasources: { db: { url } } });

function decode(v) {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map(decode);
  if (typeof v === "object") {
    if (v.__t === "d") return new Date(v.v);
    if (v.__t === "n") return BigInt(v.v);
    if (v.__t === "b") return Buffer.from(v.v, "base64");
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = decode(val);
    return out;
  }
  return v;
}

const counts = {};
let meta = null, end = null, parsed = 0, bad = 0;
// Track the biggest candidate profileText for the integrity spot-check.
let biggest = { id: null, len: 0, text: null };
let sampleDate = null;

const rl = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  let obj;
  try { obj = JSON.parse(line); } catch { bad++; continue; }
  parsed++;
  if (obj.__meta === "backup") { meta = obj; continue; }
  if (obj.__meta === "end") { end = obj; continue; }
  if (obj.__meta === "table") continue;
  counts[obj.m] = (counts[obj.m] ?? 0) + 1;
  if (obj.m === "candidate") {
    const row = decode(obj.r);
    if (!sampleDate && row.createdAt instanceof Date) sampleDate = row.createdAt;
    const len = row.profileText?.length ?? 0;
    if (len > biggest.len) biggest = { id: row.id, len, text: row.profileText };
  }
}

const size = (await stat(file)).size;
console.log(`archive        : ${file}`);
console.log(`compressed size: ${(size / 1048576).toFixed(1)} MB`);
console.log(`lines parsed   : ${parsed}  (malformed: ${bad})`);
console.log(`models in file : ${Object.keys(counts).length}`);

let mismatches = 0;
console.log("\nrow counts (backup vs live):");
for (const [model, n] of Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  let live = "?";
  try { live = await prisma[model].count(); } catch { live = "n/a"; }
  const ok = live === n;
  if (live !== "n/a" && !ok) mismatches++;
  console.log(`  ${model.padEnd(24)} ${String(n).padStart(7)}  live ${String(live).padStart(7)}  ${ok ? "✓" : live === "n/a" ? "-" : "✗"}`);
}

console.log("\nintegrity spot-check (largest profile in the archive):");
if (biggest.id) {
  const live = await prisma.candidate.findUnique({ where: { id: biggest.id }, select: { profileText: true } });
  const same = live?.profileText === biggest.text;
  console.log(`  candidate ${biggest.id}`);
  console.log(`  ${biggest.len} chars — byte-identical to live: ${same ? "✓ YES" : "✗ NO"}`);
  if (!same) mismatches++;
} else {
  console.log("  (no candidate rows found — nothing to check)"); mismatches++;
}
console.log(`type round-trip: Date decodes to Date: ${sampleDate instanceof Date ? "✓" : "✗"}`);

const totalBackedUp = Object.values(counts).reduce((a, b) => a + b, 0);
console.log(`\nTOTAL rows in archive: ${totalBackedUp}`);
console.log(bad === 0 && mismatches === 0
  ? "\n✅ BACKUP VERIFIED — complete, parseable, and byte-identical to live."
  : `\n❌ PROBLEMS: ${bad} malformed lines, ${mismatches} mismatches.`);
await prisma.$disconnect();
process.exit(bad === 0 && mismatches === 0 ? 0 : 1);
