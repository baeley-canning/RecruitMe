"use client";

import { useState } from "react";
import { X, Upload, FileText, Loader2, CheckCircle2 } from "lucide-react";
import { Button } from "./ui/button";

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
    const BATCH = 3;
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

    for (let i = 0; i < queued.length; i += BATCH) {
      await Promise.all(queued.slice(i, i + BATCH).map(processOne));
    }

    onComplete();
    setProcessing(false);
  };

  const done = files.filter((e) => e.status === "done").length;
  const queued = files.filter((e) => e.status === "queued").length;

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-[1210] p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 flex-shrink-0">
          <div>
            <h3 className="font-semibold text-slate-900">Upload CVs</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Drop PDF, DOCX, or TXT files — each CV becomes a candidate and is auto-scored
            </p>
          </div>
          <button onClick={() => { if (!processing) onClose(); }} className="text-slate-400 hover:text-slate-700">
            <X className="w-5 h-5" />
          </button>
        </div>

        {!processing && (
          <div
            className={`mx-6 mt-5 border-2 border-dashed rounded-xl p-8 text-center transition-colors cursor-pointer ${
              dragOver ? "border-blue-400 bg-blue-50" : "border-slate-200 hover:border-blue-300 hover:bg-slate-50"
            }`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
            onClick={() => document.getElementById("bulk-cv-input")?.click()}
          >
            <Upload className="w-8 h-8 text-slate-300 mx-auto mb-2" />
            <p className="text-sm font-medium text-slate-600">Drop CVs here or click to browse</p>
            <p className="text-xs text-slate-400 mt-1">PDF, DOCX, DOC, TXT · multiple files supported</p>
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
          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-1.5 min-h-0">
            {files.map((entry) => (
              <div key={entry.id} className="flex items-center gap-3 px-3 py-2 rounded-lg border border-slate-100 bg-slate-50">
                <FileText className="w-4 h-4 text-slate-400 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-slate-700 truncate">{entry.file.name}</p>
                  {entry.candidateName && <p className="text-[11px] text-emerald-600">{entry.candidateName}</p>}
                  {entry.error && <p className="text-[11px] text-red-500">{entry.error}</p>}
                </div>
                <div className="flex-shrink-0 flex items-center gap-1.5">
                  {entry.status === "queued" && <span className="text-[11px] text-slate-400">Queued</span>}
                  {entry.status === "extracting" && (
                    <span className="text-[11px] text-blue-500 flex items-center gap-1">
                      <Loader2 className="w-3 h-3 animate-spin" /> Reading…
                    </span>
                  )}
                  {entry.status === "scoring" && (
                    <span className="text-[11px] text-violet-500 flex items-center gap-1">
                      <Loader2 className="w-3 h-3 animate-spin" /> Scoring…
                    </span>
                  )}
                  {entry.status === "done" && (
                    <span className="text-[11px] text-emerald-600 flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3" /> Done
                    </span>
                  )}
                  {entry.status === "error" && <span className="text-[11px] text-red-500">Failed</span>}
                  {!processing && entry.status === "queued" && (
                    <button onClick={() => setFiles((p) => p.filter((e) => e.id !== entry.id))}
                      className="text-slate-300 hover:text-red-400 ml-1">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="px-6 py-4 border-t border-slate-100 flex-shrink-0 flex items-center justify-between gap-3">
          <div className="text-xs text-slate-400">
            {files.length > 0 ? `${done} / ${files.length} processed` : "No files selected"}
          </div>
          <div className="flex items-center gap-2">
            {!processing && (
              <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 hover:text-slate-900">
                {done > 0 ? "Done" : "Cancel"}
              </button>
            )}
            {queued > 0 && !processing && (
              <Button onClick={processAll}>
                <Upload className="w-4 h-4" />
                Process {queued} CV{queued !== 1 ? "s" : ""}
              </Button>
            )}
            {processing && (
              <span className="text-sm text-slate-500 flex items-center gap-1.5">
                <Loader2 className="w-4 h-4 animate-spin text-blue-500" /> Processing…
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
