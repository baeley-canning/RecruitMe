#!/usr/bin/env node
/**
 * Backfill Candidate.headline for rows that already have profileText set
 * but whose headline still looks like the JobAdder-CSV import value (i.e.
 * doesn't mention any technical-role keyword).
 *
 * Companion to scripts/extract-cv-text.mjs — that script handles the
 * forward path (extract → derive headline). This one fixes the rows that
 * already had profileText written before the headline-derive feature
 * shipped. Idempotent: re-running over a candidate whose headline now
 * looks correct is a no-op.
 *
 * Dry-run by default — pass --commit to actually update. Per-row decisions
 * are logged so a recruiter can spot-check the diff before live writes.
 *
 * Usage:
 *   node scripts/backfill-cv-headlines.mjs               # plan only
 *   node scripts/backfill-cv-headlines.mjs --commit      # live writes
 *   node scripts/backfill-cv-headlines.mjs --limit 50    # sample run
 *   node scripts/backfill-cv-headlines.mjs --org <orgId> # restrict to one tenant
 *   railway run node scripts/backfill-cv-headlines.mjs   # against prod env
 */

import { PrismaClient } from "@prisma/client";
import {
  deriveHeadlineFromCv,
  existingHeadlineLooksCorrect,
  formatHeadline,
} from "./_cv-headline.mjs";

const prisma = new PrismaClient();

const args = parseArgs(process.argv.slice(2));
const LIMIT       = args.limit ? Number(args.limit) : null;
const CONCURRENCY = args.concurrency ? Number(args.concurrency) : 5;
const COMMIT      = args.commit === true;
const ORG_FILTER  = args.org ?? null;

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
      console.warn(`[headlines] ${label} dropped (${code || "transient"}) — retrying in ${wait}ms`);
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
  console.log(
    `[headlines] mode: ${COMMIT ? "LIVE (writes enabled)" : "DRY RUN (no writes — pass --commit)"} ` +
    `concurrency=${CONCURRENCY}${LIMIT ? ` limit=${LIMIT}` : ""}${ORG_FILTER ? ` org=${ORG_FILTER}` : ""}`,
  );

  // We only care about rows whose CV has been extracted (otherwise the
  // heuristic has nothing to chew on) AND whose existing headline looks
  // suspect. The "looks suspect" check is just `headline IS NULL OR
  // headline NOT ~* '(Engineer|Developer|...)'` — but Postgres regex
  // syntax differs and we'd have to maintain it in two places. Simpler:
  // pull every candidate with profileText set + non-correct headline
  // determined client-side via existingHeadlineLooksCorrect(), and let
  // the heuristic decide.
  //
  // To bound the working set we DO push the "profileText is not empty"
  // predicate into SQL — that's by far the strongest filter.
  console.log("[headlines] querying candidates with profileText set…");
  const targets = await prisma.candidate.findMany({
    where: {
      profileText: { not: null },
      ...(ORG_FILTER ? { orgId: ORG_FILTER } : {}),
    },
    select: {
      id:          true,
      name:        true,
      headline:    true,
      profileText: true,
    },
    ...(LIMIT ? { take: LIMIT } : {}),
    orderBy: { id: "asc" }, // stable for re-runs / partial completions
  });
  console.log(`[headlines] ${targets.length.toLocaleString()} candidates to consider`);

  const stats = {
    scanned: targets.length,
    skippedHeadlineCorrect: 0, // existing headline already mentions Engineer/Developer/etc.
    skippedNoDerive: 0,        // CV text didn't yield a confident match
    skippedSameValue: 0,       // derived headline equal to existing → no-op
    wouldUpdate: 0,            // dry-run only
    updated: 0,                // live writes that landed
    racedSkipped: 0,           // headline changed between query + write
    errored: 0,
  };

  await runWithConcurrency(targets, CONCURRENCY, async (row, idx) => {
    try {
      // Gate #1: protect headlines that already look correct. This is the
      // conservative rule the task calls out — Engineer / Developer /
      // Analyst / etc. in the existing headline means "good enough, leave
      // it alone".
      if (existingHeadlineLooksCorrect(row.headline)) {
        stats.skippedHeadlineCorrect++;
        return;
      }

      // Gate #2: try to derive from the CV. Pure function, no I/O.
      const derived = deriveHeadlineFromCv(row.profileText ?? "");
      if (!derived) {
        stats.skippedNoDerive++;
        return;
      }

      const next = formatHeadline(derived);
      if (next === row.headline) {
        stats.skippedSameValue++;
        return;
      }

      // Reasoning log — one line per decision. Capped to keep stdout
      // useful even on a 10k-row pass.
      const reason =
        row.headline
          ? "existing headline lacks a technical role keyword"
          : "no existing headline set";
      console.log(
        `[headlines] ${row.id} (${row.name}): ${reason}\n` +
        `             old: "${row.headline ?? "(null)"}"\n` +
        `             new: "${next}"`,
      );

      if (!COMMIT) {
        stats.wouldUpdate++;
        return;
      }

      // Race-safe: only update if the headline is still the one we read.
      // A recruiter could have manually fixed it between our query and
      // now — in that case their edit wins.
      const upd = await withDbRetry(
        () => prisma.candidate.updateMany({
          where: { id: row.id, headline: row.headline },
          data:  { headline: next },
        }),
        `update (cid=${row.id})`,
      );
      if (upd.count === 1) stats.updated++;
      else stats.racedSkipped++;
    } catch (err) {
      stats.errored++;
      console.warn(`[headlines] ${row.id} errored: ${err?.message ?? err}`);
    }

    if (idx > 0 && idx % 500 === 0) {
      console.log(`[headlines] progress ${idx}/${targets.length}…`);
    }
  });

  console.log("");
  console.log("─".repeat(60));
  console.log(`Done${COMMIT ? "" : " (DRY RUN — no writes)"}`);
  console.log("─".repeat(60));
  console.log(`Scanned:                       ${stats.scanned.toLocaleString()}`);
  console.log(`Skipped — already-correct:     ${stats.skippedHeadlineCorrect.toLocaleString()}`);
  console.log(`Skipped — no derive from CV:   ${stats.skippedNoDerive.toLocaleString()}`);
  console.log(`Skipped — same value:          ${stats.skippedSameValue.toLocaleString()}`);
  if (COMMIT) {
    console.log(`Updated:                       ${stats.updated.toLocaleString()}`);
    console.log(`Raced (concurrent edit):       ${stats.racedSkipped.toLocaleString()}`);
  } else {
    console.log(`Would update:                  ${stats.wouldUpdate.toLocaleString()}  (rerun with --commit)`);
  }
  console.log(`Errored:                       ${stats.errored.toLocaleString()}`);
}

let shuttingDown = false;
async function gracefulExit(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.warn(`\n[headlines] received ${signal} — shutting down cleanly`);
  try { await prisma.$disconnect(); } catch { /* ignore */ }
  process.exit(130);
}
process.on("SIGINT",  () => gracefulExit("SIGINT"));
process.on("SIGTERM", () => gracefulExit("SIGTERM"));

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
