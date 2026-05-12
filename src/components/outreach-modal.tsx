"use client";

import { useState, useEffect } from "react";
import { X, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { CopyButton } from "./copy-button";

interface OutreachMessage {
  linkedin: string;
  email: string;
}

interface OutreachModalProps {
  jobId: string;
  candidateId: string;
  candidateName: string;
  onClose: () => void;
}

export function OutreachModal({ jobId, candidateId, candidateName, onClose }: OutreachModalProps) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<OutreachMessage | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"linkedin" | "email">("linkedin");

  const generate = async () => {
    if (data) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/jobs/${jobId}/candidates/${candidateId}/outreach`, { method: "POST" });
      const json = await res.json() as OutreachMessage & { error?: string };
      if (!res.ok || json.error) setError(json.error ?? "Generation failed");
      else setData(json);
    } catch {
      setError("Failed to generate message.");
    } finally {
      setLoading(false);
    }
  };

  // Kick off generation once on mount
  useEffect(() => { generate(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[1210] p-4" onClick={onClose}>
      <div className="bg-surface-overlay rounded-xl shadow-overlay w-full max-w-lg max-h-[90vh] overflow-y-auto border border-separator" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-separator">
          <div>
            <h3 className="text-md font-semibold text-text-primary">Outreach Message</h3>
            <p className="text-xs text-text-secondary mt-0.5">Personalised for {candidateName}</p>
          </div>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-6 py-5">
          {loading && (
            <div className="flex items-center gap-2 text-md text-text-secondary py-6 justify-center">
              <Loader2 className="w-4 h-4 animate-spin text-accent" />
              Generating personalised message…
            </div>
          )}
          {error && <p className="text-md text-danger py-4 text-center">{error}</p>}
          {data && (
            <div className="space-y-4">
              <div className="flex gap-1 p-1 bg-surface-sunken rounded-md border border-separator">
                {(["linkedin", "email"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={cn(
                      "flex-1 py-1.5 text-xs font-medium rounded transition-colors capitalize",
                      tab === t ? "bg-surface-hover text-text-primary" : "text-text-secondary hover:text-text-primary"
                    )}
                  >
                    {t === "linkedin" ? "LinkedIn message" : "Email"}
                  </button>
                ))}
              </div>

              {tab === "linkedin" && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-medium text-text-secondary data-mono">
                      Connection request · {data.linkedin.length}/300 chars
                    </p>
                    <CopyButton text={data.linkedin} />
                  </div>
                  <div className="p-3 bg-surface-sunken border border-separator rounded-md text-md text-text-primary leading-relaxed whitespace-pre-wrap">
                    {data.linkedin}
                  </div>
                  <p className="text-xs text-text-tertiary mt-2">
                    Paste into the LinkedIn &ldquo;Add a note&rdquo; field when sending a connection request.
                  </p>
                </div>
              )}

              {tab === "email" && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-medium text-text-secondary">Full email</p>
                    <CopyButton text={data.email} />
                  </div>
                  <div className="p-3 bg-surface-sunken border border-separator rounded-md text-md text-text-primary leading-relaxed whitespace-pre-wrap">
                    {data.email}
                  </div>
                </div>
              )}

              <button
                onClick={() => { setData(null); generate(); }}
                className="text-xs text-accent hover:text-accent-hover font-medium transition-colors"
              >
                Regenerate
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
