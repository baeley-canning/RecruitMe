"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, History, CheckCircle2, AlertCircle, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { ErrorPill, LoadingPill } from "@/components/ui/state-pill";

type LoadState = "idle" | "loading" | "loaded" | "error";

interface ParseHistoryEntry {
  id: string;
  parsedAt: string;
  anchorTerms: string;   // JSON
  mustHaveCount: number;
  changes: string;       // JSON
  evaluation: string;
}

export function ParseHistoryCard({ jobId }: { jobId: string }) {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<ParseHistoryEntry[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("idle");

  useEffect(() => {
    if (!open || loadState !== "idle") return;
    setLoadState("loading");
    fetch(`/api/jobs/${jobId}/parse-history`)
      .then(async (r) => {
        if (!r.ok) { setLoadState("error"); return; }
        const data = await r.json().catch(() => null);
        setHistory(Array.isArray(data) ? data : []);
        setLoadState("loaded");
      })
      .catch(() => setLoadState("error"));
  }, [open, loadState, jobId]);

  function evalIcon(evaluation: string) {
    if (evaluation.startsWith("FAIL"))    return <XCircle className="w-3 h-3 text-danger flex-shrink-0" />;
    if (evaluation.startsWith("WARNING")) return <AlertCircle className="w-3 h-3 text-warning flex-shrink-0" />;
    return <CheckCircle2 className="w-3 h-3 text-success flex-shrink-0" />;
  }

  function evalChipClass(evaluation: string) {
    if (evaluation.startsWith("FAIL"))    return "bg-danger-subtle text-danger";
    if (evaluation.startsWith("WARNING")) return "bg-warning-subtle text-warning";
    return "bg-success-subtle text-success";
  }

  return (
    <div className="rounded-md border border-separator bg-surface-raised overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-surface-hover transition-colors"
      >
        <span className="flex items-center gap-2 text-md font-semibold text-text-primary">
          <History className="w-3.5 h-3.5 text-text-tertiary" />
          Analysis History
        </span>
        {open ? <ChevronUp className="w-3.5 h-3.5 text-text-tertiary" /> : <ChevronDown className="w-3.5 h-3.5 text-text-tertiary" />}
      </button>

      {open && (
        <div className="border-t border-separator px-4 py-3 space-y-3">
          {loadState === "loading" && <LoadingPill>Loading…</LoadingPill>}
          {loadState === "error" && (
            <ErrorPill>Couldn&apos;t load analysis history — refresh to try again.</ErrorPill>
          )}
          {loadState === "loaded" && history.length === 0 && (
            <p className="text-xs text-text-tertiary">No analysis history yet — run Re-analyse to start tracking.</p>
          )}
          {loadState === "loaded" && history.map((entry) => {
            const parseJsonSafe = <T,>(s: string, fallback: T): T => { try { return JSON.parse(s) as T; } catch { return fallback; } };
            const anchors  = parseJsonSafe<string[]>(entry.anchorTerms, []);
            const changes  = parseJsonSafe<string[]>(entry.changes, []);
            const showChanges = changes.slice(0, 4);
            const extra = changes.length - showChanges.length;
            const date = new Date(entry.parsedAt).toLocaleString(undefined, {
              month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
            });

            return (
              <div key={entry.id} className="space-y-1.5">
                <div className="flex items-start gap-2">
                  {evalIcon(entry.evaluation)}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-text-secondary leading-snug tabular-nums" suppressHydrationWarning>
                      {date} · <span className="data-mono">{entry.mustHaveCount}</span> must-have{entry.mustHaveCount !== 1 ? "s" : ""}
                      {anchors.length > 0 ? ` · anchors: ${anchors.join(", ")}` : " · no anchors"}
                    </p>
                    <p className={cn(
                      "text-2xs mt-1 px-1.5 py-0.5 rounded-sm inline-block font-medium",
                      evalChipClass(entry.evaluation)
                    )}>
                      {entry.evaluation}
                    </p>
                    {showChanges.length > 0 && (
                      <ul className="mt-1.5 space-y-0.5">
                        {showChanges.map((c, i) => (
                          <li key={i} className="text-2xs text-text-tertiary before:content-['·'] before:mr-1">
                            {c}
                          </li>
                        ))}
                        {extra > 0 && (
                          <li className="text-2xs text-text-tertiary">+<span className="data-mono">{extra}</span> more change{extra !== 1 ? "s" : ""}</li>
                        )}
                      </ul>
                    )}
                    {showChanges.length === 0 && (
                      <p className="text-2xs text-text-tertiary mt-1">No changes from previous analysis</p>
                    )}
                  </div>
                </div>
                <div className="border-b border-separator last:border-0" />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
