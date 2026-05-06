"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, CheckCircle2, AlertCircle, XCircle, Activity } from "lucide-react";
import { cn, safeParseJson } from "@/lib/utils";

interface SectionMeta {
  key: string;
  fetched: boolean;
  status: number;
  finalUrl?: string;
  fetchOutcome: string;
  deepChars: number;
  mergeMode: string;
  charsAdded: number;
}

interface CaptureMeta {
  capturedAt?: string;
  mainProfileChars?: number;
  finalProfileChars?: number;
  sections?: SectionMeta[];
}

const SECTION_LABELS: Record<string, string> = {
  experience:               "Experience",
  skills:                   "Skills",
  licenses_certifications:  "Licenses & certs",
  education:                "Education",
};

// Plain-English explanation of each fetchOutcome / mergeMode pair so a recruiter
// can read it without knowing the codebase. Returns { tone, explanation }.
function describeSection(s: SectionMeta): { tone: "ok" | "warn" | "err"; explanation: string } {
  if (!s.fetched) {
    return { tone: "warn", explanation: "Deep page not fetched (skipped)." };
  }
  if (s.fetchOutcome === "ok") {
    if (s.mergeMode === "replace")             return { tone: "ok",   explanation: `Deep page replaced thin section (+${s.charsAdded} chars).` };
    if (s.mergeMode === "append")              return { tone: "ok",   explanation: `Deep page appended (+${s.charsAdded} chars).` };
    if (s.mergeMode === "skip-already-present") return { tone: "ok",   explanation: `Main profile already had a substantial section — deep page skipped to avoid duplication.` };
    if (s.mergeMode === "skip-too-small")      return { tone: "warn", explanation: `Deep page returned too little usable text to merge.` };
    return { tone: "warn", explanation: `Merged with mode "${s.mergeMode}".` };
  }
  if (s.fetchOutcome === "redirected_away")  return { tone: "err",  explanation: "Deep page request was redirected (likely a login wall or LinkedIn rate limit)." };
  if (s.fetchOutcome === "too_thin")          return { tone: "warn", explanation: "Deep page loaded but contained too few useful lines." };
  if (s.fetchOutcome === "network_error")     return { tone: "err",  explanation: "Network error while fetching the deep page." };
  if (s.fetchOutcome.startsWith("http_"))     return { tone: "err",  explanation: `Deep page returned ${s.fetchOutcome.replace("http_", "HTTP ")}.` };
  return { tone: "warn", explanation: `Outcome: ${s.fetchOutcome}.` };
}

export function CaptureMetadataPanel({ raw }: { raw: string | null | undefined }) {
  const [open, setOpen] = useState(false);
  if (!raw) return null;
  const meta = safeParseJson<CaptureMeta | null>(raw, null);
  if (!meta?.sections || meta.sections.length === 0) return null;

  const successful = meta.sections.filter((s) => s.fetchOutcome === "ok").length;
  const total = meta.sections.length;
  const allFailed = successful === 0;

  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-slate-50"
      >
        <span className="flex items-center gap-2 text-xs font-medium text-slate-700">
          <Activity className={cn("w-3.5 h-3.5", allFailed ? "text-red-500" : successful === total ? "text-emerald-500" : "text-amber-500")} />
          Capture proof
          <span className="text-[10px] text-slate-400 font-normal">
            {successful}/{total} deep pages used
            {meta.finalProfileChars && meta.mainProfileChars
              ? ` · ${meta.mainProfileChars}→${meta.finalProfileChars} chars`
              : ""}
          </span>
        </span>
        {open ? <ChevronUp className="w-3.5 h-3.5 text-slate-400" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-400" />}
      </button>
      {open && (
        <div className="border-t border-slate-100 px-3 py-2 space-y-2">
          {meta.sections.map((s) => {
            const label = SECTION_LABELS[s.key] ?? s.key;
            const { tone, explanation } = describeSection(s);
            const Icon = tone === "ok" ? CheckCircle2 : tone === "warn" ? AlertCircle : XCircle;
            const colour = tone === "ok" ? "text-emerald-500" : tone === "warn" ? "text-amber-500" : "text-red-500";
            return (
              <div key={s.key} className="flex items-start gap-2">
                <Icon className={cn("w-3.5 h-3.5 mt-0.5 flex-shrink-0", colour)} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-medium text-slate-700">{label}</span>
                    {s.status > 0 && (
                      <span className="text-[10px] font-mono text-slate-400">HTTP {s.status}</span>
                    )}
                    {s.charsAdded > 0 && (
                      <span className="text-[10px] text-slate-500">+{s.charsAdded.toLocaleString()} chars</span>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-500 leading-snug">{explanation}</p>
                </div>
              </div>
            );
          })}
          {meta.capturedAt && (
            <p className="text-[10px] text-slate-400 pt-1 border-t border-slate-100" suppressHydrationWarning>
              Captured {new Date(meta.capturedAt).toLocaleString()}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
