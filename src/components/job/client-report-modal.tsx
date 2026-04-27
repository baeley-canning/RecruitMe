"use client";

import { useState, useEffect } from "react";
import { Loader2, AlertCircle, X, Copy, Check, FileText } from "lucide-react";
import type { ParsedRole } from "@/lib/ai";
import { safeParseJson } from "@/lib/utils";

interface Candidate {
  id: string;
  name: string;
  status: string;
  profileText: string | null;
  matchScore: number | null;
}

interface ClientReportModalProps {
  jobId: string;
  jobTitle: string;
  jobParsedRole: string | null;
  candidates: Candidate[];
  onClose: () => void;
}

export function ClientReportModal({ jobId, jobTitle, jobParsedRole, candidates, onClose }: ClientReportModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [summaries, setSummaries] = useState<{ id: string; name: string; paragraph: string }[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);

  const shortlisted = candidates.filter((c) => c.status === "shortlisted");

  useEffect(() => {
    if (shortlisted.length === 0) return;
    setLoading(true);
    fetch(`/api/jobs/${jobId}/shortlist-summary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidates: shortlisted }),
    })
      .then((r) => r.json())
      .then((data: { summaries?: { id: string; name: string; paragraph: string }[]; error?: string }) => {
        if (data.error) setError(data.error);
        else setSummaries(data.summaries ?? []);
      })
      .catch(() => setError("Network error. Try again."))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const copyParagraph = (id: string, text: string) => {
    navigator.clipboard.writeText(text).then(() => { setCopiedId(id); setTimeout(() => setCopiedId(null), 2000); });
  };

  const copyAll = () => {
    if (summaries.length === 0) return;
    const parsedRole = safeParseJson<ParsedRole | null>(jobParsedRole, null);
    const header = `Shortlist Report — ${parsedRole?.title ?? jobTitle}\n${"=".repeat(50)}\n\n`;
    const body = summaries.map((s) => `${s.name}\n${s.paragraph}`).join("\n\n---\n\n");
    navigator.clipboard.writeText(header + body).then(() => { setCopiedAll(true); setTimeout(() => setCopiedAll(false), 2500); });
  };

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-[1210] p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 flex-shrink-0">
          <div>
            <h3 className="font-semibold text-slate-900">Client Report</h3>
            <p className="text-xs text-slate-500 mt-0.5">AI-generated recruiter summaries for shortlisted candidates.</p>
          </div>
          <div className="flex items-center gap-2">
            {summaries.length > 0 && (
              <button onClick={copyAll} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 transition-colors">
                {copiedAll ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                {copiedAll ? "Copied!" : "Copy All"}
              </button>
            )}
            <button onClick={onClose} className="text-slate-400 hover:text-slate-700 transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
        <div className="overflow-y-auto flex-1 px-6 py-5">
          {loading && (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <Loader2 className="w-6 h-6 text-violet-500 animate-spin" />
              <p className="text-sm text-slate-500">Claude is writing candidate summaries…</p>
            </div>
          )}
          {error && !loading && (
            <div className="flex items-start gap-2 px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg">
              <AlertCircle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}
          {summaries.length > 0 && (
            <div className="space-y-5">
              {summaries.map((s) => (
                <div key={s.id} className="group relative p-4 bg-slate-50 rounded-xl border border-slate-200">
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <p className="text-sm font-semibold text-slate-900">{s.name}</p>
                    <button onClick={() => copyParagraph(s.id, s.paragraph)}
                      className="flex-shrink-0 inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 transition-colors opacity-0 group-hover:opacity-100">
                      {copiedId === s.id ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
                      {copiedId === s.id ? "Copied" : "Copy"}
                    </button>
                  </div>
                  <p className="text-sm text-slate-700 leading-relaxed">{s.paragraph}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Trigger button that lives in the header — exported separately so the page can use it.
export function ClientReportButton({ shortlistCount, onClick }: { shortlistCount: number; onClick: () => void }) {
  if (shortlistCount === 0) return null;
  return (
    <button onClick={onClick}
      className="inline-flex items-center gap-2 px-3 py-2 border border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100 rounded-lg text-sm font-medium transition-colors">
      <FileText className="w-4 h-4" />
      Client Report
    </button>
  );
}
