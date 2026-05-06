"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, History, CheckCircle2, AlertCircle, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

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
    if (evaluation.startsWith("FAIL"))    return <XCircle className="w-3 h-3 text-red-500 flex-shrink-0" />;
    if (evaluation.startsWith("WARNING")) return <AlertCircle className="w-3 h-3 text-amber-500 flex-shrink-0" />;
    return <CheckCircle2 className="w-3 h-3 text-emerald-500 flex-shrink-0" />;
  }

  function evalChipClass(evaluation: string) {
    if (evaluation.startsWith("FAIL"))    return "bg-red-50 text-red-600 border-red-200";
    if (evaluation.startsWith("WARNING")) return "bg-amber-50 text-amber-700 border-amber-200";
    return "bg-emerald-50 text-emerald-700 border-emerald-200";
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-slate-50 transition-colors"
      >
        <span className="flex items-center gap-2 text-sm font-medium text-slate-700">
          <History className="w-4 h-4 text-slate-400" />
          Analysis History
        </span>
        {open ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
      </button>

      {open && (
        <div className="border-t border-slate-100 px-4 py-3 space-y-3">
          {loadState === "loading" && (
            <p className="text-xs text-slate-400">Loading…</p>
          )}
          {loadState === "error" && (
            <p className="text-xs text-amber-700 flex items-center gap-1">
              <AlertCircle className="w-3 h-3" />
              Couldn&apos;t load analysis history — refresh to try again.
            </p>
          )}
          {loadState === "loaded" && history.length === 0 && (
            <p className="text-xs text-slate-400">No analysis history yet — run Re-analyse to start tracking.</p>
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
                    <p className="text-[11px] text-slate-500 leading-snug" suppressHydrationWarning>
                      {date} · {entry.mustHaveCount} must-have{entry.mustHaveCount !== 1 ? "s" : ""}
                      {anchors.length > 0 ? ` · anchors: ${anchors.join(", ")}` : " · no anchors"}
                    </p>
                    <p className={cn(
                      "text-[10px] mt-1 px-2 py-0.5 rounded-full border inline-block font-medium",
                      evalChipClass(entry.evaluation)
                    )}>
                      {entry.evaluation}
                    </p>
                    {showChanges.length > 0 && (
                      <ul className="mt-1.5 space-y-0.5">
                        {showChanges.map((c, i) => (
                          <li key={i} className="text-[10px] text-slate-400 before:content-['·'] before:mr-1">
                            {c}
                          </li>
                        ))}
                        {extra > 0 && (
                          <li className="text-[10px] text-slate-400">+{extra} more change{extra !== 1 ? "s" : ""}</li>
                        )}
                      </ul>
                    )}
                    {showChanges.length === 0 && (
                      <p className="text-[10px] text-slate-400 mt-1">No changes from previous analysis</p>
                    )}
                  </div>
                </div>
                <div className="border-b border-slate-100 last:border-0" />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
