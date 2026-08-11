/**
 * Index-backed recall for a parsed role.
 *
 * WHY THIS EXISTS
 *
 * `searchTalentPoolForRole` recalled candidates with
 * `findMany({ take: 2000 })` ordered by `createdAt DESC`, never touching the
 * `searchTsv` full-text index. Its comment justified that with "the realistic
 * per-org pool size (~200-500 unique candidates)". Measured against production
 * on 2026-08-11 that assumption is wrong by two orders of magnitude:
 *
 *   - 16,927 candidate rows
 *   - 13,189 of them a JobAdder archive import, bulk-inserted inside a FOUR
 *     MINUTE window on 30 May, so they sort as a single block
 *   - 12,986 of those have full profile text
 *   - only 1,498 fall inside the newest-2,000 slice the code examines
 *
 * So 11,488 candidates — the large majority of the library, most with a CV
 * attached — were unreachable by the search whose entire job is to find them.
 * Not one JobAdder-sourced candidate had ever been scored.
 *
 * This module recalls by the index instead, so age stops deciding visibility.
 *
 * DELIBERATELY ADDITIVE. The caller merges these rows with its existing
 * recency window rather than replacing it, so the candidate set can only grow.
 * A bug here loses no results that worked before.
 */
import { prisma } from "../db";
import { reportError } from "../error-reporting";
import { parseBooleanQuery } from "../boolean-query";
import { tsqueryFromParsed } from "../boolean-query/emit";
import { parsedRoleToBooleanQuery } from "./role-query";
import type { ParsedRole } from "../ai";

/** Row shape the talent-pool pre-rank stage needs. Full profileText, not a snippet. */
export interface RecallRow {
  id: string;
  name: string;
  headline: string | null;
  location: string | null;
  linkedinUrl: string | null;
  profileText: string | null;
  profileCapturedAt: Date | null;
  createdAt: Date;
}

/**
 * How many index hits to pull. Generous — this is the cheap stage, and the
 * expensive ones (signal density, then a Claude shortlist) cut it down hard.
 * Capped so a two-word role can't drag the whole library into memory.
 */
export const RECALL_LIMIT = 1500;

/**
 * Recall candidates for a role using the full-text index.
 *
 * Returns [] when the role produces no usable query — the caller keeps whatever
 * its own recall found, so an empty result here is never worse than before.
 *
 * ORG SCOPE is applied in SQL and mirrors the Prisma filter used elsewhere in
 * the pool path exactly: a candidate is visible when its JOB belongs to an
 * accessible org, or when it is a library-only row (jobId IS NULL) whose own
 * orgId is accessible. `orgScope === null` means owner scope (no filter). An
 * empty array means "no accessible orgs" and must return nothing rather than
 * everything.
 */
export async function recallCandidatesForRole(args: {
  parsedRole: ParsedRole;
  orgScope: string | string[] | null;
  limit?: number;
}): Promise<RecallRow[]> {
  const { parsedRole, orgScope, limit = RECALL_LIMIT } = args;

  const orgIds = orgScope == null ? null : Array.isArray(orgScope) ? orgScope : [orgScope];
  // An explicitly empty scope is "nothing is accessible", NOT "no filter".
  if (orgIds !== null && orgIds.length === 0) return [];

  const booleanQuery = parsedRoleToBooleanQuery(parsedRole);
  if (!booleanQuery) return [];

  const tsquery = tsqueryFromParsed(parseBooleanQuery(booleanQuery));
  if (!tsquery) return [];

  const useOrgFilter = orgIds !== null;
  const orgIdsParam = orgIds ?? [];

  try {
    return await prisma.$queryRaw<RecallRow[]>`
      SELECT
        c."id", c."name", c."headline", c."location", c."linkedinUrl",
        c."profileText", c."profileCapturedAt", c."createdAt"
      FROM "Candidate" c
      LEFT JOIN "Job" j ON j.id = c."jobId",
           to_tsquery('english', ${tsquery}) q
      WHERE c."searchTsv" @@ q
        AND c."profileText" IS NOT NULL
        AND (
          ${!useOrgFilter}::boolean
          OR j."orgId" = ANY(${orgIdsParam}::text[])
          OR (c."jobId" IS NULL AND c."orgId" = ANY(${orgIdsParam}::text[]))
        )
        AND (c."jobId" IS NOT NULL OR c."orgId" IS NOT NULL)
      ORDER BY ts_rank_cd(ARRAY[0.1, 0.2, 0.4, 1.0]::real[], c."searchTsv", q) DESC,
               c."createdAt" DESC
      LIMIT ${limit}
    `;
  } catch (err) {
    // Recall is a best-effort widening on top of the caller's own query, so a
    // malformed tsquery degrades to "found nothing extra" rather than taking
    // the whole search down. But it is REPORTED, not swallowed: a silent catch
    // here once hid a missing test mock and made a dead code path look green.
    reportError(err, { route: "talent-search:recall" });
    return [];
  }
}
