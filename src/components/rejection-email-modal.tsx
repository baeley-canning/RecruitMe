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
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-[1210] p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <div>
            <h3 className="font-semibold text-slate-900">Rejection Email</h3>
            <p className="text-xs text-slate-500 mt-0.5">Drafted for {candidateName}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="px-6 py-5 space-y-4">
          {loading && (
            <div className="flex items-center gap-2 text-sm text-slate-500 py-6 justify-center">
              <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
              Drafting rejection email…
            </div>
          )}
          {error && <p className="text-sm text-red-600 text-center">{error}</p>}
          {text && (
            <>
              <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-800 leading-relaxed whitespace-pre-wrap">
                {text}
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => navigator.clipboard.writeText(text).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  })}
                  className="inline-flex items-center gap-1.5 text-xs text-slate-600 hover:text-slate-900 font-medium"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? "Copied!" : "Copy email"}
                </button>
                <button
                  onClick={() => { setText(""); generate(); }}
                  className="text-xs text-blue-600 hover:text-blue-700 font-medium"
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
