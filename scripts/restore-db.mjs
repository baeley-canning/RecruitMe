#!/usr/bin/env node
/**
 * Restore a backup produced by scripts/backup-db.mjs.
 *
 * SAFETY RAILS (this writes to a database — treat it like a loaded gun):
 *   • DRY RUN BY DEFAULT. Nothing is written without --apply.
 *   • REFUSES to write into a non-empty database unless --force is given, so a
 *     mistyped URL can't overwrite production.
 *   • Restores in dependency order and uses createMany({skipDuplicates}) so a
 *     partial re-run tops up rather than exploding on primary keys.
 *   • Prints a plan first; you should read it before adding --apply.
 *
 * Usage:
 *   node scripts/restore-db.mjs <file.ndjson.gz>                  # dry run
 *   DATABASE_URL=<TARGET> node scripts/restore-db.mjs <f> --apply # restore
 *
 * The target is ALWAYS taken from DATABASE_URL/DATABASE_PUBLIC_URL — point it
 * at a scratch database for a drill, never at prod by accident.
 */

import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { PrismaClient } from "@prisma/client";

const file = process.argv[2];
const APPLY = process.argv.includes("--apply");
const FORCE = process.argv.includes("--force");
if (!file) { console.error("usage: restore-db.mjs <file.ndjson.gz> [--apply] [--force]"); process.exit(1); }

const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!url) { console.error("No DATABASE_URL — refusing to guess a target."); process.exit(1); }
const prisma = new PrismaClient({ datasources: { db: { url } } });

// Parents before children, so foreign keys resolve. Anything not listed is
// restored afterwards in file order.
const ORDER = [
  "org", "user", "client", "job", "candidateIdentity", "candidate",
  "candidateFile", "candidateIdentityAlias", "candidateIdentityMerge",
  "searchRun", "searchRunResult", "scrapeJob", "watchedSearch",
  "profileUpdateHit", "profileInsight",
];

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

console.log(`target : ${url.replace(/:[^:@/]+@/, ":****@")}`);
console.log(`archive: ${file}`);
console.log(APPLY ? "mode   : APPLY (writes)" : "mode   : DRY RUN (no writes)\n");

// Load the archive into memory grouped by model. 180k rows / ~400MB decoded is
// fine on any dev machine; streaming per-model would complicate ordering.
const byModel = new Map();
const rl = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  let o; try { o = JSON.parse(line); } catch { continue; }
  if (o.__meta) continue;
  if (!byModel.has(o.m)) byModel.set(o.m, []);
  byModel.get(o.m).push(decode(o.r));
}
console.log("archive contents:");
for (const [m, rows] of byModel) console.log(`  ${m.padEnd(24)} ${rows.length}`);

// Non-empty guard — the thing that stops a mistyped URL destroying prod.
let existing = 0;
for (const m of byModel.keys()) {
  try { existing += await prisma[m].count(); } catch { /* model absent in target */ }
}
console.log(`\ntarget currently holds ${existing} rows in these models.`);
if (existing > 0 && APPLY && !FORCE) {
  console.error("REFUSING: target is not empty. Re-run with --force if you really mean it.");
  await prisma.$disconnect();
  process.exit(1);
}

if (!APPLY) {
  console.log("\n(dry run — re-run with --apply to write)");
  await prisma.$disconnect();
  process.exit(0);
}

const order = [...ORDER.filter((m) => byModel.has(m)), ...[...byModel.keys()].filter((m) => !ORDER.includes(m))];
let written = 0;
for (const model of order) {
  const rows = byModel.get(model) ?? [];
  if (rows.length === 0) continue;
  let n = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    try {
      const r = await prisma[model].createMany({ data: chunk, skipDuplicates: true });
      n += r.count;
    } catch (err) {
      // One bad chunk shouldn't abandon the restore — fall back to row-by-row
      // so we salvage everything that CAN be written, and report what can't.
      for (const row of chunk) {
        try { await prisma[model].create({ data: row }); n++; } catch { /* skip */ }
      }
      console.warn(`  ! ${model}: chunk fell back to row-by-row (${err.message.split("\n")[0]})`);
    }
  }
  written += n;
  console.log(`  ${model.padEnd(24)} restored ${n}/${rows.length}`);
}
console.log(`\nDONE — ${written} rows restored.`);
await prisma.$disconnect();
