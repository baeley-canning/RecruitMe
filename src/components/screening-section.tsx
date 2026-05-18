"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, Phone, Save } from "lucide-react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
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
      <label className="block text-xs font-medium text-text-secondary mb-1">{label}</label>
      {multiline ? (
        <textarea
          value={form[key] ?? ""}
          onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
          rows={2}
          className="w-full text-base text-text-primary bg-surface-sunken border border-separator rounded px-2.5 py-1.5 placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:shadow-focus resize-none transition-all"
          placeholder="—"
        />
      ) : (
        <input
          type="text"
          value={form[key] ?? ""}
          onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
          className="w-full h-7 text-base text-text-primary bg-surface-sunken border border-separator rounded px-2.5 placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:shadow-focus transition-all"
          placeholder="—"
        />
      )}
    </div>
  );

  return (
    <div className="rounded-md border border-separator bg-surface-raised overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-surface-hover transition-colors"
      >
        <div className="flex items-center gap-2">
          <Phone className="w-3.5 h-3.5 text-text-tertiary" />
          <span className="text-md font-medium text-text-primary">Phone screening</span>
          {hasData && !open && (
            <Badge className="bg-success-subtle text-success">Notes saved</Badge>
          )}
        </div>
        {open
          ? <ChevronUp className="w-3.5 h-3.5 text-text-tertiary" />
          : <ChevronDown className="w-3.5 h-3.5 text-text-tertiary" />}
      </button>

      {open && (
        <div className="p-3 space-y-2.5 border-t border-separator">
          <div className="grid grid-cols-2 gap-2.5">
            {field("Availability", "availability")}
            {field("Notice period", "noticePeriod")}
            {field("Salary expectation", "salaryExpectation")}
            {field("Visa / right-to-work", "visaStatus")}
          </div>
          {field("Motivations", "motivations", true)}
          {field("Additional notes", "notes", true)}

          {parsed.screenedAt && (
            <p className="text-xs text-text-tertiary data-mono" suppressHydrationWarning>
              Last saved {new Date(parsed.screenedAt).toLocaleString()}
            </p>
          )}

          <Button
            size="sm"
            variant="ghost"
            onClick={handleSave}
            loading={saving}
            className={cn(saved && "text-success")}
          >
            {!saving && <Save className="w-3.5 h-3.5" />}
            {saved ? "Saved!" : "Save screening notes"}
          </Button>
        </div>
      )}
    </div>
  );
}
