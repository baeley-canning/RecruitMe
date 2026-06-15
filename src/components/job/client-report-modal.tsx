"use client";

import { useState, useEffect } from "react";
import { Loader2, AlertCircle, X, Copy, Check } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import type { ParsedRole } from "@/lib/ai";
import { safeParseJson } from "@/lib/utils";
import { formatApiError } from "@/lib/format";

// Must match CandidateSummaryInputSchema in /api/jobs/[id]/shortlist-summary/route.ts
// (plus `status` for the shortlisted filter below). Tightened so TS catches
// any caller that doesn't pass the full shape the server requires.
interface Candidate {
  id: string;
  name: string;
  status: string;
  headline: string | null;
  location: string | null;
  matchScore: number | null;
  matchReason: string | null;
  // Optional: the job-list payload strips these (see job-candidate-select.ts) —
  // the report builds from what's present and tolerates their absence.
  scoreBreakdown?: string | null;
  acceptanceScore: number | null;
  acceptanceReason: string | null;
  notes: string | null;
  linkedinUrl: string | null;
  profileText?: string | null;
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
      .then(async (r) => ({ ok: r.ok, body: await r.json() }))
      .then(({ ok, body }) => {
        if (!ok) {
          setError(formatApiError(body, "Failed to generate summaries."));
          return;
        }
        const data = body as { summaries?: { id: string; name: string; paragraph: string }[] };
        setSummaries(data.summaries ?? []);
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
    <Modal
      open={true}
      onClose={onClose}
      labelledBy="client-report-title"
      className="bg-surface-overlay text-text-primary rounded-xl shadow-overlay w-full max-w-2xl max-h-[90vh] flex flex-col"
    >
      <div className="flex items-center justify-between px-5 py-3 border-b border-separator flex-shrink-0">
        <div>
          <h3 id="client-report-title" className="text-md font-semibold text-text-primary">Client Report</h3>
          <p className="text-xs text-text-secondary mt-0.5">AI-generated recruiter summaries for shortlisted candidates.</p>
        </div>
        <div className="flex items-center gap-2">
          {summaries.length > 0 && (
            <button onClick={copyAll} className="inline-flex items-center gap-1.5 h-7 px-3 text-xs font-medium rounded bg-surface-hover hover:bg-surface-overlay text-text-primary border border-separator transition-colors">
              {copiedAll ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
              {copiedAll ? "Copied!" : "Copy All"}
            </button>
          )}
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary transition-colors" aria-label="Close">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      <div className="overflow-y-auto flex-1 px-5 py-4">
        {loading && (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <Loader2 className="w-5 h-5 text-llama animate-spin" />
            <p className="text-base text-text-secondary">Claude is writing candidate summaries…</p>
          </div>
        )}
        {error && !loading && (
          <div className="flex items-start gap-2 px-3 py-2 bg-danger-subtle border-l-2 border-danger rounded-sm">
            <AlertCircle className="w-3.5 h-3.5 text-danger flex-shrink-0 mt-0.5" />
            <p className="text-base text-danger">{error}</p>
          </div>
        )}
        {summaries.length > 0 && (
          <div className="space-y-4">
            {summaries.map((s) => (
              <div key={s.id} className="group relative p-4 bg-surface-sunken rounded border border-separator">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <p className="text-md font-semibold text-text-primary">{s.name}</p>
                  <button onClick={() => copyParagraph(s.id, s.paragraph)}
                    className="flex-shrink-0 inline-flex items-center gap-1 px-2 py-1 text-xs rounded-sm border border-separator bg-surface-raised text-text-secondary hover:bg-surface-hover transition-colors opacity-0 group-hover:opacity-100">
                    {copiedId === s.id ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
                    {copiedId === s.id ? "Copied" : "Copy"}
                  </button>
                </div>
                <p className="text-base text-text-secondary leading-relaxed">{s.paragraph}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

