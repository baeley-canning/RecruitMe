"use client";

import { useCallback, useRef, useState } from "react";
import { Loader2, Upload } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Compact "Upload CV" button used inside the incomplete-capture warning
 * banner. Reuses `/api/candidates/[id]/files` (which already extracts CV
 * text, merges with any captured LinkedIn text, and re-scores). The button
 * is the recovery path when the LinkedIn extension produced a stub — the
 * recruiter has a CV, uploads it, and the candidate is re-scored against
 * the JD with proper data.
 */
export function UploadCvButton({
  candidateId,
  onUploaded,
}: {
  candidateId: string;
  /** Called after a successful upload + re-score so the parent can refresh
   *  the candidate row with the new matchScore / breakdown. */
  onUploaded?: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(null);
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", files[0]);
      form.append("type", "cv");
      const res = await fetch(`/api/candidates/${candidateId}/files`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setError(json.error ?? "Upload failed");
      } else {
        onUploaded?.();
      }
    } catch {
      setError("Upload failed — please try again");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }, [candidateId, onUploaded]);

  return (
    <div className="flex flex-col items-end gap-1">
      <label
        className={cn(
          "inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium cursor-pointer transition-colors flex-shrink-0",
          uploading
            ? "bg-amber-100 text-amber-500 cursor-not-allowed"
            : "bg-amber-600 hover:bg-amber-700 text-white",
        )}
        title="Upload candidate's CV — RecruitMe will merge it with the LinkedIn capture and re-score against this role."
      >
        {uploading ? (
          <>
            <Loader2 className="w-3.5 h-3.5 animate-spin" />Uploading…
          </>
        ) : (
          <>
            <Upload className="w-3.5 h-3.5" />Upload CV
          </>
        )}
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.doc,.docx,.txt,.md"
          className="hidden"
          disabled={uploading}
          onChange={(e) => handleFiles(e.target.files)}
        />
      </label>
      {error && (
        <span className="text-[11px] text-red-600">{error}</span>
      )}
    </div>
  );
}
