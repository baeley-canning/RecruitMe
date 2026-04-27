"use client";

import { useState } from "react";
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

  // Kick off generation on mount
  if (!loading && !data && !error) generate();

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-[1210] p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <div>
            <h3 className="font-semibold text-slate-900">Outreach Message</h3>
            <p className="text-xs text-slate-500 mt-0.5">Personalised for {candidateName}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-5">
          {loading && (
            <div className="flex items-center gap-2 text-sm text-slate-500 py-6 justify-center">
              <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
              Generating personalised message…
            </div>
          )}
          {error && <p className="text-sm text-red-600 py-4 text-center">{error}</p>}
          {data && (
            <div className="space-y-4">
              <div className="flex gap-1 p-1 bg-slate-100 rounded-lg">
                {(["linkedin", "email"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={cn(
                      "flex-1 py-1.5 text-xs font-medium rounded-md transition-colors capitalize",
                      tab === t ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
                    )}
                  >
                    {t === "linkedin" ? "LinkedIn message" : "Email"}
                  </button>
                ))}
              </div>

              {tab === "linkedin" && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-medium text-slate-500">
                      Connection request · {data.linkedin.length}/300 chars
                    </p>
                    <CopyButton text={data.linkedin} />
                  </div>
                  <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-800 leading-relaxed whitespace-pre-wrap">
                    {data.linkedin}
                  </div>
                  <p className="text-xs text-slate-400 mt-2">
                    Paste into the LinkedIn &ldquo;Add a note&rdquo; field when sending a connection request.
                  </p>
                </div>
              )}

              {tab === "email" && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-medium text-slate-500">Full email</p>
                    <CopyButton text={data.email} />
                  </div>
                  <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-800 leading-relaxed whitespace-pre-wrap">
                    {data.email}
                  </div>
                </div>
              )}

              <button
                onClick={() => { setData(null); generate(); }}
                className="text-xs text-blue-600 hover:text-blue-700 font-medium"
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
