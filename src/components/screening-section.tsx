"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, Phone, Save } from "lucide-react";
import { Button } from "./ui/button";
import { cn, safeParseJson } from "@/lib/utils";

interface ScreeningData {
  availability?: string;
  salaryExpectation?: string;
  visaStatus?: string;
  noticePeriod?: string;
  motivations?: string;
  notes?: string;
  screenedAt?: string;
}

interface ScreeningSectionProps {
  candidateId: string;
  jobId: string;
  screeningData: string | null;
  onSaved: (updated: string) => void;
}

export function ScreeningSection({ candidateId, jobId, screeningData, onSaved }: ScreeningSectionProps) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // Track locally so "Notes saved" badge updates after a save without needing parent re-render
  const [latestData, setLatestData] = useState(screeningData);

  const parsed = safeParseJson<ScreeningData>(latestData, {});
  const [form, setForm] = useState<ScreeningData>(() => {
    const p = safeParseJson<ScreeningData>(screeningData, {});
    return {
      availability:      p.availability ?? "",
      salaryExpectation: p.salaryExpectation ?? "",
      visaStatus:        p.visaStatus ?? "",
      noticePeriod:      p.noticePeriod ?? "",
      motivations:       p.motivations ?? "",
      notes:             p.notes ?? "",
    };
  });

  const hasData = !!(parsed.availability || parsed.salaryExpectation || parsed.visaStatus ||
    parsed.noticePeriod || parsed.motivations || parsed.notes);

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload: ScreeningData = { ...form, screenedAt: new Date().toISOString() };
      const res = await fetch(`/api/jobs/${jobId}/candidates/${candidateId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ screeningData: JSON.stringify(payload) }),
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

  const field = (label: string, key: keyof Omit<ScreeningData, "screenedAt">, multiline?: boolean) => (
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
          <Phone className="w-3.5 h-3.5 text-slate-400" />
          <span className="text-xs font-medium text-slate-700">Phone Screening</span>
          {hasData && !open && (
            <span className="text-[10px] text-emerald-600 bg-emerald-50 border border-emerald-200 rounded-full px-1.5 py-0.5">
              Notes saved
            </span>
          )}
        </div>
        {open ? <ChevronUp className="w-3.5 h-3.5 text-slate-400" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-400" />}
      </button>

      {open && (
        <div className="p-3 space-y-2.5">
          <div className="grid grid-cols-2 gap-2.5">
            {field("Availability", "availability")}
            {field("Notice period", "noticePeriod")}
            {field("Salary expectation", "salaryExpectation")}
            {field("Visa / right-to-work", "visaStatus")}
          </div>
          {field("Motivations", "motivations", true)}
          {field("Additional notes", "notes", true)}

          {parsed.screenedAt && (
            <p className="text-[10px] text-slate-400">
              Last saved {new Date(parsed.screenedAt).toLocaleString()}
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
            {saved ? "Saved!" : "Save screening notes"}
          </Button>
        </div>
      )}
    </div>
  );
}
