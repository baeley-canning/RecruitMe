/**
 * Recruiter-uploaded candidate headshot.
 *
 * POST   /api/candidates/[id]/photo  — multipart upload, replaces any existing
 *                                       photo atomically.
 * DELETE /api/candidates/[id]/photo  — clears the current photo.
 *
 * Storage path: identical to CV uploads (CandidateFile row with AES-256-GCM
 * ciphertext, same per-org auth gate, same inline-vs-attachment allow-list).
 * The only specialisation here vs the generic /files POST is:
 *   • narrower MIME allow-list (image/jpeg | image/png | image/webp),
 *   • smaller max size (5MB instead of 10MB — headshots are tiny),
 *   • atomically updates Candidate.photoFileId in the same transaction,
 *   • deletes the previous CandidateFile row when replacing.
 */

import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized } from "@/lib/session";
import { encryptCv } from "@/lib/cv-encryption";
import { persistFileEnvelope, deleteBlob } from "@/lib/blob-store";
import { reportError } from "@/lib/error-reporting";

const MAX_PHOTO_SIZE = 5 * 1024 * 1024; // 5 MB — headshots should be much smaller
const ALLOWED_IMAGE_MIMES = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

/**
 * Auth gate mirroring src/app/api/candidates/[id]/files/route.ts:requireAccess.
 * Returns the candidate (with current photoFileId) when the caller's org owns
 * it (or the caller is owner). Returns null otherwise — the route maps that
 * to a 404 so cross-org viewers can't probe for candidate existence.
 */
async function requireAccess(
  candidateId: string,
  auth: NonNullable<Awaited<ReturnType<typeof getAuth>>>,
) {
  const candidate = await prisma.candidate.findUnique({
    where: { id: candidateId },
    select: {
      id: true,
      orgId: true,
      photoFileId: true,
      job: { select: { orgId: true } },
    },
  });
  if (!candidate) return null;
  const orgId = candidate.orgId ?? candidate.job?.orgId ?? null;
  if (!auth.isOwner && orgId !== auth.orgId) return null;
  return candidate;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;
  try {
    const candidate = await requireAccess(id, auth);
    if (!candidate) return NextResponse.json({ error: "Not found" }, { status: 404 });

    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
    }
    const file = formData.get("file");

    // Duck-type check — `File` isn't a guaranteed global on every Node runtime
    // (Railway's was throwing `File is not defined`), so we verify the
    // properties we actually use rather than the class identity. Same pattern
    // as the CV upload route.
    if (
      !file ||
      typeof file === "string" ||
      typeof (file as { arrayBuffer?: unknown }).arrayBuffer !== "function" ||
      typeof (file as { name?: unknown }).name !== "string" ||
      typeof (file as { size?: unknown }).size !== "number"
    ) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }
    const upload = file as { name: string; type: string; size: number; arrayBuffer: () => Promise<ArrayBuffer> };

    if (!ALLOWED_IMAGE_MIMES.has(upload.type)) {
      return NextResponse.json(
        { error: "Photo must be a JPEG, PNG, or WebP image." },
        { status: 415 },
      );
    }
    if (upload.size > MAX_PHOTO_SIZE) {
      return NextResponse.json({ error: "Photo too large (max 5 MB)" }, { status: 413 });
    }

    const buffer = Buffer.from(await upload.arrayBuffer());
    const base64 = buffer.toString("base64");
    const fileHash = createHash("sha256").update(buffer).digest("hex").slice(0, 32);
    const encryptedData = await encryptCv(base64);
    // Offload to the blob store (or inline in `data`) BEFORE opening the
    // transaction — a network PUT must not be held inside the DB transaction.
    const blob = await persistFileEnvelope(encryptedData);

    const previousPhotoFileId = candidate.photoFileId;
    // Grab the previous photo's storage key (if any) so we can drop its backing
    // blob from the bucket once the swap commits.
    const previous = previousPhotoFileId
      ? await prisma.candidateFile.findUnique({
          where: { id: previousPhotoFileId },
          select: { storageKey: true },
        })
      : null;

    // Atomic replacement: create the new CandidateFile, point the Candidate
    // at it, and delete the previous CandidateFile in one transaction. If any
    // step fails the whole thing rolls back and the candidate stays pointing
    // at whatever they had before (or nothing).
    let createdId: string;
    try {
      createdId = await prisma.$transaction(async (tx) => {
        const created = await tx.candidateFile.create({
          data: {
            candidateId: id,
            type: "photo",
            filename: upload.name,
            mimeType: upload.type,
            data: blob.data,
            storageKey: blob.storageKey,
            dataHash: fileHash,
            size: upload.size,
          },
          select: { id: true },
        });
        await tx.candidate.update({
          where: { id },
          data: { photoFileId: created.id },
        });
        if (previousPhotoFileId) {
          // Cascade-on-delete would also nuke this row when the candidate is
          // deleted; here we just clean up the stale photo within the same tx
          // so we don't leak an unreferenced encrypted blob in CandidateFile.
          await tx.candidateFile.delete({ where: { id: previousPhotoFileId } }).catch(() => {
            // Best-effort: if the old row is already gone (race with another
            // delete), don't fail the whole transaction.
          });
        }
        return created.id;
      });
    } catch (err) {
      // The swap rolled back, so the blob we just uploaded is orphaned — drop it.
      if (blob.storageKey) void deleteBlob(blob.storageKey);
      throw err;
    }
    // Swap committed and the old row is gone — drop its backing blob too.
    if (previous?.storageKey) void deleteBlob(previous.storageKey);

    return NextResponse.json(
      {
        photoFileId: createdId,
        photoUrl: `/api/candidates/${id}/files/${createdId}?inline=1`,
      },
      { status: 201 },
    );
  } catch (err) {
    reportError(err, { route: "photo:post", candidateId: id, orgId: auth.orgId });
    return NextResponse.json({ error: "Server error — please try again" }, { status: 500 });
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;
  try {
    const candidate = await requireAccess(id, auth);
    if (!candidate) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (!candidate.photoFileId) {
      return NextResponse.json({ error: "No photo to delete" }, { status: 404 });
    }

    const photoFileId = candidate.photoFileId;
    const photoRow = await prisma.candidateFile.findUnique({
      where: { id: photoFileId },
      select: { storageKey: true },
    });
    await prisma.$transaction(async (tx) => {
      await tx.candidate.update({
        where: { id },
        data: { photoFileId: null },
      });
      await tx.candidateFile.delete({ where: { id: photoFileId } }).catch(() => {
        // Best-effort: if the underlying file row is already gone, the
        // Candidate.photoFileId clear is what we actually needed.
      });
    });
    // Drop the backing blob from the bucket (best-effort, no-op when inline).
    if (photoRow?.storageKey) void deleteBlob(photoRow.storageKey);

    return NextResponse.json({ ok: true });
  } catch (err) {
    reportError(err, { route: "photo:delete", candidateId: id, orgId: auth.orgId });
    return NextResponse.json({ error: "Server error — please try again" }, { status: 500 });
  }
}
