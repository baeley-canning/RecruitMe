"use client";

import { useEffect, useState, useCallback } from "react";
import { Send, Building2, ChevronDown, ChevronUp } from "lucide-react";

interface SubmissionRow {
  id: string;
  candidateId: string;
  clientId: string | null;
  submittedAt: string;
  status: string;
  notes: string | null;
  candidate: { id: string; name: string; headline: string | null; status: string; matchScore: number | null } | null;
  client: { id: string; name: string } | null;
}

const STATUS_TOKENS: Record<string, string> = {
  sent:       "bg-accent-subtle text-accent",
  viewed:     "bg-surface-hover text-text-secondary",
  interested: "bg-success-subtle text-success",
  rejected:   "bg-surface-hover text-text-tertiary",
  on_hold:    "bg-warning-subtle text-warning",
};

/**
 * Submissions made to clients for this job. Read-back surface for the CRM
 * submit flow (previously write-only — a submit left no visible trace).
 * Flag-gated by the caller (crmEnabled). Refetches when refreshKey changes.
 */
export function SubmissionsCard({ jobId, refreshKey = 0 }: { jobId: string; refreshKey?: number }) {
  const [rows, setRows] = useState<SubmissionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/jobs/${jobId}/submissions`, { cache: "no-store" });
      if (res.ok) setRows(await res.json());
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  // Nothing submitted yet — don't take up space.
  if (!loading && rows.length === 0) return null;

  return (
    <div className="border border-separator rounded-xl bg-surface-raised overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-surface-hover transition-colors"
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-text-primary">
          <Send className="w-3.5 h-3.5 text-accent" />
          Submitted to clients
          <span className="text-text-tertiary font-normal">({rows.length})</span>
        </span>
        {open ? <ChevronUp className="w-4 h-4 text-text-tertiary" /> : <ChevronDown className="w-4 h-4 text-text-tertiary" />}
      </button>

      {open && (
        <div className="divide-y divide-separator border-t border-separator">
          {rows.map((s) => (
            <div key={s.id} className="flex items-center gap-3 px-4 py-2.5">
              <div className="flex-1 min-w-0">
                <div className="text-sm text-text-primary truncate">{s.candidate?.name ?? "Candidate"}</div>
                <div className="flex items-center gap-2 mt-0.5 text-xs text-text-tertiary">
                  {s.client && (
                    <span className="flex items-center gap-1"><Building2 className="w-3 h-3" />{s.client.name}</span>
                  )}
                  <span>{new Date(s.submittedAt).toLocaleDateString("en-NZ", { day: "numeric", month: "short" })}</span>
                </div>
              </div>
              <span className={`text-2xs px-2 py-0.5 rounded-full shrink-0 ${STATUS_TOKENS[s.status] ?? "bg-surface-hover text-text-secondary"}`}>
                {s.status.replace("_", " ")}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
