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

// Strict subset of ALLOWED_DOWNLOAD_MIMES that we'll serve with
// `Content-Disposition: inline` when the caller passes `?inline=1`. Why this
// is safe to render in the user's tab:
//   • Allow-list gated: only `application/pdf` is on it. PDFs render in a
//     sandboxed viewer in every modern browser — no script execution.
//   • `text/html` is intentionally NOT in ALLOWED_DOWNLOAD_MIMES at all and
//     is doubly excluded here, so a recruiter who uploads malicious HTML
//     can never serve it back inline.
//   • Word docs (msword / wordprocessingml) are in the download allow-list
//     but excluded here — browsers don't render them natively, so inline
//     would just show a blank tab. We force download instead.
//   • `X-Content-Type-Options: nosniff` still applies, blocking MIME
//     confusion even if a browser tries to render something off-list.
//   • CV bytes are AES-256-GCM encrypted at rest (decryptCv) and access is
//     gated by requireFileAccess (org match or owner), so this endpoint
//     can never serve a file the caller wasn't already allowed to download.
const INLINE_SAFE_MIMES = new Set<string>([
  "application/pdf",
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
  req: Request,
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

  // Decide disposition. `?inline=1` opts into inline rendering, but only for
  // MIME types in the INLINE_SAFE_MIMES allow-list (PDF today). Anything
  // else — including Word docs in the broader download allow-list, and
  // anything safeDownloadMime() flattens to octet-stream — falls back to
  // attachment. The client can gracefully degrade to a download link when
  // its preview component sees a non-inline-safe file.
  const safeMime = safeDownloadMime(file.mimeType);
  const wantsInline = new URL(req.url).searchParams.get("inline") === "1";
  const serveInline = wantsInline && INLINE_SAFE_MIMES.has(safeMime);
  const disposition = serveInline ? "inline" : "attachment";

  const buffer = Buffer.from(plainBase64, "base64");
  return new Response(buffer, {
    headers: {
      "Content-Type": safeMime,
      "Content-Disposition": `${disposition}; filename="${encodeURIComponent(file.filename)}"`,
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
