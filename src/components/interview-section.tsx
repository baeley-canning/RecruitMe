"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, ClipboardList, Save } from "lucide-react";
import { Button } from "./ui/button";
import { cn, safeParseJson } from "@/lib/utils";

interface InterviewData {
  date?: string;
  interviewer?: string;
  format?: string;
  impression?: string;
  technical?: string;
  culture?: string;
  recommendation?: string;
  updatedAt?: string;
}

interface InterviewSectionProps {
  candidateId: string;
  jobId: string;
  interviewNotes: string | null;
  onSaved: (updated: string) => void;
}

const RECOMMENDATION_OPTIONS = [
  { value: "strong_yes", label: "Strong yes", color: "text-emerald-700" },
  { value: "yes",        label: "Yes",         color: "text-blue-700" },
  { value: "maybe",      label: "Maybe",       color: "text-amber-700" },
  { value: "no",         label: "No",          color: "text-red-600" },
];

const FORMAT_OPTIONS = ["Video call", "Phone", "In-person", "Technical assessment", "Panel"];

export function InterviewSection({ candidateId, jobId, interviewNotes, onSaved }: InterviewSectionProps) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [latestData, setLatestData] = useState(interviewNotes);

  const parsed = safeParseJson<InterviewData>(latestData, {});
  const [form, setForm] = useState<InterviewData>(() => {
    const p = safeParseJson<InterviewData>(interviewNotes, {});
    return {
      date:           p.date ?? "",
      interviewer:    p.interviewer ?? "",
      format:         p.format ?? "",
      impression:     p.impression ?? "",
      technical:      p.technical ?? "",
      culture:        p.culture ?? "",
      recommendation: p.recommendation ?? "",
    };
  });

  const hasData = !!(parsed.impression || parsed.technical || parsed.culture || parsed.recommendation);
  const recOption = RECOMMENDATION_OPTIONS.find((r) => r.value === parsed.recommendation);

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload: InterviewData = { ...form, updatedAt: new Date().toISOString() };
      const res = await fetch(`/api/jobs/${jobId}/candidates/${candidateId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ interviewNotes: JSON.stringify(payload) }),
      });
      if (res.ok) {
        const serialised = JSON.stringify(payload);
        setLatestData(serialised);
        onSaved(serialised);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } finally {
      setSaving(false);
    }
  };

  const field = (label: string, key: keyof Omit<InterviewData, "updatedAt">, multiline?: boolean) => (
    <div>
      <label className="block text-xs font-medium text-slate-600 mb-1">{label}</label>
      {multiline ? (
        <textarea
          value={form[key] ?? ""}
          onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
          rows={2}
          className="w-full text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 resize-none focus:outline-none focus:ring-2 focus:ring-blue-400"
          placeholder="—"
        />
      ) : (
        <input
          type="text"
          value={form[key] ?? ""}
          onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
          className="w-full text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-400"
          placeholder="—"
        />
      )}
    </div>
  );

  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2.5 bg-slate-50 hover:bg-slate-100 transition-colors"
      >
        <div className="flex items-center gap-2">
          <ClipboardList className="w-3.5 h-3.5 text-slate-400" />
          <span className="text-xs font-medium text-slate-700">Interview Notes</span>
          {hasData && !open && (
            <>
              {recOption && (
                <span className={cn("text-[10px] font-medium px-1.5 py-0.5 rounded-full border", {
                  "bg-emerald-50 border-emerald-200 text-emerald-700": recOption.value === "strong_yes",
                  "bg-blue-50 border-blue-200 text-blue-700":          recOption.value === "yes",
                  "bg-amber-50 border-amber-200 text-amber-700":        recOption.value === "maybe",
                  "bg-red-50 border-red-100 text-red-600":              recOption.value === "no",
                })}>
                  {recOption.label}
                </span>
              )}
              {!recOption && (
                <span className="text-[10px] text-blue-600 bg-blue-50 border border-blue-200 rounded-full px-1.5 py-0.5">
                  Notes saved
                </span>
              )}
            </>
          )}
        </div>
        {open ? <ChevronUp className="w-3.5 h-3.5 text-slate-400" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-400" />}
      </button>

      {open && (
        <div className="p-3 space-y-2.5">
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Date</label>
              <input
                type="date"
                value={form.date ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
                className="w-full text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-400"
              />
            </div>
            {field("Interviewer", "interviewer")}
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Format</label>
              <select
                value={form.format ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, format: e.target.value }))}
                className="w-full text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-400 bg-white"
              >
                <option value="">— Select —</option>
                {FORMAT_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Recommendation</label>
              <select
                value={form.recommendation ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, recommendation: e.target.value }))}
                className="w-full text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-400 bg-white"
              >
                <option value="">— Select —</option>
                {RECOMMENDATION_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </div>

          {field("Overall impression", "impression", true)}
          {field("Technical assessment", "technical", true)}
          {field("Culture / team fit", "culture", true)}

          {parsed.updatedAt && (
            <p className="text-[10px] text-slate-400">
              Last saved {new Date(parsed.updatedAt).toLocaleString()}
            </p>
          )}

          <Button
            size="sm"
            variant="ghost"
            onClick={handleSave}
            loading={saving}
            className={cn(saved ? "text-emerald-600" : "text-blue-600 hover:bg-blue-50")}
          >
            {!saving && <Save className="w-3.5 h-3.5" />}
            {saved ? "Saved!" : "Save interview notes"}
          </Button>
        </div>
      )}
    </div>
  );
}
