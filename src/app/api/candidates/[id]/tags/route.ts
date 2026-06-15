import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized } from "@/lib/session";
import { getAccessibleOrgIds, candidateOrgFilter } from "@/lib/org-access";
import { isRemindersEnabled } from "@/lib/feature-flags";

/**
 * Resolve the candidate ONLY within the caller's accessible orgs. Returns null
 * if the candidate doesn't exist or belongs to another tenant — closing the
 * cross-org read/write leak (audit Phase 1.1): without this scope any logged-in
 * recruiter could read or rewrite any candidate's tags in any org by id.
 *
 * `orgId` is the candidate's EFFECTIVE org (its own orgId, or the org of the
 * job it's attached to) — used to constrain which tags may be assigned.
 */
async function resolveInOrgCandidate(
  candidateId: string,
  auth: NonNullable<Awaited<ReturnType<typeof getAuth>>>,
): Promise<{ id: string; orgId: string | null } | null> {
  const accessibleOrgIds = await getAccessibleOrgIds(auth);
  const candidate = await prisma.candidate.findFirst({
    where: { id: candidateId, ...candidateOrgFilter(accessibleOrgIds) },
    select: { id: true, orgId: true, job: { select: { orgId: true } } },
  });
  if (!candidate) return null;
  return { id: candidate.id, orgId: candidate.orgId ?? candidate.job?.orgId ?? null };
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isRemindersEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const { id: candidateId } = await params;
  const candidate = await resolveInOrgCandidate(candidateId, auth);
  if (!candidate) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const assignments = await prisma.candidateTagAssignment.findMany({
    where: { candidateId },
    include: { tag: true },
  });
  return NextResponse.json(assignments.map(a => a.tag));
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isRemindersEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const { id: candidateId } = await params;
  const candidate = await resolveInOrgCandidate(candidateId, auth);
  if (!candidate) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // WRITE path: only tag candidates in your OWN org. A cross-org library_read
  // grant is read-only — it must not be able to wipe/replace the provider org's
  // tag assignments (deleteMany below). 404 (not 403) to avoid leaking existence.
  if (!auth.isOwner && candidate.orgId !== auth.orgId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await req.json().catch(() => ({})) as { tagIds?: string[] };
  const requestedIds: string[] = Array.isArray(body.tagIds) ? body.tagIds : [];

  // Constrain tagIds to tags that actually belong to the candidate's org —
  // stops cross-org tag-id injection (CandidateTagAssignment has no orgId of
  // its own, so the guard has to happen here against CandidateTag.orgId).
  const validTags = (requestedIds.length > 0 && candidate.orgId)
    ? await prisma.candidateTag.findMany({
        where: { id: { in: requestedIds }, orgId: candidate.orgId },
        select: { id: true },
      })
    : [];
  const tagIds = validTags.map(t => t.id);

  // Replace all tag assignments atomically
  await prisma.$transaction([
    prisma.candidateTagAssignment.deleteMany({ where: { candidateId } }),
    ...(tagIds.length > 0
      ? [prisma.candidateTagAssignment.createMany({
          data: tagIds.map(tagId => ({ candidateId, tagId })),
          skipDuplicates: true,
        })]
      : []),
  ]);

  const assignments = await prisma.candidateTagAssignment.findMany({
    where: { candidateId },
    include: { tag: true },
  });
  return NextResponse.json(assignments.map(a => a.tag));
}
