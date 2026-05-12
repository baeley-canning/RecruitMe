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
  { value: "strong_yes", label: "Strong yes", color: "text-success" },
  { value: "yes",        label: "Yes",         color: "text-accent" },
  { value: "maybe",      label: "Maybe",       color: "text-warning" },
  { value: "no",         label: "No",          color: "text-text-tertiary" },
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
      <label className="block text-xs font-medium text-text-secondary mb-1">{label}</label>
      {multiline ? (
        <textarea
          value={form[key] ?? ""}
          onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
          rows={2}
          className="w-full text-xs border border-separator rounded bg-surface-sunken text-text-primary placeholder:text-text-tertiary px-2.5 py-1.5 resize-none focus:outline-none focus:border-accent focus:shadow-focus transition-all"
          placeholder="—"
        />
      ) : (
        <input
          type="text"
          value={form[key] ?? ""}
          onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
          className="w-full text-xs border border-separator rounded bg-surface-sunken text-text-primary placeholder:text-text-tertiary px-2.5 py-1.5 focus:outline-none focus:border-accent focus:shadow-focus transition-all"
          placeholder="—"
        />
      )}
    </div>
  );

  return (
    <div className="border border-separator rounded-md overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 bg-surface-sunken hover:bg-surface-hover transition-colors"
      >
        <div className="flex items-center gap-2">
          <ClipboardList className="w-3.5 h-3.5 text-text-tertiary" />
          <span className="text-xs font-medium text-text-primary">Interview Notes</span>
          {hasData && !open && (
            <>
              {recOption && (
                <span className={cn("text-2xs font-medium px-1.5 py-0.5 rounded-sm border border-separator", {
                  "bg-success-subtle text-success": recOption.value === "strong_yes",
                  "bg-accent-subtle text-accent":          recOption.value === "yes",
                  "bg-warning-subtle text-warning":        recOption.value === "maybe",
                  "bg-surface-hover text-text-tertiary":   recOption.value === "no",
                })}>
                  {recOption.label}
                </span>
              )}
              {!recOption && (
                <span className="text-2xs text-accent bg-accent-subtle border border-separator rounded-sm px-1.5 py-0.5">
                  Notes saved
                </span>
              )}
            </>
          )}
        </div>
        {open ? <ChevronUp className="w-3.5 h-3.5 text-text-tertiary" /> : <ChevronDown className="w-3.5 h-3.5 text-text-tertiary" />}
      </button>

      {open && (
        <div className="p-3 space-y-2.5">
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">Date</label>
              <input
                type="date"
                value={form.date ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
                className="w-full text-xs border border-separator rounded bg-surface-sunken text-text-primary px-2.5 py-1.5 focus:outline-none focus:border-accent focus:shadow-focus transition-all"
              />
            </div>
            {field("Interviewer", "interviewer")}
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">Format</label>
              <select
                value={form.format ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, format: e.target.value }))}
                className="w-full text-xs border border-separator rounded px-2.5 py-1.5 focus:outline-none focus:border-accent focus:shadow-focus bg-surface-sunken text-text-primary transition-all"
              >
                <option value="">— Select —</option>
                {FORMAT_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">Recommendation</label>
              <select
                value={form.recommendation ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, recommendation: e.target.value }))}
                className="w-full text-xs border border-separator rounded px-2.5 py-1.5 focus:outline-none focus:border-accent focus:shadow-focus bg-surface-sunken text-text-primary transition-all"
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
            <p className="text-2xs text-text-tertiary" suppressHydrationWarning>
              Last saved {new Date(parsed.updatedAt).toLocaleString()}
            </p>
          )}

          <Button
            size="sm"
            variant="ghost"
            onClick={handleSave}
            loading={saving}
            className={cn(saved ? "text-success" : "text-accent hover:bg-surface-hover")}
          >
            {!saving && <Save className="w-3.5 h-3.5" />}
            {saved ? "Saved!" : "Save interview notes"}
          </Button>
        </div>
      )}
    </div>
  );
}
