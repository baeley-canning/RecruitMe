/**
 * POST /api/candidates/[id]/identity/merge
 *
 * Recruiter-confirmed merge of the candidate's current CandidateIdentity
 * into a survivor identity (both must belong to the same orgId). Writes
 * a non-tombstone CandidateIdentityMerge audit row, sets the source
 * identity's mergedIntoIdentityId, and re-points every Candidate row
 * that was on the source to the survivor.
 *
 * Refuses to merge when:
 *   • the candidate has no candidateIdentityId yet (clustering hasn't run)
 *   • the survivor identity is in a different org
 *   • the source and survivor are the same identity
 *   • a TOMBSTONE merge row exists for (source, survivor) — Critic A §1.4
 *     blocks any auto OR recruiter-driven re-merge after a manual split
 *     until the tombstone is explicitly removed by an admin tool
 *
 * Returns:
 *   { merged: true, sourceIdentityId, survivorIdentityId, candidatesMoved }
 *
 * Flag-gated by `RECRUITME_IDENTITY_MERGE_UI_ENABLED`. The route refuses
 * to act when off — feature kill switch matches plan §H rollout.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "crypto";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized } from "@/lib/session";
import { isIdentityMergeUiEnabled } from "@/lib/feature-flags";

const BodySchema = z.object({
  survivorIdentityId: z.string().min(1),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isIdentityMergeUiEnabled()) {
    return NextResponse.json({ error: "Identity merge UI is not enabled in this environment." }, { status: 404 });
  }

  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id: candidateId } = await params;

  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 });
  }
  const survivorIdentityId = parsed.data.survivorIdentityId;

  const candidate = await prisma.candidate.findUnique({
    where: { id: candidateId },
    select: { id: true, orgId: true, candidateIdentityId: true },
  });
  if (!candidate) {
    return NextResponse.json({ error: "Candidate not found." }, { status: 404 });
  }

  if (!auth.isOwner && candidate.orgId !== auth.orgId) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const sourceIdentityId = candidate.candidateIdentityId;
  if (!sourceIdentityId) {
    return NextResponse.json({
      error: "Candidate has no identity linked yet. Run the clustering script first.",
    }, { status: 400 });
  }

  if (sourceIdentityId === survivorIdentityId) {
    return NextResponse.json({ error: "Source and survivor identity must be different." }, { status: 400 });
  }

  // Both identities must exist and live in the same org. Cross-org merges
  // are NEVER allowed — Critic A §10 + plan §A decision #5.
  const [sourceIdentity, survivorIdentity] = await Promise.all([
    prisma.candidateIdentity.findUnique({
      where: { id: sourceIdentityId },
      select: { id: true, orgId: true, mergedIntoIdentityId: true },
    }),
    prisma.candidateIdentity.findUnique({
      where: { id: survivorIdentityId },
      select: { id: true, orgId: true, mergedIntoIdentityId: true },
    }),
  ]);

  if (!sourceIdentity || !survivorIdentity) {
    return NextResponse.json({ error: "Identity not found." }, { status: 404 });
  }
  if (sourceIdentity.orgId !== survivorIdentity.orgId) {
    return NextResponse.json({ error: "Cross-org merges are not allowed." }, { status: 400 });
  }
  if (!auth.isOwner && sourceIdentity.orgId !== auth.orgId) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  // Tombstone block: if the recruiter previously unmerged this exact pair,
  // the tombstone is durable and prevents re-merge until an admin removes it.
  const tombstone = await prisma.candidateIdentityMerge.findFirst({
    where: {
      orgId: sourceIdentity.orgId,
      sourceIdentityId,
      survivorIdentityId,
      isTombstone: true,
    },
    select: { id: true, mergedAt: true },
  });
  if (tombstone) {
    return NextResponse.json({
      error: "These identities were previously unmerged. The unmerge is durable; ask an admin to clear the tombstone before re-merging.",
      tombstoneCreatedAt: tombstone.mergedAt,
    }, { status: 409 });
  }

  // Run the merge atomically: audit row + source pointer + re-point all
  // candidates. updateMany is bound by orgId so we can never accidentally
  // pull rows from another tenant.
  const result = await prisma.$transaction(async (tx) => {
    await tx.candidateIdentityMerge.create({
      data: {
        id: randomUUID(),
        orgId: sourceIdentity.orgId,
        sourceIdentityId,
        survivorIdentityId,
        mergedByUserId: auth.userId,
        reason: "recruiter_confirm",
        isTombstone: false,
      },
    });
    await tx.candidateIdentity.update({
      where: { id: sourceIdentityId },
      data: { mergedIntoIdentityId: survivorIdentityId },
    });
    const moved = await tx.candidate.updateMany({
      where: { candidateIdentityId: sourceIdentityId, orgId: sourceIdentity.orgId },
      data: { candidateIdentityId: survivorIdentityId },
    });
    return { candidatesMoved: moved.count };
  });

  return NextResponse.json({
    merged: true,
    sourceIdentityId,
    survivorIdentityId,
    candidatesMoved: result.candidatesMoved,
  });
}
