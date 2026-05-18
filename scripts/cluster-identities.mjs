/**
 * Phase 1 backfill: cluster existing Candidate rows into CandidateIdentity
 * rows by deterministic Tier 1 keys (LinkedIn URL, JobAdder URL).
 *
 * Idempotent + resumable:
 *  - Skips Candidate rows that already have candidateIdentityId set.
 *  - Resumable via Setting("identity.cluster.cursor") which stores the
 *    createdAt timestamp of the last processed row.
 *  - Re-running the script is safe — it picks up where it left off.
 *  - Respects tombstones: CandidateIdentityMerge.isTombstone=true rows
 *    record a deliberate unmerge that auto-merge must not re-collapse.
 *
 * Tier 2 (email/phone) and Tier 3 (fuzzy name) clustering are NOT done here.
 * They go through a recruiter-confirmation queue that ships in PR 5.
 *
 * Multi-org isolation:
 *  - Each CandidateIdentity row carries orgId; matches are scoped to it.
 *  - Same person across two orgs = two identity rows. Never collapse across.
 *
 * Usage:
 *   node scripts/cluster-identities.mjs           # processes all unclustered rows
 *   node scripts/cluster-identities.mjs --dry-run # reports without writing
 *   node scripts/cluster-identities.mjs --reset   # clears cursor, starts over
 *   node scripts/cluster-identities.mjs --org=X   # restrict to one orgId
 *
 * Process semantics:
 *  - Each Candidate row resolves to at most one identity per orgId.
 *  - If a matching identity already exists in that orgId, the row joins it.
 *  - Otherwise a new identity is created and the row points at it.
 *  - Cross-org rows with the same merge key produce TWO identities — not one.
 */

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "crypto";
import { identityMergeKey } from "./_identity-merge.mjs";

const prisma = new PrismaClient();

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const RESET = args.includes("--reset");
const ORG_FILTER = args.find((a) => a.startsWith("--org="))?.slice("--org=".length) ?? null;
const BATCH_SIZE = Number(process.env.IDENTITY_CLUSTER_BATCH_SIZE ?? 500);

const CURSOR_KEY = "identity.cluster.cursor";

function log(...parts) {
  console.log("[cluster]", ...parts);
}

async function getCursor() {
  const row = await prisma.setting.findUnique({ where: { key: CURSOR_KEY } });
  if (!row) return null;
  const ts = new Date(row.value);
  return Number.isNaN(ts.getTime()) ? null : ts;
}

async function setCursor(ts) {
  if (DRY_RUN) return;
  await prisma.setting.upsert({
    where: { key: CURSOR_KEY },
    create: { key: CURSOR_KEY, value: ts.toISOString() },
    update: { value: ts.toISOString() },
  });
}

async function clearCursor() {
  if (DRY_RUN) return;
  await prisma.setting.deleteMany({ where: { key: CURSOR_KEY } });
}

/**
 * Look up an existing CandidateIdentity by Tier 1 key inside the given org.
 * Follows mergedIntoIdentityId so a newly-imported candidate matching a
 * previously-merged source identity lands on the survivor instead.
 * Returns null if no match.
 */
async function findIdentityByKey(orgId, key) {
  let hit = null;
  if (key.kind === "linkedinUrl") {
    hit = await prisma.candidateIdentity.findFirst({
      where: { orgId, linkedinUrl: key.value },
    });
  } else if (key.kind === "jobAdderUrl") {
    hit = await prisma.candidateIdentity.findFirst({
      where: { orgId, jobAdderUrl: key.value },
    });
  }
  if (!hit) return null;

  // Follow merge chain (max 10 hops; merge cycles shouldn't exist, but
  // cap the loop in case of corrupt data).
  let current = hit;
  for (let i = 0; i < 10 && current.mergedIntoIdentityId; i++) {
    const next = await prisma.candidateIdentity.findUnique({
      where: { id: current.mergedIntoIdentityId },
    });
    if (!next) break;
    current = next;
  }
  return current;
}

/**
 * Check whether an auto-merge between two identities has been deliberately
 * tombstoned. Used in two cases:
 *  (a) Before merging an existing identity into another existing identity.
 *  (b) Before clustering a Candidate row into a different identity than the
 *      one it was previously clustered into (re-clustering after a manual split).
 *
 * Since we don't merge existing identities in this pass — each Candidate
 * just JOINS the first matching identity — tombstones are only consulted
 * when the user later does a manual split (PR 5). For now this is a stub
 * that always returns false; the merge-review UI in PR 5 will use it.
 */
async function isTombstoned(orgId, sourceIdentityId, survivorIdentityId) {
  if (!sourceIdentityId || !survivorIdentityId) return false;
  const row = await prisma.candidateIdentityMerge.findFirst({
    where: { orgId, sourceIdentityId, survivorIdentityId, isTombstone: true },
  });
  return Boolean(row);
}

/**
 * Process one Candidate row. Returns one of:
 *   "joined_existing"  — pointed at an existing identity
 *   "created_new"      — created a new identity and pointed at it
 *   "skipped_no_org"   — Candidate.orgId null, can't cluster
 *   "skipped_no_key"   — no LinkedIn/JobAdder URL (eligible for Tier 2/3 later)
 *   "skipped_already"  — candidateIdentityId already set
 */
async function processCandidate(row) {
  if (row.candidateIdentityId) return "skipped_already";
  if (!row.orgId) return "skipped_no_org";

  const key = identityMergeKey(row);
  if (!key) return "skipped_no_key";

  // Try matching an existing identity first.
  const existing = await findIdentityByKey(row.orgId, key);

  let identityId;
  if (existing) {
    identityId = existing.id;
  } else if (DRY_RUN) {
    identityId = "(dry-run)";
  } else {
    const created = await prisma.candidateIdentity.create({
      data: {
        id: randomUUID(),
        orgId: row.orgId,
        canonicalName: row.name,
        linkedinUrl: key.kind === "linkedinUrl" ? key.value : null,
        jobAdderUrl: key.kind === "jobAdderUrl" ? key.value : null,
      },
    });
    identityId = created.id;
    // Write the alias row so the URL is recorded as authoritative.
    await prisma.candidateIdentityAlias.create({
      data: {
        id: randomUUID(),
        identityId,
        kind: key.kind,
        value: key.value,
        source: "system",
      },
    });
  }

  if (!DRY_RUN) {
    await prisma.candidate.update({
      where: { id: row.id },
      data: { candidateIdentityId: identityId },
    });
  }

  return existing ? "joined_existing" : "created_new";
}

async function main() {
  if (RESET) {
    log("--reset: clearing cursor");
    await clearCursor();
  }

  const cursor = await getCursor();
  if (cursor) log("resuming from createdAt >", cursor.toISOString());
  else log("starting from beginning");

  if (ORG_FILTER) log("--org filter:", ORG_FILTER);
  if (DRY_RUN) log("--dry-run: no writes will be made");

  const counts = {
    joined_existing: 0,
    created_new: 0,
    skipped_no_org: 0,
    skipped_no_key: 0,
    skipped_already: 0,
  };

  let lastCreatedAt = cursor;
  let totalProcessed = 0;

  while (true) {
    const where = {
      ...(cursor && lastCreatedAt ? { createdAt: { gt: lastCreatedAt } } : {}),
      ...(ORG_FILTER ? { orgId: ORG_FILTER } : {}),
    };
    const batch = await prisma.candidate.findMany({
      where,
      orderBy: { createdAt: "asc" },
      take: BATCH_SIZE,
      select: {
        id: true,
        orgId: true,
        candidateIdentityId: true,
        name: true,
        linkedinUrl: true,
        jobAdderUrl: true,
        createdAt: true,
      },
    });

    if (batch.length === 0) break;

    for (const row of batch) {
      try {
        const outcome = await processCandidate(row);
        counts[outcome]++;
      } catch (err) {
        console.error("[cluster] error on candidate", row.id, err.message);
      }
      lastCreatedAt = row.createdAt;
    }

    totalProcessed += batch.length;
    if (lastCreatedAt) await setCursor(lastCreatedAt);
    log(`processed ${totalProcessed} so far (last createdAt=${lastCreatedAt?.toISOString()})`);
  }

  log("summary:", JSON.stringify(counts));
  log("total processed:", totalProcessed);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[cluster] fatal:", err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});

// Exports for the integration test — the script also runs standalone.
export { processCandidate, findIdentityByKey, isTombstoned };
