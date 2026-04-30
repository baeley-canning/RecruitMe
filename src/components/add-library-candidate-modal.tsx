"use client";

import { useRef, useState } from "react";
import { Loader2, X, CheckCircle2, Paperclip, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";

interface AddLibraryCandidateModalProps {
  onComplete: () => void;
  onClose: () => void;
}

export function AddLibraryCandidateModal({ onComplete, onClose }: AddLibraryCandidateModalProps) {
  const [profileText, setProfileText] = useState("");
  const [fileName, setFileName] = useState("");
  const [fileObj, setFileObj] = useState<File | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    setFileName(file.name);
    setFileObj(file);
    setError("");
    setExtracting(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const data = await res.json() as { text?: string; error?: string };
      if (!res.ok || data.error) {
        setError(data.error ?? "Could not read file");
        setFileName("");
        setFileObj(null);
      } else {
        setProfileText(data.text ?? "");
      }
    } catch {
      setError("Failed to upload file");
      setFileName("");
      setFileObj(null);
    } finally {
      setExtracting(false);
    }
  };

  const handleAdd = async () => {
    if (!profileText.trim()) {
      setError("Upload a CV or paste some profile text first.");
      return;
    }
    setAdding(true);
    setError("");
    try {
      // 1. Create the candidate record (AI extracts name/headline/location).
      const res = await fetch("/api/candidates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileText: profileText.trim() }),
      });
      const created = await res.json() as { id?: string; error?: string };
      if (!res.ok || !created.id) {
        setError(created.error ?? "Failed to create candidate");
        return;
      }

      // 2. Attach the CV file (best-effort — candidate already created above).
      if (fileObj) {
        try {
          const fd = new FormData();
          fd.append("file", fileObj);
          fd.append("type", "cv");
          await fetch(`/api/candidates/${created.id}/files`, { method: "POST", body: fd });
        } catch {
          // File attachment failed but candidate was created — continue.
        }
      }

      onComplete();
    } finally {
      setAdding(false);
    }
  };

  const clearFile = (e: { preventDefault(): void }) => {
    e.preventDefault();
    setFileName("");
    setFileObj(null);
    setProfileText("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-[1210] p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <div>
            <h3 className="font-semibold text-slate-900">Add Candidate</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Upload a CV or paste profile text — AI will extract their details.
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          {/* CV upload */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">
              Upload CV <span className="text-slate-400 font-normal">(PDF, DOCX, TXT)</span>
            </label>
            <label className={`flex items-center gap-3 px-4 py-3 border-2 border-dashed rounded-xl cursor-pointer transition-colors ${
              extracting
                ? "border-blue-300 bg-blue-50"
                : fileName
                ? "border-emerald-300 bg-emerald-50"
                : "border-slate-200 hover:border-blue-300 hover:bg-blue-50"
            }`}>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.docx,.doc,.txt"
                className="sr-only"
                disabled={extracting || adding}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleFile(file);
                  e.target.value = "";
                }}
              />
              {extracting ? (
                <>
                  <Loader2 className="w-4 h-4 text-blue-500 animate-spin flex-shrink-0" />
                  <span className="text-sm text-blue-600">Extracting text…</span>
                </>
              ) : fileName ? (
                <>
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
                  <span className="text-sm text-emerald-700 truncate flex-1">{fileName}</span>
                  <button type="button" onClick={clearFile} className="text-slate-400 hover:text-slate-600 flex-shrink-0">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </>
              ) : (
                <>
                  <Paperclip className="w-4 h-4 text-slate-400 flex-shrink-0" />
                  <span className="text-sm text-slate-500">
                    Click to upload <span className="font-medium text-slate-700">PDF, DOCX or TXT</span>
                  </span>
                </>
              )}
            </label>
          </div>

          {/* Divider */}
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-slate-200" />
            </div>
            <div className="relative flex justify-center">
              <span className="bg-white px-3 text-xs text-slate-400">or paste text</span>
            </div>
          </div>

          {/* Paste area */}
          <div>
            <textarea
              value={profileText}
              onChange={(e) => {
                setProfileText(e.target.value);
                if (fileName && e.target.value !== profileText) {
                  setFileName("");
                  setFileObj(null);
                }
              }}
              placeholder="Paste CV or LinkedIn profile text here — AI will extract the candidate's name, headline, and location."
              className="w-full px-3.5 py-3 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              rows={5}
              disabled={extracting || adding}
            />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex gap-3 pt-1">
            <Button variant="secondary" onClick={onClose} className="flex-1" disabled={adding || extracting}>
              Cancel
            </Button>
            <Button
              onClick={handleAdd}
              loading={adding}
              disabled={adding || extracting || !profileText.trim()}
              className="flex-1"
            >
              <UserPlus className="w-4 h-4" />
              {adding ? "Adding…" : "Add to Library"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
