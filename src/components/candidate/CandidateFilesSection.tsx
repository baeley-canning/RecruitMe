"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { Download, Loader2, Trash2, Upload } from "lucide-react";
import { cn, timeAgo } from "@/lib/utils";

export interface DrawerFile {
  id: string;
  type: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function drawerTypeLabel(type: string) {
  if (type === "cv") return "CV";
  if (type === "cover_letter") return "Cover Letter";
  return "Other";
}

function drawerTypeColor(type: string) {
  if (type === "cv") return "bg-blue-50 text-blue-600 border-blue-100";
  if (type === "cover_letter") return "bg-purple-50 text-purple-600 border-purple-100";
  return "bg-slate-50 text-slate-500 border-slate-100";
}

function DrawerFileRow({ file, candidateId, onDeleted }: { file: DrawerFile; candidateId: string; onDeleted: (id: string) => void }) {
  const [deleting, setDeleting] = useState(false);
  const handleDelete = async () => {
    if (!confirm(`Delete "${file.filename}"?`)) return;
    setDeleting(true);
    await fetch(`/api/candidates/${candidateId}/files/${file.id}`, { method: "DELETE" });
    onDeleted(file.id);
  };
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white border border-slate-100 group hover:border-slate-200 transition-colors">
      <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-medium border flex-shrink-0", drawerTypeColor(file.type))}>
        {drawerTypeLabel(file.type)}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-slate-700 truncate">{file.filename}</p>
        <p className="text-[10px] text-slate-400" suppressHydrationWarning>{formatBytes(file.size)} · {timeAgo(new Date(file.createdAt))}</p>
      </div>
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <a
          href={`/api/candidates/${candidateId}/files/${file.id}`}
          download={file.filename}
          className="p-1 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
          title="Download"
        >
          <Download className="w-3.5 h-3.5" />
        </a>
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="p-1 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors disabled:opacity-50"
          title="Delete"
        >
          {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
        </button>
      </div>
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
        setError(json.error ?? "Upload failed");
      } else {
        const data = await res.json();
        onUploaded(data);
        if (type === "cv" && data.scored === false) {
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
          className="text-xs border border-slate-200 rounded-lg px-2 py-1.5 bg-white text-slate-600 focus:outline-none focus:border-blue-400"
        >
          <option value="cv">CV / Resume</option>
          <option value="cover_letter">Cover Letter</option>
          <option value="other">Other</option>
        </select>
        <label className={cn(
          "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-colors",
          uploading ? "bg-slate-100 text-slate-400 cursor-not-allowed" : "bg-blue-600 hover:bg-blue-500 text-white"
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
      <p className="text-[10px] text-slate-400">PDF, Word, or plain text · max 10 MB</p>
      {error && <p className="text-xs text-red-500">{error}</p>}
      {notice && <p className="text-xs text-slate-500">{notice}</p>}
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
      .catch((e) => {
        if (e.name !== "AbortError") {
          setFilesError("Could not load files");
        } else {
          setFilesError("Could not load files");
        }
        setFilesLoading(false);
      })
      .finally(() => { clearTimeout(timeoutId); setFilesLoading(false); });
    return () => { clearTimeout(timeoutId); controller.abort(); };
  }, [candidateId]);

  return (
    <div>
      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Files</p>
      {filesLoading ? (
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />Loading…
        </div>
      ) : filesError ? (
        <p className="text-xs text-amber-600">{filesError}</p>
      ) : (
        <div className="space-y-2 mb-3">
          {files.length === 0 && (
            <p className="text-xs text-slate-400">No files uploaded yet.</p>
          )}
          {files.map((f) => (
            <DrawerFileRow
              key={f.id}
              file={f}
              candidateId={candidateId}
              onDeleted={(id) => setFiles((prev) => prev.filter((x) => x.id !== id))}
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
