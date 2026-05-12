"use client";

import { useState, useEffect } from "react";
import { X, Loader2, Copy, Check } from "lucide-react";

interface RejectionEmailModalProps {
  jobId: string;
  candidateId: string;
  candidateName: string;
  onClose: () => void;
}

export function RejectionEmailModal({ jobId, candidateId, candidateName, onClose }: RejectionEmailModalProps) {
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const generate = async () => {
    if (text) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/jobs/${jobId}/candidates/${candidateId}/rejection-email`, { method: "POST" });
      const data = await res.json() as { email?: string; error?: string };
      if (!res.ok || data.error) setError(data.error ?? "Generation failed");
      else setText(data.email ?? "");
    } catch {
      setError("Failed to generate. Try again.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { generate(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[1210] p-4" onClick={onClose}>
      <div className="bg-surface-overlay rounded-xl shadow-overlay w-full max-w-lg max-h-[90vh] overflow-y-auto border border-separator" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-separator">
          <div>
            <h3 className="text-md font-semibold text-text-primary">Rejection Email</h3>
            <p className="text-xs text-text-secondary mt-0.5">Drafted for {candidateName}</p>
          </div>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-6 py-5 space-y-4">
          {loading && (
            <div className="flex items-center gap-2 text-md text-text-secondary py-6 justify-center">
              <Loader2 className="w-4 h-4 animate-spin text-accent" />
              Drafting rejection email…
            </div>
          )}
          {error && <p className="text-md text-danger text-center">{error}</p>}
          {text && (
            <>
              <div className="p-4 bg-surface-sunken border border-separator rounded-md text-md text-text-primary leading-relaxed whitespace-pre-wrap">
                {text}
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => navigator.clipboard.writeText(text).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  })}
                  className="inline-flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary font-medium transition-colors"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? "Copied!" : "Copy email"}
                </button>
                <button
                  onClick={() => { setText(""); generate(); }}
                  className="text-xs text-accent hover:text-accent-hover font-medium transition-colors"
                >
                  Regenerate
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
