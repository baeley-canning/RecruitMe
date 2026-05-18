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
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[1210] p-4" onClick={onClose}>
      <div className="bg-surface-overlay rounded-xl shadow-overlay w-full max-w-lg max-h-[90vh] overflow-y-auto border border-separator" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-separator">
          <div>
            <h3 className="text-md font-semibold text-text-primary">Add Candidate</h3>
            <p className="text-xs text-text-secondary mt-0.5">
              Upload a CV or paste profile text — AI will extract their details.
            </p>
          </div>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          {/* CV upload */}
          <div>
            <label className="block text-md font-medium text-text-primary mb-1.5">
              Upload CV <span className="text-text-tertiary font-normal">(PDF, DOCX, TXT)</span>
            </label>
            <label className={`flex items-center gap-3 px-4 py-3 border border-dashed rounded-md cursor-pointer transition-colors ${
              extracting
                ? "border-accent bg-accent-subtle"
                : fileName
                ? "border-success bg-success-subtle"
                : "border-separator-strong hover:bg-surface-hover"
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
                  <Loader2 className="w-4 h-4 text-accent animate-spin flex-shrink-0" />
                  <span className="text-md text-accent">Extracting text…</span>
                </>
              ) : fileName ? (
                <>
                  <CheckCircle2 className="w-4 h-4 text-success flex-shrink-0" />
                  <span className="text-md text-success truncate flex-1">{fileName}</span>
                  <button type="button" onClick={clearFile} className="text-text-tertiary hover:text-text-primary flex-shrink-0">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </>
              ) : (
                <>
                  <Paperclip className="w-4 h-4 text-text-tertiary flex-shrink-0" />
                  <span className="text-md text-text-secondary">
                    Click to upload <span className="font-medium text-text-primary">PDF, DOCX or TXT</span>
                  </span>
                </>
              )}
            </label>
          </div>

          {/* Divider */}
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-separator" />
            </div>
            <div className="relative flex justify-center">
              <span className="bg-surface-overlay px-3 text-xs text-text-tertiary">or paste text</span>
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
              className="w-full px-3 py-2.5 border border-separator rounded bg-surface-sunken text-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:shadow-focus resize-none transition-all"
              rows={5}
              disabled={extracting || adding}
            />
          </div>

          {error && <p className="text-md text-danger">{error}</p>}

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
              <UserPlus className="w-3.5 h-3.5" />
              {adding ? "Adding…" : "Add to Library"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
