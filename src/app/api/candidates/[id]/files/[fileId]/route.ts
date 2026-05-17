import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized } from "@/lib/session";
import { decryptCv, isEncrypted, maybeMigrateLegacy } from "@/lib/cv-encryption";

// Allow-list for download MIME types. Whatever the browser claimed at upload
// time should never be reflected back as-is — a recruiter who uploaded an
// `text/html` file would otherwise serve attacker-controlled HTML to anyone
// who clicks the download link. Anything outside this list is forced to a
// safe binary download type.
const ALLOWED_DOWNLOAD_MIMES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
]);

function safeDownloadMime(claimed: string | null | undefined): string {
  if (!claimed) return "application/octet-stream";
  return ALLOWED_DOWNLOAD_MIMES.has(claimed) ? claimed : "application/octet-stream";
}

async function requireFileAccess(
  candidateId: string,
  fileId: string,
  auth: NonNullable<Awaited<ReturnType<typeof getAuth>>>
) {
  const file = await prisma.candidateFile.findFirst({
    where: { id: fileId, candidateId },
    include: { candidate: { select: { orgId: true, job: { select: { orgId: true } } } } },
  });
  if (!file) return null;
  // Auth: check via job.orgId if job exists, otherwise fall back to candidate.orgId
  const orgId = file.candidate.job?.orgId ?? file.candidate.orgId;
  if (!auth.isOwner && orgId !== auth.orgId) return null;
  return file;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; fileId: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id, fileId } = await params;

  const file = await requireFileAccess(id, fileId, auth);
  if (!file) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Decrypt — `decryptCv` is a no-op on legacy (pre-encryption) rows so old
  // CVs keep downloading. When we hit a legacy row, schedule a background
  // re-encrypt so the at-rest state heals itself without a separate backfill.
  let plainBase64: string;
  try {
    plainBase64 = await decryptCv(file.data);
  } catch {
    return NextResponse.json({ error: "Unable to decrypt file" }, { status: 500 });
  }
  if (!isEncrypted(file.data)) {
    void maybeMigrateLegacy(file.id, plainBase64);
  }

  const buffer = Buffer.from(plainBase64, "base64");
  return new Response(buffer, {
    headers: {
      "Content-Type": safeDownloadMime(file.mimeType),
      "Content-Disposition": `attachment; filename="${encodeURIComponent(file.filename)}"`,
      "Content-Length": String(buffer.length),
      // Belt-and-braces: even if a browser ignores Content-Disposition and
      // tries to render inline, no-sniff blocks MIME confusion attacks.
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; fileId: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id, fileId } = await params;

  const file = await requireFileAccess(id, fileId, auth);
  if (!file) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.candidateFile.delete({ where: { id: fileId } });
  return NextResponse.json({ ok: true });
}
