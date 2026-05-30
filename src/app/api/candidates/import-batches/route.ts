/**
 * GET /api/candidates/import-batches — list the import batches available to
 * the caller, for the library page's "Show only this batch" filter chip
 * (Phase E4).
 *
 * Each batch corresponds to one bulk-import operation (a JobAdder library
 * pull, a scraper batch ingest, an auto-import from the talent pool, etc.).
 * The row is one cuid per batch + a count + the earliest createdAt of the
 * candidates in it + the predominant `source` so the chip can display
 * "JobAdder · 13,193 · 2 days ago" rather than just the opaque uuid.
 *
 * Org-scoped via the standard accessible-orgs filter so a non-owner only
 * sees batches whose candidates land in their org.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized } from "@/lib/session";
import { getAccessibleOrgIds } from "@/lib/org-access";

// Cap the list so a heavy import history doesn't blow up the chip row.
// The library filter shows at most the N most recent batches; older ones
// stay in the DB and remain queryable via the URL.
const LIMIT = 10;

export async function GET() {
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const accessibleOrgIds = await getAccessibleOrgIds(auth);
  // Non-owner with zero accessible orgs short-circuits.
  if (accessibleOrgIds !== null && accessibleOrgIds.length === 0) {
    return NextResponse.json({ batches: [] });
  }

  // Aggregate per-batch in one round trip. `mode` (most-common source) is
  // grouped via a small subquery so the chip can show "JobAdder import" /
  // "Scraper batch" etc. without a second client-side join.
  const rows = accessibleOrgIds === null
    ? await prisma.$queryRaw<Array<{
        batch_id: string;
        count: bigint;
        latest_at: Date;
        source: string;
      }>>`
        SELECT
          "importBatchId" AS batch_id,
          count(*) AS count,
          max(coalesce("profileCapturedAt", "createdAt")) AS latest_at,
          (array_agg("source" ORDER BY "createdAt" DESC))[1] AS source
        FROM "Candidate"
        WHERE "importBatchId" IS NOT NULL
        GROUP BY "importBatchId"
        ORDER BY latest_at DESC
        LIMIT ${LIMIT}
      `
    : await prisma.$queryRaw<Array<{
        batch_id: string;
        count: bigint;
        latest_at: Date;
        source: string;
      }>>`
        SELECT
          "importBatchId" AS batch_id,
          count(*) AS count,
          max(coalesce("profileCapturedAt", "createdAt")) AS latest_at,
          (array_agg("source" ORDER BY "createdAt" DESC))[1] AS source
        FROM "Candidate"
        WHERE "importBatchId" IS NOT NULL
          AND "orgId" = ANY(${accessibleOrgIds}::text[])
        GROUP BY "importBatchId"
        ORDER BY latest_at DESC
        LIMIT ${LIMIT}
      `;

  return NextResponse.json({
    batches: rows.map((r) => ({
      batchId: r.batch_id,
      count: Number(r.count),
      latestAt: r.latest_at.toISOString(),
      source: r.source,
    })),
  });
}
