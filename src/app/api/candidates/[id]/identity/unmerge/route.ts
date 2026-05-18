/**
 * POST /api/candidates/[id]/identity/unmerge
 *
 * Recruiter-driven split: the candidate's current identity (the
 * "survivor") is detached from an "original" identity that was previously
 * merged into it. Writes a TOMBSTONE CandidateIdentityMerge row — the
 * tombstone is durable and prevents the clustering script (or a future
 * recruiter merge) from re-collapsing the same pair without an
 * admin-removal step.
 *
 * Effect (per Critic A §1.4 — tombstones are the only honest fix for
 * "manual split → next sync re-merges it"):
 *   • Writes audit row: { sourceIdentityId, survivorIdentityId,
 *     reason: "unmerge", isTombstone: true }.
 *   • Clears originalIdentity.mergedIntoIdentityId (it stands alone again).
 *   • This Candidate row's candidateIdentityId is re-pointed at
 *     originalIdentityId. The merge route moved many candidates to the
 *     survivor; unmerge only re-points the candidate the recruiter is
 *     looking at — they can repeat the action for siblings if needed.
 *     Bulk-revert is intentionally out of scope until the admin UI lands.
 *
 * Refuses when:
 *   • the candidate has no identity linked
 *   • originalIdentityId and the candidate's current identity are the same
 *   • there's no non-tombstone merge record showing
 *     (original → currentIdentity) — caller must point at a real merge
 *
 * Flag-gated by `RECRUITME_IDENTITY_MERGE_UI_ENABLED`.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "crypto";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized } from "@/lib/session";
import { isIdentityMergeUiEnabled } from "@/lib/feature-flags";

const BodySchema = z.object({
  originalIdentityId: z.string().min(1),
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
  const originalIdentityId = parsed.data.originalIdentityId;

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

  const currentIdentityId = candidate.candidateIdentityId;
  if (!currentIdentityId) {
    return NextResponse.json({
      error: "Candidate has no identity linked. Nothing to unmerge.",
    }, { status: 400 });
  }
  if (currentIdentityId === originalIdentityId) {
    return NextResponse.json({
      error: "Original identity and current identity are the same — nothing to split.",
    }, { status: 400 });
  }

  const [originalIdentity, currentIdentity] = await Promise.all([
    prisma.candidateIdentity.findUnique({
      where: { id: originalIdentityId },
      select: { id: true, orgId: true, mergedIntoIdentityId: true },
    }),
    prisma.candidateIdentity.findUnique({
      where: { id: currentIdentityId },
      select: { id: true, orgId: true },
    }),
  ]);

  if (!originalIdentity || !currentIdentity) {
    return NextResponse.json({ error: "Identity not found." }, { status: 404 });
  }
  if (originalIdentity.orgId !== currentIdentity.orgId) {
    return NextResponse.json({ error: "Cross-org unmerge is not allowed." }, { status: 400 });
  }
  if (!auth.isOwner && originalIdentity.orgId !== auth.orgId) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  // There must be a non-tombstone merge record. Without one, the caller
  // is asking us to split identities that were never merged in the first
  // place — refuse, because the resulting tombstone would block legit
  // future merges of pairs we never actually unified.
  const mergeRecord = await prisma.candidateIdentityMerge.findFirst({
    where: {
      orgId: originalIdentity.orgId,
      sourceIdentityId: originalIdentityId,
      survivorIdentityId: currentIdentityId,
      isTombstone: false,
    },
    select: { id: true },
  });
  if (!mergeRecord) {
    return NextResponse.json({
      error: "No prior merge of this pair on record. Nothing to unmerge.",
    }, { status: 400 });
  }

  await prisma.$transaction(async (tx) => {
    // Tombstone row. The @@unique([orgId, sourceIdentityId,
    // survivorIdentityId, isTombstone]) constraint makes the tombstone
    // idempotent — re-clicking unmerge for the same pair is a no-op.
    try {
      await tx.candidateIdentityMerge.create({
        data: {
          id: randomUUID(),
          orgId: originalIdentity.orgId,
          sourceIdentityId: originalIdentityId,
          survivorIdentityId: currentIdentityId,
          mergedByUserId: auth.userId,
          reason: "unmerge",
          isTombstone: true,
        },
      });
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code !== "P2002") throw err; // tombstone already exists; fine
    }

    // Detach the original identity from its merge target.
    await tx.candidateIdentity.update({
      where: { id: originalIdentityId },
      data: { mergedIntoIdentityId: null },
    });

    // Re-point THIS candidate row back at the original identity. Bulk
    // re-point of all candidates is intentionally out of scope here —
    // recruiter can repeat per candidate, or the admin UI in a follow-up
    // can offer a bulk option.
    await tx.candidate.update({
      where: { id: candidateId },
      data: { candidateIdentityId: originalIdentityId },
    });
  });

  return NextResponse.json({
    unmerged: true,
    originalIdentityId,
    survivorIdentityId: currentIdentityId,
  });
}
