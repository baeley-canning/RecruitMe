"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { ChevronDown, ChevronRight, Download, ExternalLink, Loader2, Trash2, Upload } from "lucide-react";
import { cn, timeAgo } from "@/lib/utils";
import { formatBytes } from "@/lib/format";
import { confirm } from "@/components/ui/confirm-dialog";
import { CVPreview } from "./cv-preview";

export interface DrawerFile {
  id: string;
  type: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: string;
  scored?: boolean;
  processingError?: string;
}

function drawerTypeLabel(type: string) {
  if (type === "cv") return "CV";
  if (type === "cover_letter") return "Cover Letter";
  return "Other";
}

function drawerTypeColor(type: string) {
  if (type === "cv") return "bg-accent-subtle text-accent border-separator";
  if (type === "cover_letter") return "bg-warning-subtle text-warning border-separator";
  return "bg-surface-hover text-text-secondary border-separator";
}

function DrawerFileRow({
  file,
  candidateId,
  onDeleted,
  defaultExpanded = false,
}: {
  file: DrawerFile;
  candidateId: string;
  onDeleted: (id: string) => void;
  /** Default-open the inline preview. Set true for the primary CV so
   *  recruiters see the resume immediately without an extra click. */
  defaultExpanded?: boolean;
}) {
  const [deleting, setDeleting] = useState(false);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const handleDelete = async () => {
    if (!await confirm({ message: `Delete "${file.filename}"?`, danger: true, confirmLabel: "Delete" })) return;
    setDeleting(true);
    await fetch(`/api/candidates/${candidateId}/files/${file.id}`, { method: "DELETE" });
    onDeleted(file.id);
  };
  // Only PDFs render inline today (per cv-preview.tsx's INLINE_SAFE_MIMES);
  // hide the chevron for other types so the affordance only appears when
  // it actually does something.
  const previewable = file.mimeType === "application/pdf";
  return (
    <div>
      <div className="flex items-center gap-2 px-3 py-2 rounded bg-surface-raised border border-separator group hover:bg-surface-hover transition-colors">
        {previewable ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="p-0.5 -ml-0.5 text-text-tertiary hover:text-text-secondary rounded transition-colors"
            title={expanded ? "Hide preview" : "Show preview"}
            aria-expanded={expanded}
          >
            {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>
        ) : (
          <span className="w-3.5 h-3.5 flex-shrink-0" aria-hidden />
        )}
        <span className={cn("px-1.5 py-0.5 rounded-sm text-2xs font-medium border flex-shrink-0", drawerTypeColor(file.type))}>
          {drawerTypeLabel(file.type)}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-text-primary truncate">{file.filename}</p>
          <p className="text-2xs text-text-tertiary data-mono" suppressHydrationWarning>{formatBytes(file.size)} · {timeAgo(new Date(file.createdAt))}</p>
        </div>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {previewable && (
            <a
              href={`/api/candidates/${candidateId}/files/${file.id}?inline=1`}
              target="_blank"
              rel="noopener noreferrer"
              className="p-1 text-text-tertiary hover:text-accent hover:bg-surface-hover rounded transition-colors"
              title="Open in new tab"
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          )}
          <a
            href={`/api/candidates/${candidateId}/files/${file.id}`}
            download={file.filename}
            className="p-1 text-text-tertiary hover:text-accent hover:bg-surface-hover rounded transition-colors"
            title="Download"
          >
            <Download className="w-3.5 h-3.5" />
          </a>
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="p-1 text-text-tertiary hover:text-danger hover:bg-surface-hover rounded transition-colors disabled:opacity-50"
            title="Delete"
          >
            {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>
      {expanded && previewable && (
        <CVPreview candidateId={candidateId} file={file} height={520} className="mt-2" />
      )}
    </div>
  );
}

function DrawerUploadZone({ candidateId, onUploaded }: { candidateId: string; onUploaded: (file: DrawerFile) => void }) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [type, setType] = useState<"cv" | "cover_letter" | "other">("cv");
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(null);
    setNotice(null);
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", files[0]);
      form.append("type", type);
      const res = await fetch(`/api/candidates/${candidateId}/files`, { method: "POST", body: form });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setError(json.message ?? json.error ?? "Upload failed");
      } else {
        const data = await res.json();
        onUploaded(data);
        if (type === "cv" && data.processingError) {
          setNotice(data.processingError);
        } else if (type === "cv" && data.scored === false) {
          setNotice("CV saved — no score generated because this job hasn't been parsed yet.");
        } else if (type === "cv" && data.scored) {
          setNotice("CV uploaded and scored.");
        }
      }
    } catch {
      setError("Upload failed — please try again");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }, [candidateId, type, onUploaded]);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <select
          value={type}
          onChange={(e) => setType(e.target.value as typeof type)}
          className="text-xs border border-separator rounded px-2 py-1.5 bg-surface-sunken text-text-primary focus:outline-none focus:border-accent focus:shadow-focus"
        >
          <option value="cv">CV / Resume</option>
          <option value="cover_letter">Cover Letter</option>
          <option value="other">Other</option>
        </select>
        <label className={cn(
          "flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium cursor-pointer transition-colors",
          uploading ? "bg-surface-hover text-text-tertiary cursor-not-allowed" : "bg-accent hover:bg-accent-hover text-text-inverse"
        )}>
          {uploading ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Uploading…</> : <><Upload className="w-3.5 h-3.5" />Upload file</>}
          <input
            ref={inputRef}
            type="file"
            accept=".pdf,.doc,.docx,.txt,.md"
            className="hidden"
            disabled={uploading}
            onChange={(e) => handleFiles(e.target.files)}
          />
        </label>
      </div>
      <p className="text-2xs text-text-tertiary">PDF, Word, or plain text · max 10 MB</p>
      {error && <p className="text-xs text-danger">{error}</p>}
      {notice && <p className="text-xs text-text-secondary">{notice}</p>}
    </div>
  );
}

// ─── CandidateFilesSection ────────────────────────────────────────────────────

interface CandidateFilesSectionProps {
  candidateId: string;
}

export function CandidateFilesSection({ candidateId }: CandidateFilesSectionProps) {
  const [files, setFiles] = useState<DrawerFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(true);
  const [filesError, setFilesError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    fetch(`/api/candidates/${candidateId}/files`, { signal: controller.signal })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error("Request failed")))
      .then((data) => { setFiles(data); setFilesError(null); })
      .catch(() => { setFilesError("Could not load files"); })
      .finally(() => { clearTimeout(timeoutId); setFilesLoading(false); });
    return () => { clearTimeout(timeoutId); controller.abort(); };
  }, [candidateId]);

  return (
    <div>
      <p className="text-2xs font-semibold text-text-tertiary uppercase tracking-wide mb-3">Files</p>
      {filesLoading ? (
        <div className="flex items-center gap-2 text-xs text-text-tertiary">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />Loading…
        </div>
      ) : filesError ? (
        <p className="text-xs text-warning">{filesError}</p>
      ) : (
        <div className="space-y-2 mb-3">
          {files.length === 0 && (
            <p className="text-xs text-text-tertiary">No files uploaded yet.</p>
          )}
          {files.map((f) => (
            <DrawerFileRow
              key={f.id}
              file={f}
              candidateId={candidateId}
              onDeleted={(id) => setFiles((prev) => prev.filter((x) => x.id !== id))}
              // First CV (newest, since list comes back ordered desc) is
              // the candidate's primary resume — default-open the preview
              // so the JobAdder-like "see the CV the moment the drawer
              // opens" UX works without an extra click.
              defaultExpanded={f.id === files.find((x) => x.type === "cv")?.id}
            />
          ))}
        </div>
      )}
      <DrawerUploadZone
        candidateId={candidateId}
        onUploaded={(f) => setFiles((prev) => [f, ...prev])}
      />
    </div>
  );
}
