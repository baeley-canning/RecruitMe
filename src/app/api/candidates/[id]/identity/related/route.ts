/**
 * GET /api/candidates/[id]/identity/related
 *
 * Read-only feed for the recruiter merge-review panel. Returns:
 *   • current      — the candidate's identity + how many records it spans
 *   • suggestions  — OTHER identities in the SAME org that look like the same
 *                    person (Tier-2 email/phone exact + Tier-3 normalised-name
 *                    match), excluding ones already absorbed and any pair with
 *                    a durable tombstone (the merge route would reject those).
 *   • mergedFrom   — identities previously merged INTO the current one (so the
 *                    recruiter can split them back via the unmerge route).
 *
 * The write side (POST .../merge, POST .../unmerge) is the authority — this
 * route only proposes; it never mutates. Org-scoped: a non-owner can only see
 * a candidate (and identities) in their own org. Same flag + authz model as
 * the merge/unmerge routes.
 *
 * Flag-gated by `RECRUITME_IDENTITY_MERGE_UI_ENABLED` — 404 when off.
 */

import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized } from "@/lib/session";
import { isIdentityMergeUiEnabled } from "@/lib/feature-flags";
import { normaliseName, normaliseEmail, normalisePhoneE164 } from "@/lib/identity-merge";
import type {
  IdentityRelatedResponse,
  IdentitySummary,
  IdentityCandidateSample,
  MergeSuggestion,
  IdentityMatchReason,
} from "@/lib/identity-merge-dto";

const EMPTY: IdentityRelatedResponse = { hasIdentity: false, current: null, suggestions: [], mergedFrom: [] };

type IdentityRow = {
  id: string;
  canonicalName: string;
  primaryEmail: string | null;
  primaryPhone: string | null;
  linkedinUrl: string | null;
  jobAdderUrl: string | null;
  seekUrl: string | null;
};

const IDENTITY_SELECT = {
  id: true,
  canonicalName: true,
  primaryEmail: true,
  primaryPhone: true,
  linkedinUrl: true,
  jobAdderUrl: true,
  seekUrl: true,
} as const;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isIdentityMergeUiEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id: candidateId } = await params;

  const candidate = await prisma.candidate.findUnique({
    where: { id: candidateId },
    select: { id: true, orgId: true, candidateIdentityId: true },
  });
  if (!candidate) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!auth.isOwner && candidate.orgId !== auth.orgId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // No identity (clustering hasn't run, or an org-less owner library row) →
  // nothing to merge against.
  if (!candidate.candidateIdentityId || !candidate.orgId) {
    return NextResponse.json(EMPTY);
  }
  const orgId = candidate.orgId;
  const currentId = candidate.candidateIdentityId;

  const currentIdentity = await prisma.candidateIdentity.findUnique({
    where: { id: currentId },
    select: IDENTITY_SELECT,
  });
  if (!currentIdentity) return NextResponse.json(EMPTY);

  // ── Candidate-count + sample helper, batched over all identities we care
  // about (current + suggestions) so we never N+1.
  const buildSummaries = async (rows: IdentityRow[]): Promise<Map<string, IdentitySummary>> => {
    const ids = rows.map((r) => r.id);
    const out = new Map<string, IdentitySummary>();
    if (ids.length === 0) return out;
    const [counts, samples] = await Promise.all([
      prisma.candidate.groupBy({
        by: ["candidateIdentityId"],
        where: { candidateIdentityId: { in: ids } },
        _count: { _all: true },
      }),
      prisma.candidate.findMany({
        where: { candidateIdentityId: { in: ids } },
        select: {
          id: true, name: true, headline: true, candidateIdentityId: true,
          archivedJobTitle: true, job: { select: { title: true } },
        },
        orderBy: { createdAt: "desc" },
        take: ids.length * 4 + 8,
      }),
    ]);
    const countById = new Map<string, number>();
    for (const c of counts) {
      if (c.candidateIdentityId) countById.set(c.candidateIdentityId, c._count._all);
    }
    const samplesById = new Map<string, IdentityCandidateSample[]>();
    for (const s of samples) {
      if (!s.candidateIdentityId) continue;
      const list = samplesById.get(s.candidateIdentityId) ?? [];
      if (list.length < 4) {
        list.push({
          id: s.id,
          name: s.name,
          headline: s.headline,
          jobTitle: s.job?.title ?? s.archivedJobTitle ?? null,
        });
      }
      samplesById.set(s.candidateIdentityId, list);
    }
    for (const r of rows) {
      out.set(r.id, {
        identityId: r.id,
        canonicalName: r.canonicalName,
        primaryEmail: r.primaryEmail,
        primaryPhone: r.primaryPhone,
        linkedinUrl: r.linkedinUrl,
        jobAdderUrl: r.jobAdderUrl,
        seekUrl: r.seekUrl,
        candidateCount: countById.get(r.id) ?? 0,
        sampleCandidates: samplesById.get(r.id) ?? [],
      });
    }
    return out;
  };

  // ── Suggestions: other identities matching by email / phone / name.
  const email = normaliseEmail(currentIdentity.primaryEmail);
  const phone = normalisePhoneE164(currentIdentity.primaryPhone);
  const nameNorm = normaliseName(currentIdentity.canonicalName);

  const orFilters: Prisma.CandidateIdentityWhereInput[] = [];
  if (currentIdentity.primaryEmail) orFilters.push({ primaryEmail: { equals: currentIdentity.primaryEmail, mode: "insensitive" } });
  if (currentIdentity.primaryPhone) orFilters.push({ primaryPhone: currentIdentity.primaryPhone });
  if (currentIdentity.canonicalName.trim()) orFilters.push({ canonicalName: { equals: currentIdentity.canonicalName, mode: "insensitive" } });

  let candidateMatches: IdentityRow[] = [];
  if (orFilters.length > 0) {
    candidateMatches = await prisma.candidateIdentity.findMany({
      where: {
        orgId,
        id: { not: currentId },
        mergedIntoIdentityId: null, // skip identities already absorbed elsewhere
        OR: orFilters,
      },
      select: IDENTITY_SELECT,
      take: 25,
    });
  }

  // Keep only matches with a real, normalised reason (the DB filters are
  // permissive — insensitive equals — so confirm against the normalisers).
  const withReasons = candidateMatches
    .map((m) => {
      const reasons: IdentityMatchReason[] = [];
      if (email && normaliseEmail(m.primaryEmail) === email) reasons.push("email");
      if (phone && normalisePhoneE164(m.primaryPhone) === phone) reasons.push("phone");
      if (nameNorm && normaliseName(m.canonicalName) === nameNorm) reasons.push("name");
      return { row: m, reasons };
    })
    .filter((x) => x.reasons.length > 0);

  // Tombstone block: a merge of (current → match) or a prior unmerge of
  // (match → current) makes the pair ineligible. Exclude either direction so
  // we never suggest something the merge route would 409 on.
  const matchIds = withReasons.map((x) => x.row.id);
  let blocked = new Set<string>();
  if (matchIds.length > 0) {
    const tombstones = await prisma.candidateIdentityMerge.findMany({
      where: {
        orgId,
        isTombstone: true,
        OR: [
          { sourceIdentityId: currentId, survivorIdentityId: { in: matchIds } },
          { survivorIdentityId: currentId, sourceIdentityId: { in: matchIds } },
        ],
      },
      select: { sourceIdentityId: true, survivorIdentityId: true },
    });
    blocked = new Set(
      tombstones.flatMap((t) => [t.sourceIdentityId, t.survivorIdentityId]).filter((x) => x !== currentId),
    );
  }
  const suggestionRows = withReasons.filter((x) => !blocked.has(x.row.id));

  // ── mergedFrom: identities merged INTO current, minus any later unmerged.
  const [mergedInRows, tombstonedIn] = await Promise.all([
    prisma.candidateIdentityMerge.findMany({
      where: { orgId, survivorIdentityId: currentId, isTombstone: false },
      select: { sourceIdentityId: true, mergedAt: true, reason: true },
      orderBy: { mergedAt: "desc" },
    }),
    prisma.candidateIdentityMerge.findMany({
      where: { orgId, survivorIdentityId: currentId, isTombstone: true },
      select: { sourceIdentityId: true },
    }),
  ]);
  const tombstonedSources = new Set(tombstonedIn.map((r) => r.sourceIdentityId));
  const activeMergedIn = mergedInRows.filter((r) => !tombstonedSources.has(r.sourceIdentityId));
  const mergedFromNames = activeMergedIn.length
    ? await prisma.candidateIdentity.findMany({
        where: { id: { in: activeMergedIn.map((r) => r.sourceIdentityId) } },
        select: { id: true, canonicalName: true },
      })
    : [];
  const nameById = new Map(mergedFromNames.map((n) => [n.id, n.canonicalName]));

  // Build summaries for current + suggestions in one batched pass.
  const summaries = await buildSummaries([currentIdentity, ...suggestionRows.map((x) => x.row)]);

  const suggestions: MergeSuggestion[] = suggestionRows.map((x) => ({
    ...(summaries.get(x.row.id) as IdentitySummary),
    matchReasons: x.reasons,
  }));

  const response: IdentityRelatedResponse = {
    hasIdentity: true,
    current: summaries.get(currentId) ?? null,
    suggestions,
    mergedFrom: activeMergedIn.map((r) => ({
      originalIdentityId: r.sourceIdentityId,
      canonicalName: nameById.get(r.sourceIdentityId) ?? "Unknown",
      mergedAt: r.mergedAt.toISOString(),
      reason: r.reason,
    })),
  };
  return NextResponse.json(response, { headers: { "Cache-Control": "no-store" } });
}
