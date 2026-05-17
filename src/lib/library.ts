/**
 * Candidate-library data layer.
 *
 * Centralises the "list candidates in the library" query that previously
 * existed twice (in /api/candidates/route.ts and /candidates/page.tsx) and
 * had drifted — the page was missing cross-org grant handling, so users on
 * orgs with granted access couldn't see shared candidates via SSR.
 *
 * Both call-sites now share this helper. The union of their filter/select
 * requirements is applied here so neither caller loses functionality.
 */

import { prisma } from "./db";
import { normaliseLinkedInUrl } from "./linkedin";
import { getAccessibleOrgIds, candidateOrgFilter, getGrantScopes } from "./org-access";
import type { AuthResult } from "./session";

// Per-request cap. 20k is the safety ceiling for SSR memory; typical orgs
// at 13.5k JobAdder-imported rows fit in one page today. Cursor pagination
// is wired below — callers paginate via the returned `nextCursor`.
const DEFAULT_TAKE = 20000;

export interface LibraryQueryOptions {
  /** Free-text query (currently unused server-side; reserved). */
  query?: string;
  /**
   * Pagination cursor — pass the previous result's `nextCursor` to fetch the
   * next page. Undefined means "first page".
   */
  cursor?: string;
  /** Result cap. Defaults to DEFAULT_TAKE. */
  take?: number;
}

export interface LibraryCandidateRow {
  id: string;
  name: string;
  headline: string | null;
  location: string | null;
  linkedinUrl: string | null;
  matchScore: number | null;
  source: string;
  status: string;
  notes: string | null;
  profileCapturedAt: Date | null;
  createdAt: Date;
  jobId: string | null;
  orgId: string | null;
  archivedJobTitle: string | null;
  archivedJobCompany: string | null;
  job: { id: string; title: string; company: string | null; orgId: string | null } | null;
  files: { id: string; type: string; filename: string; size: number; createdAt: Date }[];
  /** orgId different from viewer → name of the providing org, else null. */
  sharedFromOrgName: string | null;
}

export interface LibraryQueryResult {
  candidates: LibraryCandidateRow[];
  /** Count of rows returned (post-dedupe). */
  total: number;
  /**
   * When the DB query was capped by `take`, returns the last seen Candidate
   * id so the caller can re-query with `cursor: nextCursor` to load more.
   * Null when there's no more data.
   */
  nextCursor: string | null;
}

/**
 * Build the WHERE clause for the candidate library, applying cross-org grants.
 * Exported for the rare callsite that needs the raw filter (none today).
 *
 * Note: the profileText length-gate is NOT expressed here — Prisma's query
 * builder can't do `char_length(profileText) >= N`. It's applied as a
 * separate pre-fetch via $queryRaw in getLibraryCandidates below, and the
 * result is fed to findMany via `id: { in: ... }`. The OR fallback below
 * still permits source-whitelisted rows (manual / jobadder_import) so that
 * rows with non-empty profileText pass even when the source is null, but
 * the SQL length pre-filter independently rejects empty-string rows.
 */
function buildLibraryWhere(accessibleOrgIds: string[] | null) {
  const orgFilter = candidateOrgFilter(accessibleOrgIds);
  const sourceWhitelist = {
    OR: [
      { profileText: { not: null } },
      { source: { in: ["manual", "jobadder_import"] } },
    ],
  };

  // Owner (accessibleOrgIds === null): only the source-whitelist applies.
  if (accessibleOrgIds === null) return sourceWhitelist;

  // Non-owner with no accessible orgs (empty array): candidateOrgFilter
  // returns `{ orgId: "__none__" }` which never matches → empty result, as
  // intended. We still AND the whitelist for consistency.
  return {
    ...sourceWhitelist,
    AND: {
      ...orgFilter,
      // Never surface orphan rows where both jobId AND orgId are null.
      NOT: { orgId: null, jobId: null },
    },
  };
}

// Mirrors LIBRARY_PROFILE_MIN_CHARS in the job-library route. Library rows
// with < this many chars of profileText are treated as "no real profile"
// (the JobAdder-imported, CV-less Bede case) and excluded from the listing.
const LIBRARY_PROFILE_MIN_CHARS = 500;

/**
 * Fetch the candidate library for the given caller.
 *
 * Always applies cross-org grant expansion via getAccessibleOrgIds — so a
 * recruiter on org A who's been granted library_read access to org B sees
 * candidates from both. Owners see everything.
 *
 * Returns the JS-deduped list (by normalised LinkedIn URL, keeping the
 * freshest capture per person) with a sharedFromOrgName attached to each
 * row whose effective orgId differs from the viewer's.
 */
export async function getLibraryCandidates(
  auth: AuthResult,
  opts: LibraryQueryOptions = {},
): Promise<LibraryQueryResult> {
  const take = opts.take ?? DEFAULT_TAKE;

  // Cross-org library access — accessible orgs include the caller's own
  // plus any provider orgs the caller's org has been granted access to.
  // Owners get null which means "no filter".
  const accessibleOrgIds = await getAccessibleOrgIds(auth);

  // Non-owner with zero accessible orgs short-circuits — candidateOrgFilter
  // would map this to `orgId: "__none__"` and the SQL prefilter would join
  // for no reason.
  if (accessibleOrgIds !== null && accessibleOrgIds.length === 0) {
    return { candidates: [], total: 0, nextCursor: null };
  }

  // ── SQL length-gate (the "Bede problem") ───────────────────────────────
  // Prisma can't express `char_length(profileText) >= N`, but without it
  // the library lists JobAdder-imported rows whose CV extraction produced
  // profileText="" — they render as normal cards. Pre-fetch eligible IDs
  // via $queryRaw (just IDs, no profileText payload) and feed them into
  // the existing findMany. The raw query mirrors buildLibraryWhere's org
  // scoping + the source whitelist + the createdAt/id orderBy + cursor
  // pagination semantics ("after the cursor row").
  const orgIdsParam = accessibleOrgIds ?? [];
  const useOrgFilter = accessibleOrgIds !== null;

  // The cursor row's (createdAt, id) tuple defines the lower bound for the
  // next page. We resolve it to concrete values so the SQL WHERE clause
  // can apply the keyset condition.
  let cursorCreatedAt: Date | null = null;
  let cursorId: string | null = null;
  if (opts.cursor) {
    const cursorRow = await prisma.candidate.findUnique({
      where: { id: opts.cursor },
      select: { createdAt: true, id: true },
    });
    if (cursorRow) {
      cursorCreatedAt = cursorRow.createdAt;
      cursorId = cursorRow.id;
    }
  }

  const eligibleRows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT c.id
    FROM "Candidate" c
    LEFT JOIN "Job" j ON j.id = c."jobId"
    WHERE c."profileText" IS NOT NULL
      AND char_length(c."profileText") >= ${LIBRARY_PROFILE_MIN_CHARS}
      AND (
        ${!useOrgFilter}::boolean
        OR j."orgId" = ANY(${orgIdsParam}::text[])
        OR (c."jobId" IS NULL AND c."orgId" = ANY(${orgIdsParam}::text[]))
      )
      AND (
        c."jobId" IS NOT NULL
        OR c."orgId" IS NOT NULL
      )
      AND (
        ${cursorCreatedAt === null}::boolean
        OR c."createdAt" < ${cursorCreatedAt}
        OR (c."createdAt" = ${cursorCreatedAt} AND c."id" < ${cursorId})
      )
    ORDER BY c."createdAt" DESC, c."id" DESC
    LIMIT ${take}
  `;
  const eligibleIds = eligibleRows.map((r) => r.id);
  if (eligibleIds.length === 0) {
    return { candidates: [], total: 0, nextCursor: null };
  }

  const rowsUnordered = await prisma.candidate.findMany({
    where: { id: { in: eligibleIds }, ...buildLibraryWhere(accessibleOrgIds) },
    select: {
      id: true,
      name: true,
      headline: true,
      location: true,
      linkedinUrl: true,
      // profileText INTENTIONALLY NOT SELECTED. With 14k rows × ~10KB
      // profileText, including it pulled ~140 MB of useless data over the
      // wire on every library load (the field gets stripped before
      // serialisation anyway). The old JS-side `hasFullCandidateProfile`
      // length gate now lives in the $queryRaw pre-filter above.
      matchScore: true,
      source: true,
      status: true,
      notes: true,
      profileCapturedAt: true,
      createdAt: true,
      jobId: true,
      orgId: true,
      archivedJobTitle: true,
      archivedJobCompany: true,
      job: { select: { id: true, title: true, company: true, orgId: true } },
      files: {
        select: { id: true, type: true, filename: true, size: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      },
    },
  });
  // Preserve the raw query's keyset ordering — Prisma's `in:` returns rows
  // in arbitrary order so we re-index by ID and replay the eligibleIds list.
  const byId = new Map(rowsUnordered.map((r) => [r.id, r]));
  const rows = eligibleIds
    .map((id) => byId.get(id))
    .filter((r): r is NonNullable<typeof r> => r !== undefined);

  // Deduplicate by normalised LinkedIn URL; keep the freshest capture per
  // person. Rows without a LinkedIn URL (or whose URL fails normalisation)
  // pass through individually as distinct people.
  type Row = (typeof rows)[number];
  const byUrl = new Map<string, Row>();
  const noUrl: Row[] = [];

  for (const row of rows) {
    if (!row.linkedinUrl) {
      noUrl.push(row);
      continue;
    }
    let norm: string;
    try {
      norm = normaliseLinkedInUrl(row.linkedinUrl);
    } catch {
      noUrl.push(row);
      continue;
    }

    const existing = byUrl.get(norm);
    if (!existing) {
      byUrl.set(norm, row);
      continue;
    }
    const rowAge = row.profileCapturedAt ?? row.createdAt;
    const existAge = existing.profileCapturedAt ?? existing.createdAt;
    if (rowAge > existAge) byUrl.set(norm, row);
  }

  const people = [...byUrl.values(), ...noUrl].sort((a, b) => {
    const aDate = a.profileCapturedAt ?? a.createdAt;
    const bDate = b.profileCapturedAt ?? b.createdAt;
    return bDate > aDate ? 1 : -1;
  });

  // Attach sharedFromOrgName ONLY for non-owner viewers seeing a candidate
  // from a different org (cross-org grant). Owners had this badge suppressed
  // in the pre-refactor route; preserve that behaviour — owners already see
  // every org so the badge would fire on every cross-org row and add noise.
  const viewerOrgId = auth.orgId ?? null;
  const externalOrgIds = new Set<string>();
  if (!auth.isOwner && viewerOrgId) {
    for (const p of people) {
      const candOrgId = p.job?.orgId ?? p.orgId ?? null;
      if (candOrgId && candOrgId !== viewerOrgId) externalOrgIds.add(candOrgId);
    }
  }

  const externalOrgs = externalOrgIds.size === 0
    ? []
    : await prisma.org.findMany({
        where: { id: { in: [...externalOrgIds] } },
        select: { id: true, name: true },
      });
  const orgNameById = new Map(externalOrgs.map((o) => [o.id, o.name]));

  // Privacy gate for cross-org sensitive fields (currently just `notes`).
  // The schema (prisma/schema.prisma OrgAccessGrant.scope) reserves
  // `library_full` for "notes, screening, interview data" but until now
  // only `library_read` was checked — meaning a cross-org viewer with just
  // library_read was seeing partner-org recruiter notes (potentially
  // "candidate disclosed pregnancy" / health info). Block by default;
  // permit only when the viewer holds `library_full`.
  const scopes = await getGrantScopes(auth);
  const canSeeCrossOrgSensitive = scopes.has("library_full");

  const candidates: LibraryCandidateRow[] = people.map((row) => {
    const candOrgId = row.job?.orgId ?? row.orgId ?? null;
    const isCrossOrg = !auth.isOwner && viewerOrgId && candOrgId && candOrgId !== viewerOrgId;
    const sharedFromOrgName = isCrossOrg ? orgNameById.get(candOrgId!) ?? null : null;
    return {
      ...row,
      // Redact notes on cross-org rows unless the viewer has library_full.
      // Owners always see notes (they bypass org filtering entirely).
      notes: isCrossOrg && !canSeeCrossOrgSensitive ? null : row.notes,
      sharedFromOrgName,
    };
  });

  // If the raw query was capped at `take`, there may be more rows. Return
  // the last raw row's id as the next cursor (NOT the deduped candidates'
  // last id — the cursor walks the raw orderBy, not the post-dedupe view).
  const nextCursor = rows.length === take && rows.length > 0
    ? rows[rows.length - 1].id
    : null;

  return { candidates, total: candidates.length, nextCursor };
}
