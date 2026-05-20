/**
 * Walks CandidateIdentity rows that have no current ProfileInsight at
 * the latest extractionVersion and POSTs each to the admin extract
 * route to produce one. Companion to scripts/audit-insights.mjs (which
 * is read-only) and scripts/cluster-identities.mjs (which must run
 * first so identities exist).
 *
 * Heavy AI work lives in the server route at
 * src/app/api/admin/insights/extract/route.ts — this script is just an
 * orchestrator. Two reasons:
 *   1. Cost tracking goes through the normal chat.ts → recordAiCall →
 *      UsageEvent path with no .mjs port of the extractor needed.
 *   2. Rate limits + spend cap apply server-side without us re-implementing.
 *
 * SAFETY:
 *   • Default mode is --dry-run: reports what WOULD extract, no HTTP calls.
 *   • --commit required for actual extraction.
 *   • Throttled at TWO levels (sleep between requests; respect 429 retry-after).
 *   • --batch=N limits total work in one run (default: 50). Aborts cleanly
 *     so you can resume in smaller chunks.
 *
 * Auth via x-cron-secret header (CONTACT_SYNC_CRON_SECRET env var). Same
 * pattern the admin route accepts. Without the secret the script falls
 * back to interactive owner login (not implemented — secret is the
 * supported path for now).
 *
 * Usage:
 *   # See what would happen (no writes, no AI cost):
 *   CONTACT_SYNC_CRON_SECRET=xxx node scripts/backfill-insights.mjs --dry-run
 *
 *   # Extract up to 50 candidates (default batch):
 *   CONTACT_SYNC_CRON_SECRET=xxx APP_BASE_URL=https://recruitme-production-...up.railway.app \
 *     node scripts/backfill-insights.mjs --commit
 *
 *   # Smaller test batch:
 *   ... node scripts/backfill-insights.mjs --commit --batch=5
 *
 *   # Filter to one org:
 *   ... node scripts/backfill-insights.mjs --commit --org=<orgId>
 *
 *   # Quiet down output:
 *   ... node scripts/backfill-insights.mjs --commit --json
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const args = process.argv.slice(2);
const DRY_RUN = !args.includes("--commit");
const ORG_FILTER = args.find((a) => a.startsWith("--org="))?.slice("--org=".length) ?? null;
const BATCH = Number(args.find((a) => a.startsWith("--batch="))?.slice("--batch=".length) ?? 50);
const JSON_OUT = args.includes("--json");
const SLEEP_MS_BETWEEN = Number(process.env.BACKFILL_SLEEP_MS ?? 2000);

const APP_BASE_URL = process.env.APP_BASE_URL ?? "http://localhost:3000";
const CRON_SECRET = process.env.CONTACT_SYNC_CRON_SECRET ?? "";

// Keep in sync with src/lib/ai/insights.ts. Same caveat as audit-insights.mjs.
const INSIGHT_EXTRACTION_VERSION = 1;

function log(...parts) {
  if (!JSON_OUT) console.log("[backfill]", ...parts);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function findIdentitiesNeedingExtraction(orgFilter) {
  // Identities WITHOUT a current insight at the latest extractionVersion.
  // Pull all identities + their current insight row (if any), then filter
  // in JS. The volume is ~1k identities, well within memory.
  const identities = await prisma.candidateIdentity.findMany({
    where: orgFilter ? { orgId: orgFilter } : {},
    select: {
      id: true,
      orgId: true,
      currentInsightId: true,
      candidates: {
        select: { id: true, profileText: true },
        where: { profileText: { not: null } },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const insightRows = await prisma.profileInsight.findMany({
    where: { supersededAt: null, extractionVersion: INSIGHT_EXTRACTION_VERSION },
    select: { id: true, identityId: true, sourceProfileTextHash: true },
  });
  const insightByIdentity = new Map(insightRows.map((r) => [r.identityId, r]));

  const needsExtraction = [];
  let skippedNoProfile = 0;
  let skippedAlreadyCurrent = 0;
  for (const ident of identities) {
    // Require at least one candidate row with usable profileText.
    const longest = ident.candidates.reduce(
      (acc, c) => {
        const len = (c.profileText ?? "").length;
        return len > acc.len ? { len } : acc;
      },
      { len: 0 },
    );
    if (longest.len < 500) {
      // Insight extractor would return a thin-profile stub. Cheap, but no
      // AI cost saved — and the stub isn't useful for ranking. Skip.
      skippedNoProfile++;
      continue;
    }
    // Already has a current insight? Skip. (Re-extraction on hash change
    // is the lazy path; this script is for the never-extracted case.)
    if (insightByIdentity.has(ident.id)) {
      skippedAlreadyCurrent++;
      continue;
    }
    needsExtraction.push({ identityId: ident.id, orgId: ident.orgId });
  }

  return { needsExtraction, skippedNoProfile, skippedAlreadyCurrent, totalIdentities: identities.length };
}

async function extractOne(identityId) {
  const url = `${APP_BASE_URL}/api/admin/insights/extract`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-cron-secret": CRON_SECRET,
    },
    body: JSON.stringify({ identityId }),
  });

  if (res.status === 429) {
    // Server-side spend or rate cap. Honour the retry-after header if
    // present; otherwise back off 60s.
    const retryAfterSeconds = Number(res.headers.get("retry-after") ?? "60");
    return { ok: false, status: 429, retryAfterMs: retryAfterSeconds * 1000 };
  }
  if (!res.ok) {
    let body = "";
    try { body = await res.text(); } catch {}
    return { ok: false, status: res.status, body };
  }
  const json = await res.json();
  return { ok: true, body: json };
}

async function main() {
  if (!CRON_SECRET) {
    console.error("[backfill] CONTACT_SYNC_CRON_SECRET env var is required.");
    process.exit(1);
  }

  log(`mode=${DRY_RUN ? "dry-run" : "COMMIT"}  batch=${BATCH}  base=${APP_BASE_URL}`);
  if (ORG_FILTER) log("org filter:", ORG_FILTER);

  const { needsExtraction, skippedNoProfile, skippedAlreadyCurrent, totalIdentities } =
    await findIdentitiesNeedingExtraction(ORG_FILTER);

  log("survey:");
  log(`  identities total:           ${totalIdentities}`);
  log(`  skipped (profileText <500): ${skippedNoProfile}`);
  log(`  skipped (already current):  ${skippedAlreadyCurrent}`);
  log(`  needs extraction:           ${needsExtraction.length}`);

  if (DRY_RUN) {
    log("");
    log("--dry-run: no HTTP calls. Top 5 identities that would be processed:");
    for (const row of needsExtraction.slice(0, 5)) {
      log(`  ${row.identityId} (org=${row.orgId})`);
    }
    log("");
    log(`Add --commit to actually extract. Estimated cost: ~$${(Math.min(BATCH, needsExtraction.length) * 0.005).toFixed(2)} for this batch.`);
    await prisma.$disconnect();
    return;
  }

  if (needsExtraction.length === 0) {
    log("nothing to do.");
    await prisma.$disconnect();
    return;
  }

  const queue = needsExtraction.slice(0, BATCH);
  const counts = { extracted: 0, skipped: 0, errored: 0, rateLimited: 0 };
  const errors = [];

  log(`processing ${queue.length} identities…`);

  for (let i = 0; i < queue.length; i++) {
    const row = queue[i];
    process.stdout.write(`[${i + 1}/${queue.length}] ${row.identityId} `);

    let res = await extractOne(row.identityId);
    if (!res.ok && res.status === 429) {
      // Back off then retry ONCE per row.
      counts.rateLimited++;
      log(`429 — waiting ${Math.round(res.retryAfterMs / 1000)}s before retry`);
      await sleep(res.retryAfterMs);
      res = await extractOne(row.identityId);
    }

    if (!res.ok) {
      counts.errored++;
      errors.push({ identityId: row.identityId, status: res.status, body: res.body });
      console.log(`✗ ${res.status} ${(res.body ?? "").toString().slice(0, 80)}`);
    } else {
      const action = res.body.action;
      if (action === "skipped") {
        counts.skipped++;
        console.log(`skipped (${res.body.reason})`);
      } else {
        counts.extracted++;
        console.log(`✓ ${res.body.extractedBy}/${res.body.modelId.slice(0, 20)}${res.body.thinProfile ? " (thin)" : ""}`);
      }
    }

    // Pace ourselves regardless. Server rate-limit is the safety net;
    // this is the cooperative throttle.
    if (i < queue.length - 1) await sleep(SLEEP_MS_BETWEEN);
  }

  log("");
  log("summary:");
  log(`  extracted:    ${counts.extracted}`);
  log(`  skipped:      ${counts.skipped}`);
  log(`  rate-limited: ${counts.rateLimited}`);
  log(`  errored:      ${counts.errored}`);
  if (errors.length > 0 && !JSON_OUT) {
    log("first 3 errors:");
    for (const e of errors.slice(0, 3)) log(`  ${e.identityId}: ${e.status} ${e.body}`);
  }
  if (JSON_OUT) {
    console.log(JSON.stringify({ counts, errors }, null, 2));
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[backfill] fatal:", err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
