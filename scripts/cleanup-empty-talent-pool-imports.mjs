#!/usr/bin/env node
/**
 * Clean up empty-profile talent_pool candidates that landed on real jobs.
 *
 * The "Bede problem" recap: when scripts/import-jobadder.mjs ran without
 * a CV on disk for a JobAdder candidate, the row was still created with
 * `source` set + `profileText: null`. Later, when a recruiter pulled the
 * candidate from the library into a job (via browse-library-modal), a
 * new per-job row was created with `source: "talent_pool"` and the empty
 * profileText was inherited. Those per-job stubs clutter the shortlist
 * and the scoring pipeline can't do anything with them.
 *
 * This script finds those per-job stubs and stages them for deletion,
 * while NEVER touching the library source row (jobId IS NULL). The
 * source row stays so the recruiter can re-import after the missing
 * CVs are backfilled.
 *
 * Safety rails:
 *   - DEFAULT IS DRY-RUN. Nothing is deleted unless you pass --commit.
 *   - We SKIP any candidate whose status indicates recruiter intent:
 *     "shortlisted", "contacted", "interviewing", "offer_sent", "hired".
 *   - We also SKIP if contactedAt is set or any ContactEvent exists for
 *     the candidate — those are explicit "I touched this person" signals.
 *
 * Usage:
 *   node scripts/cleanup-empty-talent-pool-imports.mjs              # dry run
 *   node scripts/cleanup-empty-talent-pool-imports.mjs --commit     # delete
 *   railway run node scripts/cleanup-empty-talent-pool-imports.mjs --commit
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const args = parseArgs(process.argv.slice(2));
const COMMIT = args.commit === true;
const SHORT_THRESHOLD = 500; // chars — matches diagnose-empty-library.mjs

// status values that mean "the recruiter has invested in this candidate".
// If a row carries any of these we will NOT delete it even if profileText
// is empty — the recruiter can clean it up by hand. Keep this list in sync
// with the Candidate.status comment in prisma/schema.prisma.
const RECRUITER_INVESTED_STATUSES = new Set([
  "shortlisted",
  "contacted",
  "interviewing",
  "offer_sent",
  "hired",
]);

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

function intent(c) {
  // Returns a short label describing why we'd skip (or "—" if no signal).
  const reasons = [];
  if (RECRUITER_INVESTED_STATUSES.has(c.status)) reasons.push(`status=${c.status}`);
  if (c.contactedAt) reasons.push(`contactedAt=${c.contactedAt.toISOString()}`);
  if ((c._contactEventCount ?? 0) > 0) reasons.push(`contactEvents=${c._contactEventCount}`);
  return reasons.length ? reasons.join(",") : "—";
}

async function main() {
  console.log(`[cleanup] mode: ${COMMIT ? "COMMIT (will delete)" : "DRY RUN (no writes)"}`);
  console.log(`[cleanup] threshold: profileText < ${SHORT_THRESHOLD} chars counts as empty`);

  // Pull every per-job talent_pool row with empty/short profileText.
  // `length(profileText) < N` isn't expressible directly in Prisma's
  // typed query layer, so we fetch (id, profileText) and filter
  // in-process. Even a heavy library has at most a few thousand such
  // rows — fine for memory.
  const candidates = await prisma.candidate.findMany({
    where: {
      source: "talent_pool",
      jobId: { not: null },
    },
    select: {
      id: true,
      name: true,
      headline: true,
      status: true,
      contactedAt: true,
      profileText: true,
      jobId: true,
      job: { select: { id: true, title: true, company: true } },
      _count: { select: { contactEvents: true } },
    },
  });

  const empties = candidates
    .filter((c) => (c.profileText?.length ?? 0) < SHORT_THRESHOLD)
    .map((c) => ({ ...c, _contactEventCount: c._count?.contactEvents ?? 0 }));

  console.log(`[cleanup] scanned ${candidates.length.toLocaleString()} talent_pool-on-job rows`);
  console.log(`[cleanup] ${empties.length.toLocaleString()} have empty/short profileText`);

  const toDelete = [];
  const toSkip = [];
  for (const c of empties) {
    const reason = intent(c);
    if (reason === "—") toDelete.push(c);
    else toSkip.push({ ...c, _reason: reason });
  }

  // ─── Skipped (recruiter invested) ────────────────────────────────────
  if (toSkip.length > 0) {
    console.log("");
    console.log("─".repeat(72));
    console.log(`SKIPPED — recruiter has invested in these ${toSkip.length} candidate(s):`);
    console.log("─".repeat(72));
    for (const c of toSkip) {
      const jobLabel = c.job ? `${c.job.title}${c.job.company ? " · " + c.job.company : ""}` : "(no job)";
      console.log(`  ${c.id}  ${(c.name ?? "(no name)").slice(0, 40).padEnd(40)}  job="${jobLabel}"  reason=${c._reason}`);
    }
  }

  // ─── Staged for deletion ─────────────────────────────────────────────
  console.log("");
  console.log("─".repeat(72));
  console.log(`${COMMIT ? "DELETING" : "WOULD DELETE"} ${toDelete.length} candidate(s):`);
  console.log("─".repeat(72));
  for (const c of toDelete) {
    const jobLabel = c.job ? `${c.job.title}${c.job.company ? " · " + c.job.company : ""}` : "(no job)";
    const ptLen = c.profileText?.length ?? 0;
    console.log(`  ${c.id}  ${(c.name ?? "(no name)").slice(0, 40).padEnd(40)}  job="${jobLabel}"  ptLen=${ptLen}  status=${c.status}`);
  }

  if (toDelete.length === 0) {
    console.log("  (nothing to delete — clean)");
  }

  // ─── Actually delete ─────────────────────────────────────────────────
  let deleted = 0;
  if (COMMIT && toDelete.length > 0) {
    // deleteMany by ID list — onDelete: Cascade on CandidateFile,
    // FetchSession, ContactEvent, ScoreCorrection, ReferenceCheck means
    // dependent rows get cleaned up automatically. This is exactly what
    // we want for these stubs (no CV file to preserve, no contact log to
    // preserve — we already filtered those out as "skipped").
    const res = await prisma.candidate.deleteMany({
      where: { id: { in: toDelete.map((c) => c.id) } },
    });
    deleted = res.count;
  }

  // ─── Summary ─────────────────────────────────────────────────────────
  console.log("");
  console.log("═".repeat(72));
  console.log("SUMMARY");
  console.log("═".repeat(72));
  console.log(`Scanned:                  ${candidates.length.toLocaleString()}`);
  console.log(`Empty/short profileText:  ${empties.length.toLocaleString()}`);
  console.log(`Skipped (invested):       ${toSkip.length.toLocaleString()}`);
  console.log(`Staged for deletion:      ${toDelete.length.toLocaleString()}`);
  if (COMMIT) console.log(`Actually deleted:         ${deleted.toLocaleString()}`);
  else        console.log(`(dry run — re-run with --commit to delete)`);
  console.log(`Library source rows (jobId IS NULL) were NOT touched.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
