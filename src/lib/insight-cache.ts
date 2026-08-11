/**
 * Persistence layer for ProfileInsight rows. Idempotent + per-org isolated.
 *
 * Design contract:
 *  • Per-(orgId, identityId, sourceProfileTextHash, extractionVersion) is
 *    UNIQUE in the schema. Re-running the extractor with the same inputs
 *    is a no-op upsert — guaranteed by the DB, not by application logic.
 *  • "Current" insight = the row for an identity that matches the
 *    candidate's CURRENT profileText hash AND extractionVersion. Rows for
 *    older hashes stay around as audit history with supersededAt set.
 *  • Stale detection is hash-based, never timestamp-based. When
 *    profileText changes, hash changes; the new extraction marks prior
 *    rows superseded in the same transaction.
 *  • Multi-org isolation: every query is filtered by orgId. There is NO
 *    cross-org insight lookup — even with an OrgAccessGrant. See plan §A
 *    decision #5.
 */

import { prisma } from "./db";
import { randomUUID } from "crypto";
import type { ExtractedInsight, InsightFacts } from "./ai/insights";

/**
 * Row shape returned from getCurrentInsight. Matches the Prisma model
 * one-for-one — exposed here so consumers don't have to import Prisma types
 * directly (those have generated names that change across migrations).
 */
export interface ProfileInsightRow {
  id: string;
  orgId: string;
  identityId: string;
  facts: InsightFacts;
  extractionVersion: number;
  promptVersion: string;
  extractedBy: string;
  modelId: string;
  sourceProfileTextHash: string;
  sourceCandidateId: string | null;
  extractedAt: Date;
  supersededAt: Date | null;
}

function rowToTyped(row: {
  id: string;
  orgId: string;
  identityId: string;
  factsJson: string;
  extractionVersion: number;
  promptVersion: string;
  extractedBy: string;
  modelId: string;
  sourceProfileTextHash: string;
  sourceCandidateId: string | null;
  extractedAt: Date;
  supersededAt: Date | null;
}): ProfileInsightRow {
  let facts: InsightFacts;
  try {
    facts = JSON.parse(row.factsJson) as InsightFacts;
  } catch {
    // Defensive: corrupt JSON in a single row shouldn't crash the whole
    // page. Return an empty-shape insight with a thinProfile flag so the
    // UI shows "no facts" rather than 500.
    facts = {
      currentTitle: null,
      currentEmployer: null,
      primaryStack: [],
      secondaryStack: [],
      domains: [],
      titlesHeld: [],
      totalYearsExperience: null,
      currentSeniority: null,
      education: [],
      certifications: [],
      evidenceSnippets: [],
      thinProfile: true,
    };
  }
  return {
    id: row.id,
    orgId: row.orgId,
    identityId: row.identityId,
    facts,
    extractionVersion: row.extractionVersion,
    promptVersion: row.promptVersion,
    extractedBy: row.extractedBy,
    modelId: row.modelId,
    sourceProfileTextHash: row.sourceProfileTextHash,
    sourceCandidateId: row.sourceCandidateId,
    extractedAt: row.extractedAt,
    supersededAt: row.supersededAt,
  };
}

/**
 * Look up the current (non-superseded) insight for an identity. Returns
 * null when no insight has been extracted yet. Always org-scoped.
 */
export async function getCurrentInsight(
  orgId: string,
  identityId: string,
): Promise<ProfileInsightRow | null> {
  const row = await prisma.profileInsight.findFirst({
    where: { orgId, identityId, supersededAt: null },
    orderBy: { extractedAt: "desc" },
  });
  return row ? rowToTyped(row) : null;
}

/**
 * Look up an insight by the exact (orgId, identityId, hash, version) tuple.
 * Used by the idempotent-upsert check in saveInsight, and by re-extraction
 * back-pressure ("we already extracted this — skip").
 */
export async function findInsightByKey(args: {
  orgId: string;
  identityId: string;
  sourceProfileTextHash: string;
  extractionVersion: number;
}): Promise<ProfileInsightRow | null> {
  const row = await prisma.profileInsight.findFirst({
    where: {
      orgId: args.orgId,
      identityId: args.identityId,
      sourceProfileTextHash: args.sourceProfileTextHash,
      extractionVersion: args.extractionVersion,
    },
  });
  return row ? rowToTyped(row) : null;
}

export interface SaveInsightArgs {
  orgId: string;
  identityId: string;
  extracted: ExtractedInsight;
  sourceCandidateId?: string | null;
}

/**
 * Persist an extracted insight. Idempotent — re-saving the same
 * (orgId, identityId, hash, version) tuple is a no-op, returning the
 * existing row. When the new hash differs from any current row's hash for
 * this identity, the older rows are marked supersededAt = now() so
 * getCurrentInsight returns the new one.
 *
 * Also updates CandidateIdentity.currentInsightId so reads don't need a
 * "find newest" join.
 */
export async function saveInsight(args: SaveInsightArgs): Promise<ProfileInsightRow> {
  const { orgId, identityId, extracted, sourceCandidateId } = args;

  // Idempotency fast-path — skip the transaction if the row already exists.
  const existing = await findInsightByKey({
    orgId,
    identityId,
    sourceProfileTextHash: extracted.sourceProfileTextHash,
    extractionVersion: extracted.extractionVersion,
  });
  if (existing) return existing;

  const factsJson = JSON.stringify(extracted.facts);
  const now = new Date();

  // One transaction: supersede older non-current rows for this identity,
  // then upsert the new row (the unique constraint catches the rare race
  // where two writers raced past the fast-path check above), then point
  // the identity at the new currentInsightId.
  const newId = randomUUID();
  const row = await prisma.$transaction(async (tx) => {
    // Supersede any prior current rows for this identity. We only flip
    // supersededAt — never delete; the row is audit history.
    await tx.profileInsight.updateMany({
      where: { orgId, identityId, supersededAt: null },
      data: { supersededAt: now },
    });

    // Insert the new row. createMany with skipDuplicates would be nicer
    // but we want to return the row, so do create + catch-on-P2002.
    type RowShape = {
      id: string;
      orgId: string;
      identityId: string;
      factsJson: string;
      extractionVersion: number;
      promptVersion: string;
      extractedBy: string;
      modelId: string;
      sourceProfileTextHash: string;
      sourceCandidateId: string | null;
      extractedAt: Date;
      supersededAt: Date | null;
    };
    let created: RowShape;
    try {
      created = (await tx.profileInsight.create({
        data: {
          id: newId,
          orgId,
          identityId,
          factsJson,
          extractionVersion: extracted.extractionVersion,
          promptVersion: extracted.promptVersion,
          extractedBy: extracted.extractedBy,
          modelId: extracted.modelId,
          sourceProfileTextHash: extracted.sourceProfileTextHash,
          sourceCandidateId: sourceCandidateId ?? null,
        },
      })) as unknown as RowShape;
    } catch (err) {
      // P2002 = race-condition duplicate on the unique constraint. The
      // unique tuple is (orgId, identityId, hash, version) — fetch the
      // existing row instead. Race is rare; usually two parallel pulls
      // for the same identity.
      const code = (err as { code?: string })?.code;
      if (code !== "P2002") throw err;
      created = (await tx.profileInsight.findFirstOrThrow({
        where: {
          orgId,
          identityId,
          sourceProfileTextHash: extracted.sourceProfileTextHash,
          extractionVersion: extracted.extractionVersion,
        },
      })) as unknown as RowShape;
    }

    // Update identity.currentInsightId so consumers don't need a join.
    await tx.candidateIdentity.updateMany({
      where: { id: identityId, orgId },
      data: { currentInsightId: created.id },
    });

    return created;
  });

  return rowToTyped(row);
}

/**
 * Mark all insights for an identity as superseded. Used when a recruiter
 * explicitly invalidates an insight (PR 5 admin UI). Does NOT delete —
 * audit history survives.
 */
export async function supersedeAllInsightsForIdentity(args: {
  orgId: string;
  identityId: string;
}): Promise<number> {
  const result = await prisma.profileInsight.updateMany({
    where: { orgId: args.orgId, identityId: args.identityId, supersededAt: null },
    data: { supersededAt: new Date() },
  });
  // Also clear the pointer.
  await prisma.candidateIdentity.updateMany({
    where: { id: args.identityId, orgId: args.orgId },
    data: { currentInsightId: null },
  });
  return result.count;
}
