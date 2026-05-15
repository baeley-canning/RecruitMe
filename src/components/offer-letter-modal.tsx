"use client";

import { useState, useEffect } from "react";
import { X, Loader2, Copy, Check } from "lucide-react";
import { Modal } from "./ui/modal";

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
    <Modal
      open
      onClose={onClose}
      labelledBy="offer-modal-title"
      className="bg-surface-overlay rounded-xl shadow-overlay w-full max-w-lg max-h-[90vh] overflow-y-auto border border-separator"
    >
        <div className="flex items-center justify-between px-6 py-4 border-b border-separator">
          <div>
            <h3 id="offer-modal-title" className="text-md font-semibold text-text-primary">Offer Letter</h3>
            <p className="text-xs text-text-secondary mt-0.5">Drafted for {candidateName}</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-text-tertiary hover:text-text-primary transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-6 py-5 space-y-4">
          {loading && (
            <div className="flex items-center gap-2 text-md text-text-secondary py-6 justify-center">
              <Loader2 className="w-4 h-4 animate-spin text-accent" />
              Drafting offer letter…
            </div>
          )}
          {error && <p className="text-md text-danger text-center">{error}</p>}
          {data && (
            <>
              <div className="p-3 bg-success-subtle border border-separator rounded-md">
                <p className="text-xs font-medium text-success mb-0.5">Subject line</p>
                <p className="text-md text-text-primary">{data.subject}</p>
              </div>
              <div className="p-4 bg-surface-sunken border border-separator rounded-md text-md text-text-primary leading-relaxed whitespace-pre-wrap">
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
                  className="inline-flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary font-medium transition-colors"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? "Copied!" : "Copy letter"}
                </button>
                <button
                  onClick={() => { setData(null); generate(); }}
                  className="text-xs text-accent hover:text-accent-hover font-medium transition-colors"
                >
                  Regenerate
                </button>
              </div>
            </>
          )}
        </div>
    </Modal>
  );
}
