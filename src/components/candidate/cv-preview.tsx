"use client";

import { FileText, Download } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/format";

/**
 * Inline CV preview card.
 *
 * For PDFs (and small enough to be worth streaming), renders an `<object>`
 * pointing at the existing `/api/candidates/[id]/files/[fileId]?inline=1`
 * route. The browser's sandboxed PDF viewer renders the bytes; the route is
 * allow-list-gated to only return `Content-Disposition: inline` on
 * `application/pdf`, so any other MIME type degrades to the download-card
 * fallback in this component.
 *
 * Word docs and other downloadable types render an info card with a download
 * link — browsers can't render `.docx` natively, so the JobAdder-style
 * "blank tab" UX is avoided by not even trying.
 */

const MAX_INLINE_PREVIEW_BYTES = 15 * 1024 * 1024; // 15 MB

interface CVPreviewProps {
  candidateId: string;
  file: {
    id: string;
    filename: string;
    mimeType: string;
    size: number; // bytes
  };
  /** Height of the preview viewport. Defaults to 600. */
  height?: number;
  className?: string;
}

function PreviewHeader({ filename, size }: { filename: string; size: number }) {
  return (
    <div className="px-3 py-2 border-b border-separator flex items-center gap-2">
      <FileText className="w-3.5 h-3.5 text-text-tertiary flex-shrink-0" />
      <p className="text-xs font-medium text-text-primary truncate flex-1 min-w-0">
        {filename}
      </p>
      <span className="text-2xs text-text-tertiary data-mono flex-shrink-0">
        {formatBytes(size)}
      </span>
    </div>
  );
}

function DownloadFallback({
  candidateId,
  file,
  reason,
}: {
  candidateId: string;
  file: CVPreviewProps["file"];
  reason: string;
}) {
  return (
    <div className="p-4 flex flex-col items-center justify-center text-center gap-2">
      <FileText className="w-6 h-6 text-text-tertiary" />
      <p className="text-xs text-text-secondary">{reason}</p>
      <a
        href={`/api/candidates/${candidateId}/files/${file.id}`}
        download={file.filename}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-accent hover:bg-accent-hover text-text-inverse transition-colors"
      >
        <Download className="w-3.5 h-3.5" />
        Download
      </a>
    </div>
  );
}

const WORD_MIMES = new Set([
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

export function CVPreview({
  candidateId,
  file,
  height = 600,
  className,
}: CVPreviewProps) {
  const isPdf = file.mimeType === "application/pdf";
  const isWord = WORD_MIMES.has(file.mimeType);
  const tooLarge = file.size > MAX_INLINE_PREVIEW_BYTES;

  const cardClass = cn(
    "bg-surface-raised rounded-md border border-separator overflow-hidden",
    className,
  );

  if (isPdf && !tooLarge) {
    return (
      <div className={cardClass}>
        <PreviewHeader filename={file.filename} size={file.size} />
        <object
          data={`/api/candidates/${candidateId}/files/${file.id}?inline=1`}
          type="application/pdf"
          className="w-full"
          style={{ height }}
        >
          <p className="p-4 text-xs text-text-secondary">
            Your browser doesn&apos;t support inline PDF preview.{" "}
            <a
              href={`/api/candidates/${candidateId}/files/${file.id}`}
              className="text-accent hover:underline"
            >
              Download instead
            </a>
            .
          </p>
        </object>
      </div>
    );
  }

  const reason = tooLarge
    ? "File too large for inline preview."
    : isWord
      ? "Word documents can't be previewed inline — click to download."
      : "This file type can't be previewed inline.";

  return (
    <div className={cardClass}>
      <PreviewHeader filename={file.filename} size={file.size} />
      <DownloadFallback candidateId={candidateId} file={file} reason={reason} />
    </div>
  );
}
