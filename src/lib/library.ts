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
import { getAccessibleOrgIds, candidateOrgFilter } from "./org-access";
import type { AuthResult } from "./session";

// Hard cap retained from the API route (lifted from 2000 → 20000 after the
// JobAdder bulk import pushed typical orgs past 13k candidates). Cursor
// pagination is the long-term fix; this keeps the page functional.
const DEFAULT_TAKE = 20000;

export interface LibraryQueryOptions {
  /** Free-text query (currently unused server-side; kept for future cursor pagination). */
  query?: string;
  /** Pagination cursor — Candidate id. Not yet wired through (future-proofing). */
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
  total: number;
}

/**
 * Build the WHERE clause for the candidate library, applying cross-org grants.
 * Exported for the rare callsite that needs the raw filter (none today).
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

  const rows = await prisma.candidate.findMany({
    where: buildLibraryWhere(accessibleOrgIds),
    // id-desc tiebreaker for bulk-insert timestamp-ties (13.5k JobAdder rows
    // shared one createdAt). Without it the page head was deterministically
    // name-sorted Z's instead of "newest captures".
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
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
      // length gate is lost as a side-effect — some short captures may
      // now appear in the library that previously didn't.
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

  const candidates: LibraryCandidateRow[] = people.map((row) => {
    const candOrgId = row.job?.orgId ?? row.orgId ?? null;
    const sharedFromOrgName =
      !auth.isOwner && viewerOrgId && candOrgId && candOrgId !== viewerOrgId
        ? orgNameById.get(candOrgId) ?? null
        : null;
    return { ...row, sharedFromOrgName };
  });

  return { candidates, total: candidates.length };
}
