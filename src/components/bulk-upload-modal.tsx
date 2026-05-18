"use client";

import { useState } from "react";
import { X, Upload, FileText, Loader2, CheckCircle2 } from "lucide-react";
import { Button } from "./ui/button";
import { Modal } from "./ui/modal";

interface BulkFileEntry {
  id: string;
  file: File;
  status: "queued" | "extracting" | "scoring" | "done" | "error";
  candidateName?: string;
  error?: string;
}

interface BulkUploadModalProps {
  jobId: string;
  onClose: () => void;
  onComplete: () => void;
}

export function BulkUploadModal({ jobId, onClose, onComplete }: BulkUploadModalProps) {
  const [files, setFiles] = useState<BulkFileEntry[]>([]);
  const [processing, setProcessing] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const addFiles = (fileList: FileList | File[]) => {
    const allowed = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/msword",
      "text/plain",
    ];
    const entries: BulkFileEntry[] = Array.from(fileList)
      .filter((f) => allowed.includes(f.type) || /\.(pdf|docx?|txt)$/i.test(f.name))
      .map((f) => ({ id: Math.random().toString(36).slice(2), file: f, status: "queued" as const }));
    setFiles((prev) => [...prev, ...entries]);
  };

  const processAll = async () => {
    setProcessing(true);
    const queued = files.filter((e) => e.status === "queued");

    const processOne = async (entry: BulkFileEntry) => {
      const update = (patch: Partial<BulkFileEntry>) =>
        setFiles((prev) => prev.map((e) => (e.id === entry.id ? { ...e, ...patch } : e)));

      update({ status: "extracting" });
      try {
        const form = new FormData();
        form.append("file", entry.file);
        const uploadRes = await fetch("/api/upload", { method: "POST", body: form });
        const uploadData = (await uploadRes.json()) as { text?: string; error?: string };
        if (!uploadRes.ok || !uploadData.text) {
          update({ status: "error", error: uploadData.error ?? "Could not extract text" });
          return;
        }
        update({ status: "scoring" });
        const createRes = await fetch(`/api/jobs/${jobId}/candidates`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profileText: uploadData.text, autoScore: true }),
        });
        const created = (await createRes.json()) as { name?: string; error?: string };
        if (!createRes.ok) {
          update({ status: "error", error: created.error ?? "Failed to create candidate" });
          return;
        }
        update({ status: "done", candidateName: created.name ?? entry.file.name });
      } catch (err) {
        update({ status: "error", error: err instanceof Error ? err.message : "Unknown error" });
      }
    };

    // Serial — each CV scores with Claude before the next starts (avoids parallel API bursts)
    for (const entry of queued) {
      await processOne(entry);
    }

    onComplete();
    setProcessing(false);
  };

  const done = files.filter((e) => e.status === "done").length;
  const queued = files.filter((e) => e.status === "queued").length;

  return (
    <Modal open onClose={() => { if (!processing) onClose(); }} dismissable={!processing} labelledBy="bulk-upload-title">
      <div className="flex items-center justify-between px-4 py-3 border-b border-separator flex-shrink-0">
        <div>
          <h3 id="bulk-upload-title" className="text-md font-semibold text-text-primary">Upload CVs</h3>
          <p className="text-xs text-text-tertiary mt-0.5">
            Drop PDF, DOCX, or TXT files — each CV becomes a candidate and is auto-scored
          </p>
        </div>
        <button
          onClick={() => { if (!processing) onClose(); }}
          className="h-7 w-7 rounded flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
          aria-label="Close upload modal"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {!processing && (
        <div
          className={`mx-4 mt-4 border border-dashed rounded-md p-6 text-center transition-colors cursor-pointer ${
            dragOver
              ? "border-accent bg-accent-subtle"
              : "border-separator-strong hover:border-accent hover:bg-surface-hover"
          }`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
          onClick={() => document.getElementById("bulk-cv-input")?.click()}
        >
          <Upload className="w-6 h-6 text-text-tertiary mx-auto mb-2" />
          <p className="text-md font-medium text-text-primary">Drop CVs here or click to browse</p>
          <p className="text-xs text-text-tertiary mt-1">PDF, DOCX, DOC, TXT · multiple files supported</p>
          <input
            id="bulk-cv-input"
            type="file"
            multiple
            accept=".pdf,.docx,.doc,.txt"
            className="hidden"
            onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }}
          />
        </div>
      )}

      {files.length > 0 && (
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-1 min-h-0">
          {files.map((entry) => (
            <div
              key={entry.id}
              className="flex items-center gap-2.5 px-3 py-2 rounded border border-separator bg-surface-sunken"
            >
              <FileText className="w-3.5 h-3.5 text-text-tertiary flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-base font-medium text-text-primary truncate">{entry.file.name}</p>
                {entry.candidateName && <p className="text-xs text-success">{entry.candidateName}</p>}
                {entry.error && <p className="text-xs text-danger">{entry.error}</p>}
              </div>
              <div className="flex-shrink-0 flex items-center gap-1.5">
                {entry.status === "queued" && <span className="text-xs text-text-tertiary">Queued</span>}
                {entry.status === "extracting" && (
                  <span className="text-xs text-accent flex items-center gap-1">
                    <Loader2 className="w-3 h-3 animate-spin" /> Reading…
                  </span>
                )}
                {entry.status === "scoring" && (
                  <span className="text-xs text-llama flex items-center gap-1">
                    <Loader2 className="w-3 h-3 animate-spin" /> Scoring…
                  </span>
                )}
                {entry.status === "done" && (
                  <span className="text-xs text-success flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" /> Done
                  </span>
                )}
                {entry.status === "error" && <span className="text-xs text-danger">Failed</span>}
                {!processing && entry.status === "queued" && (
                  <button
                    onClick={() => setFiles((p) => p.filter((e) => e.id !== entry.id))}
                    className="h-6 w-6 rounded flex items-center justify-center text-text-tertiary hover:text-danger hover:bg-surface-hover transition-colors"
                    aria-label={`Remove ${entry.file.name} from upload queue`}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="px-4 py-3 border-t border-separator flex-shrink-0 flex items-center justify-between gap-3">
        <div className="text-xs text-text-tertiary">
          {files.length > 0
            ? <><span className="data-mono">{done} / {files.length}</span> processed</>
            : "No files selected"}
        </div>
        <div className="flex items-center gap-2">
          {!processing && (
            <Button variant="ghost" size="md" onClick={onClose}>
              {done > 0 ? "Done" : "Cancel"}
            </Button>
          )}
          {queued > 0 && !processing && (
            <Button onClick={processAll}>
              <Upload className="w-4 h-4" />
              Process {queued} CV{queued !== 1 ? "s" : ""}
            </Button>
          )}
          {processing && (
            <span className="text-md text-text-secondary flex items-center gap-1.5">
              <Loader2 className="w-4 h-4 animate-spin text-accent" /> Processing…
            </span>
          )}
        </div>
      </div>
    </Modal>
  );
}
