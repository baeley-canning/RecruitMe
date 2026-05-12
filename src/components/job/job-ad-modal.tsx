"use client";

import { useState, useEffect } from "react";
import { Loader2, AlertCircle, X, Copy, Check } from "lucide-react";
import { Modal } from "@/components/ui/modal";

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
    <Modal
      open={true}
      onClose={onClose}
      labelledBy="job-ad-title"
      className="bg-surface-overlay text-text-primary rounded-xl shadow-overlay w-full max-w-2xl max-h-[90vh] flex flex-col"
    >
      <div className="flex items-center justify-between px-5 py-3 border-b border-separator flex-shrink-0">
        <div>
          <h3 id="job-ad-title" className="text-md font-semibold text-text-primary">Generated Job Ad</h3>
          <p className="text-xs text-text-secondary mt-0.5">AI-written advertisement based on parsed role requirements.</p>
        </div>
        <div className="flex items-center gap-2">
          {jobAd && (
            <button onClick={copyAll} className="inline-flex items-center gap-1.5 h-7 px-3 text-xs font-medium rounded bg-surface-hover hover:bg-surface-overlay text-text-primary border border-separator transition-colors">
              {copied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? "Copied!" : "Copy All"}
            </button>
          )}
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary transition-colors" aria-label="Close">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      <div className="overflow-y-auto flex-1 px-5 py-4 space-y-4">
        {loading && (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <Loader2 className="w-5 h-5 text-accent animate-spin" />
            <p className="text-base text-text-secondary">Writing your job ad…</p>
          </div>
        )}
        {error && !loading && (
          <div className="flex items-start gap-2 px-3 py-2 bg-danger-subtle border-l-2 border-danger rounded-sm">
            <AlertCircle className="w-3.5 h-3.5 text-danger flex-shrink-0 mt-0.5" />
            <p className="text-base text-danger">{error}</p>
          </div>
        )}
        {jobAd && !loading && (
          <>
            <div className="p-4 bg-accent-subtle border border-separator rounded">
              <p className="text-2xs font-semibold text-accent uppercase tracking-wide mb-1">Headline</p>
              <p className="font-semibold text-text-primary text-lg leading-snug">{jobAd.headline}</p>
            </div>
            <div className="p-4 bg-surface-sunken border border-separator rounded">
              <p className="text-2xs font-semibold text-text-tertiary uppercase tracking-wide mb-2">Body</p>
              <p className="text-base text-text-primary leading-relaxed whitespace-pre-wrap">{jobAd.body}</p>
            </div>
            <button onClick={regenerate} className="text-xs text-accent hover:text-accent-hover font-medium">
              Regenerate
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
