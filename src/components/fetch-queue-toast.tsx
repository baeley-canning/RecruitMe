"use client";

import { X, Loader2, CheckCircle2, AlertCircle } from "lucide-react";

interface FetchStatus {
  state: "waiting" | "fetching" | "done" | "error";
  message: string;
}

interface FetchQueueToastProps {
  statuses: Record<string, FetchStatus>;
  candidateNames: Record<string, string>;
  onDismiss: () => void;
}

export function FetchQueueToast({ statuses, candidateNames, onDismiss }: FetchQueueToastProps) {
  if (Object.keys(statuses).length === 0) return null;

  return (
    <div className="fixed bottom-6 right-6 z-[1100] w-80 bg-white border border-slate-200 rounded-xl shadow-2xl p-4">
      <div className="flex items-start justify-between gap-2 mb-1">
        <p className="text-xs font-semibold text-slate-700 uppercase tracking-wide">Fetching profiles</p>
        <button onClick={onDismiss} className="flex-shrink-0 text-slate-400 hover:text-slate-600">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="space-y-2">
        {Object.entries(statuses).map(([candidateId, status]) => (
          <div key={candidateId} className="flex items-start gap-2">
            <div className="flex-shrink-0 mt-0.5">
              {(status.state === "waiting" || status.state === "fetching") && (
                <Loader2 className={`w-4 h-4 animate-spin ${status.state === "fetching" ? "text-blue-500" : "text-amber-500"}`} />
              )}
              {status.state === "done" && <CheckCircle2 className="w-4 h-4 text-emerald-500" />}
              {status.state === "error" && <AlertCircle className="w-4 h-4 text-red-500" />}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-slate-900 truncate">
                {candidateNames[candidateId] ?? candidateId}
              </p>
              <p className="text-xs text-slate-500 leading-snug">{status.message}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
