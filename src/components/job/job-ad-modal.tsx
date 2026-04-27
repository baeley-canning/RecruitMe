"use client";

import { useState, useEffect } from "react";
import { Loader2, AlertCircle, X, Copy, Check } from "lucide-react";

interface JobAdModalProps {
  jobId: string;
  onClose: () => void;
}

export function JobAdModal({ jobId, onClose }: JobAdModalProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [jobAd, setJobAd] = useState<{ headline: string; body: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch(`/api/jobs/${jobId}/generate-ad`, { method: "POST" })
      .then((r) => r.json())
      .then((data: { headline?: string; body?: string; error?: string }) => {
        if (data.error) setError(data.error);
        else setJobAd({ headline: data.headline ?? "", body: data.body ?? "" });
      })
      .catch(() => setError("Network error. Try again."))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const regenerate = () => {
    setJobAd(null);
    setError("");
    setLoading(true);
    fetch(`/api/jobs/${jobId}/generate-ad`, { method: "POST" })
      .then((r) => r.json())
      .then((data: { headline?: string; body?: string; error?: string }) => {
        if (data.error) setError(data.error);
        else setJobAd({ headline: data.headline ?? "", body: data.body ?? "" });
      })
      .catch(() => setError("Network error. Try again."))
      .finally(() => setLoading(false));
  };

  const copyAll = () => {
    if (!jobAd) return;
    navigator.clipboard.writeText(`${jobAd.headline}\n\n${jobAd.body}`).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-[1210] p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 flex-shrink-0">
          <div>
            <h3 className="font-semibold text-slate-900">Generated Job Ad</h3>
            <p className="text-xs text-slate-500 mt-0.5">AI-written advertisement based on parsed role requirements.</p>
          </div>
          <div className="flex items-center gap-2">
            {jobAd && (
              <button onClick={copyAll} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 transition-colors">
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? "Copied!" : "Copy All"}
              </button>
            )}
            <button onClick={onClose} className="text-slate-400 hover:text-slate-700 transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-4">
          {loading && (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <Loader2 className="w-6 h-6 text-blue-500 animate-spin" />
              <p className="text-sm text-slate-500">Writing your job ad…</p>
            </div>
          )}
          {error && !loading && (
            <div className="flex items-start gap-2 px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg">
              <AlertCircle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}
          {jobAd && !loading && (
            <>
              <div className="p-4 bg-blue-50 border border-blue-100 rounded-xl">
                <p className="text-xs font-semibold text-blue-600 uppercase tracking-wide mb-1">Headline</p>
                <p className="font-bold text-slate-900 text-lg leading-snug">{jobAd.headline}</p>
              </div>
              <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Body</p>
                <p className="text-sm text-slate-800 leading-relaxed whitespace-pre-wrap">{jobAd.body}</p>
              </div>
              <button onClick={regenerate} className="text-xs text-blue-600 hover:text-blue-700 font-medium">
                Regenerate
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
