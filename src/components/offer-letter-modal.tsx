"use client";

import { useState, useEffect } from "react";
import { X, Loader2, Copy, Check } from "lucide-react";

interface OfferLetterModalProps {
  jobId: string;
  candidateId: string;
  candidateName: string;
  onClose: () => void;
}

export function OfferLetterModal({ jobId, candidateId, candidateName, onClose }: OfferLetterModalProps) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<{ subject: string; body: string } | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const generate = async () => {
    if (data) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/jobs/${jobId}/candidates/${candidateId}/offer-letter`, { method: "POST" });
      const json = await res.json() as { subject?: string; body?: string; error?: string };
      if (!res.ok || json.error) setError(json.error ?? "Generation failed");
      else setData({ subject: json.subject ?? "", body: json.body ?? "" });
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
            <h3 className="font-semibold text-slate-900">Offer Letter</h3>
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
              Drafting offer letter…
            </div>
          )}
          {error && <p className="text-sm text-red-600 text-center">{error}</p>}
          {data && (
            <>
              <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg">
                <p className="text-xs font-medium text-emerald-700 mb-0.5">Subject line</p>
                <p className="text-sm text-slate-800">{data.subject}</p>
              </div>
              <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-800 leading-relaxed whitespace-pre-wrap">
                {data.body}
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => {
                    const full = `Subject: ${data.subject}\n\n${data.body}`;
                    navigator.clipboard.writeText(full).then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    });
                  }}
                  className="inline-flex items-center gap-1.5 text-xs text-slate-600 hover:text-slate-900 font-medium"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? "Copied!" : "Copy letter"}
                </button>
                <button
                  onClick={() => { setData(null); generate(); }}
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
