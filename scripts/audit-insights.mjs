/**
 * Read-only auditor for the ProfileInsight backfill state.
 *
 * Prints a per-org breakdown of:
 *   • identities with no insight yet
 *   • identities with a current (non-superseded) insight at the latest
 *     extractionVersion
 *   • identities with an older-version insight (need re-extraction sweep)
 *   • identities whose current insight's profileTextHash no longer matches
 *     the longest-source Candidate row's hash (stale → needs re-extraction)
 *
 * No AI calls. No writes. Use this as the pre-deploy verification that the
 * data model is in good shape before scheduling any extraction work.
 *
 * The actual extraction executor is intentionally NOT in this script — it
 * lands as part of PR 3 (lazy on library pull) and PR 5 (admin "extract now"
 * UI). Premature batch extraction is the $2k/month tail risk Critic B
 * called out.
 *
 * Usage:
 *   node scripts/audit-insights.mjs
 *   node scripts/audit-insights.mjs --org=<id>
 *   node scripts/audit-insights.mjs --json    # machine-readable output
 */

import { PrismaClient } from "@prisma/client";
import { createHash } from "crypto";

const prisma = new PrismaClient();

const args = process.argv.slice(2);
const ORG_FILTER = args.find((a) => a.startsWith("--org="))?.slice("--org=".length) ?? null;
const JSON_OUT = args.includes("--json");

// Keep in sync with src/lib/ai/insights.ts. If you bump either constant,
// bump this too — there's no easy way to import the TS source from a .mjs
// script without wiring a TS loader.
const INSIGHT_EXTRACTION_VERSION = 1;

function hashProfileTextForInsight(raw) {
  if (!raw) return null;
  const normalised = raw.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalised) return null;
  return createHash("sha256").update(normalised).digest("hex");
}

function log(...parts) {
  if (!JSON_OUT) console.log("[audit]", ...parts);
}

async function auditOrg(orgId) {
  const identities = await prisma.candidateIdentity.findMany({
    where: { orgId },
    select: {
      id: true,
      currentInsightId: true,
      candidates: {
        select: { id: true, profileText: true },
        where: { profileText: { not: null } },
      },
    },
  });

  const insightRows = await prisma.profileInsight.findMany({
    where: { orgId, supersededAt: null },
    select: { id: true, identityId: true, sourceProfileTextHash: true, extractionVersion: true },
  });
  const insightByIdentity = new Map(insightRows.map((r) => [r.identityId, r]));

  let noInsight = 0;
  let currentInsight = 0;
  let olderVersionInsight = 0;
  let staleHashInsight = 0;

  for (const ident of identities) {
    const insight = insightByIdentity.get(ident.id);
    if (!insight) {
      noInsight++;
      continue;
    }
    if (insight.extractionVersion < INSIGHT_EXTRACTION_VERSION) {
      olderVersionInsight++;
      continue;
    }
    // Find longest profileText across the identity's candidate rows.
    const longest = ident.candidates.reduce((acc, c) => {
      const len = (c.profileText ?? "").length;
      return len > acc.len ? { text: c.profileText, len } : acc;
    }, { text: null, len: 0 });
    if (!longest.text) {
      // No profile text on any candidate row — extraction was either
      // against an empty profile (thin insight) or against a row that
      // has since been emptied. Count as "needs review" via olderVersion.
      olderVersionInsight++;
      continue;
    }
    const currentHash = hashProfileTextForInsight(longest.text);
    if (currentHash !== insight.sourceProfileTextHash) {
      staleHashInsight++;
    } else {
      currentInsight++;
    }
  }

  return {
    orgId,
    totalIdentities: identities.length,
    noInsight,
    currentInsight,
    olderVersionInsight,
    staleHashInsight,
  };
}

async function main() {
  log(`Auditing ProfileInsight backfill state. EXTRACTION_VERSION=${INSIGHT_EXTRACTION_VERSION}.`);
  if (ORG_FILTER) log("filter: orgId =", ORG_FILTER);

  const orgs = ORG_FILTER
    ? [{ id: ORG_FILTER, name: "(filtered)" }]
    : await prisma.org.findMany({ select: { id: true, name: true } });

  const results = [];
  for (const org of orgs) {
    const r = await auditOrg(org.id);
    results.push({ orgName: org.name, ...r });
    if (!JSON_OUT) {
      log(`org=${org.name} (${org.id}):`);
      log(`  identities: ${r.totalIdentities}`);
      log(`    no insight yet:        ${r.noInsight}`);
      log(`    current (v${INSIGHT_EXTRACTION_VERSION}, hash match): ${r.currentInsight}`);
      log(`    older extraction ver:  ${r.olderVersionInsight}`);
      log(`    stale (hash mismatch): ${r.staleHashInsight}`);
    }
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ extractionVersion: INSIGHT_EXTRACTION_VERSION, orgs: results }, null, 2));
  } else {
    const totals = results.reduce(
      (acc, r) => ({
        totalIdentities: acc.totalIdentities + r.totalIdentities,
        noInsight: acc.noInsight + r.noInsight,
        currentInsight: acc.currentInsight + r.currentInsight,
        olderVersionInsight: acc.olderVersionInsight + r.olderVersionInsight,
        staleHashInsight: acc.staleHashInsight + r.staleHashInsight,
      }),
      { totalIdentities: 0, noInsight: 0, currentInsight: 0, olderVersionInsight: 0, staleHashInsight: 0 },
    );
    log("");
    log("TOTAL across orgs:");
    log(`  identities: ${totals.totalIdentities}`);
    log(`    no insight yet:        ${totals.noInsight}`);
    log(`    current:               ${totals.currentInsight}`);
    log(`    older extraction ver:  ${totals.olderVersionInsight}`);
    log(`    stale (hash mismatch): ${totals.staleHashInsight}`);
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[audit] fatal:", err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
