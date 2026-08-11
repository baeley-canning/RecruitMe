/**
 * Recover ScrapeJob rows that were dispatched to the wrong scraper.
 *
 * 100 jobs were created with platform="linkedin" and a profileUrl of
 * "seek:https://nz.employer.seek.com/talentsearch/profile/…" — a merge-key
 * string that leaked into the linkedinUrl column. The worker trusted the
 * platform column, sent them to the LinkedIn scraper, and each failed in about
 * four seconds. That is the loop which ran ~6x too fast and got the owner's
 * LinkedIn account flagged.
 *
 * The routing bug is fixed in both directions now (app-side resolveProfileTarget,
 * worker-side resolveJobTarget). This script recovers the WORK those rows
 * represent: real SEEK profiles that were never fetched.
 *
 * SAFETY:
 *   • Default is --dry-run. It reports and writes nothing.
 *   • --commit is required to enqueue.
 *   • Skips any URL whose candidate already has profile text — re-scraping a
 *     profile we already hold spends platform budget for nothing.
 *   • Skips any URL that already has a pending/processing SEEK job.
 *   • Creates jobs at LOW priority so they queue behind real recruiter work.
 *   • Enqueues only; never deletes or edits the original rows, so this is
 *     reversible by deleting the created jobs (they are tagged in requestedBy).
 *
 * Usage:
 *   node scripts/requeue-misrouted-scrape-jobs.mjs                 # report
 *   node scripts/requeue-misrouted-scrape-jobs.mjs --commit        # enqueue
 *   node scripts/requeue-misrouted-scrape-jobs.mjs --commit --limit=25
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const args = process.argv.slice(2);
const COMMIT = args.includes("--commit");
const LIMIT = Number((args.find((a) => a.startsWith("--limit=")) ?? "").split("=")[1] || 0) || Infinity;
const TAG = "requeue:misrouted-seek";

/** Same contract as src/lib/profile-url.ts — strip a merge-key prefix, demand https. */
function cleanProfileUrl(raw) {
  if (!raw) return null;
  const stripped = String(raw).trim().replace(/^(?:linkedin|seek|jobadder):(?=https?:\/\/)/i, "");
  return /^https:\/\//i.test(stripped) ? stripped : null;
}

function isSeekProfileUrl(url) {
  try {
    const u = new URL(url);
    return /(^|\.)seek\.(com|co\.nz|com\.au)$/i.test(u.hostname) && u.pathname.includes("/talentsearch/profile/");
  } catch {
    return false;
  }
}

async function main() {
  // Every job whose stored URL actually points at SEEK, regardless of the
  // platform column it was filed under.
  const suspects = await prisma.scrapeJob.findMany({
    where: { kind: "profile", profileUrl: { contains: "seek.com" } },
    select: { id: true, orgId: true, platform: true, profileUrl: true, status: true, candidateId: true },
  });

  const misrouted = suspects.filter(
    (j) => j.platform !== "seek" && isSeekProfileUrl(cleanProfileUrl(j.profileUrl) ?? ""),
  );

  console.log(`ScrapeJob rows with a SEEK URL:        ${suspects.length}`);
  console.log(`  ...filed under the wrong platform:   ${misrouted.length}`);
  if (misrouted.length === 0) {
    console.log("Nothing to recover.");
    return;
  }

  // De-duplicate by cleaned URL — the same profile may have been retried.
  const byUrl = new Map();
  for (const j of misrouted) {
    const url = cleanProfileUrl(j.profileUrl);
    if (url && !byUrl.has(url)) byUrl.set(url, j);
  }
  console.log(`  ...distinct profile URLs:            ${byUrl.size}`);

  const urls = [...byUrl.keys()];

  // Drop anything we already have the text for. The whole point of the fetch is
  // the profile text; if a later capture already landed it, re-fetching spends
  // SEEK budget for nothing.
  const alreadyHave = await prisma.candidate.findMany({
    where: { seekUrl: { in: urls }, profileText: { not: null } },
    select: { seekUrl: true },
  });
  const haveText = new Set(alreadyHave.map((c) => c.seekUrl));

  // Drop anything already queued.
  const inFlight = await prisma.scrapeJob.findMany({
    where: { platform: "seek", kind: "profile", status: { in: ["pending", "processing"] }, profileUrl: { in: urls } },
    select: { profileUrl: true },
  });
  const queued = new Set(inFlight.map((j) => j.profileUrl));

  const todo = urls.filter((u) => !haveText.has(u) && !queued.has(u));

  console.log(`  ...already have profile text:        ${urls.length - todo.length - queued.size}`);
  console.log(`  ...already queued:                   ${queued.size}`);
  console.log(`  ...TO ENQUEUE:                       ${todo.length}`);

  const slice = todo.slice(0, LIMIT === Infinity ? todo.length : LIMIT);
  if (slice.length !== todo.length) console.log(`  ...limited to:                       ${slice.length}`);

  if (!COMMIT) {
    console.log("\nDRY RUN — nothing written. Re-run with --commit to enqueue.");
    for (const u of slice.slice(0, 10)) console.log(`  would enqueue  ${u}`);
    if (slice.length > 10) console.log(`  ...and ${slice.length - 10} more`);
    return;
  }

  let created = 0;
  for (const url of slice) {
    const src = byUrl.get(url);
    await prisma.scrapeJob.create({
      data: {
        orgId: src.orgId,
        platform: "seek",
        kind: "profile",
        profileUrl: url,
        candidateId: src.candidateId ?? null,
        // The worker sorts (priority DESC, createdAt ASC), and live recruiter
        // work sits at 0 with watches at 50 — so backfill must go NEGATIVE to
        // queue behind everything rather than jumping the line.
        priority: -10,
        requestedBy: TAG,
      },
    });
    created += 1;
  }
  console.log(`\nEnqueued ${created} SEEK profile jobs at priority -10, tagged requestedBy="${TAG}".`);
  console.log(`Undo: DELETE FROM "ScrapeJob" WHERE "requestedBy" = '${TAG}' AND status = 'pending';`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
