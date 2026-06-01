import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized } from "@/lib/session";
import { decryptCv, isEncrypted, maybeMigrateLegacy } from "@/lib/cv-encryption";
import { loadFileEnvelope, deleteBlob } from "@/lib/blob-store";

// Allow-list for download MIME types. Whatever the browser claimed at upload
// time should never be reflected back as-is — a recruiter who uploaded an
// `text/html` file would otherwise serve attacker-controlled HTML to anyone
// who clicks the download link. Anything outside this list is forced to a
// safe binary download type.
//
// image/jpeg | image/png | image/webp are on the list because recruiter-
// uploaded candidate headshots (via /api/candidates/[id]/photo) flow through
// this same route — same encryption, same auth check. These MIME types are
// well-defined and browser image decoders are battle-tested; no scripting
// surface, no plugin invocation, just pixels.
const ALLOWED_DOWNLOAD_MIMES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

// Strict subset of ALLOWED_DOWNLOAD_MIMES that we'll serve with
// `Content-Disposition: inline` when the caller passes `?inline=1`. Why this
// is safe to render in the user's tab:
//   • Allow-list gated: PDF + jpeg/png/webp. PDFs render in a sandboxed
//     viewer in every modern browser — no script execution. Images render
//     through battle-tested decoders with no scripting surface and no
//     plugin invocation; the MIME types are tightly specified.
//   • `text/html` is intentionally NOT in ALLOWED_DOWNLOAD_MIMES at all and
//     is doubly excluded here, so a recruiter who uploads malicious HTML
//     can never serve it back inline.
//   • Word docs (msword / wordprocessingml) are in the download allow-list
//     but excluded here — browsers don't render them natively, so inline
//     would just show a blank tab. We force download instead.
//   • `X-Content-Type-Options: nosniff` still applies, blocking MIME
//     confusion even if a browser tries to render something off-list. The
//     image MIMEs above are nosniff-safe — the header has no effect on
//     image rendering for matching content, and prevents sniffing-as-HTML
//     for anything that doesn't decode cleanly.
//   • All bytes are AES-256-GCM encrypted at rest (decryptCv) and access is
//     gated by requireFileAccess (org match or owner), so this endpoint
//     can never serve a file the caller wasn't already allowed to download.
const INLINE_SAFE_MIMES = new Set<string>([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
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

  // Conditional-request short-circuit. A CandidateFile is immutable per id
  // (a re-upload produces a new row/id), so the content hash is a stable
  // strong validator. If the client already has it, return 304 BEFORE the
  // R2 fetch + AES decrypt — this is what stops every avatar on a 200-row
  // job page from re-downloading + re-decrypting on each render/navigation.
  // ETag falls back to the row id for legacy rows without a dataHash.
  const etag = `"${file.dataHash ?? file.id}"`;
  // Per-user (auth-gated) + immutable content. `private` keeps shared caches
  // from storing it; `max-age` lets the browser reuse it; `must-revalidate`
  // pairs with the ETag so a cache-buster still re-auths.
  const cacheControl = "private, max-age=86400, must-revalidate";
  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etag, "Cache-Control": cacheControl },
    });
  }

  // Fetch the stored (still-encrypted) envelope — from the S3/R2 blob store
  // when this row was offloaded (storageKey set), else inline from `data`.
  let envelope: string;
  try {
    envelope = await loadFileEnvelope(file);
  } catch {
    return NextResponse.json({ error: "Unable to read file" }, { status: 500 });
  }

  // Decrypt — `decryptCv` is a no-op on legacy (pre-encryption) rows so old
  // CVs keep downloading. When we hit a legacy inline row, schedule a
  // background re-encrypt so the at-rest state heals itself without a separate
  // backfill. Offloaded rows (storageKey set) are always encrypted, so the
  // lazy-migration path never applies to them.
  let plainBase64: string;
  try {
    plainBase64 = await decryptCv(envelope);
  } catch {
    return NextResponse.json({ error: "Unable to decrypt file" }, { status: 500 });
  }
  if (!file.storageKey && !isEncrypted(envelope)) {
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
      // Immutable-per-id content; let the browser cache and revalidate cheaply
      // via the ETag 304 path above (avoids repeat R2 GET + decrypt).
      "Cache-Control": cacheControl,
      ETag: etag,
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
  // Best-effort: drop the backing blob too so we don't leak an orphan object
  // in the bucket. deleteBlob swallows errors (an already-gone object is fine).
  if (file.storageKey) void deleteBlob(file.storageKey);
  return NextResponse.json({ ok: true });
}
