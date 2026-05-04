"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, FileText, Loader2, Download, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";

interface Candidate {
  id: string;
  name: string;
  headline: string | null;
  location: string | null;
  source: string;
  job: { id: string; title: string; company: string | null } | null;
  archivedJobTitle: string | null;
}

interface ConsultantFields {
  name: string;
  email: string;
  phone: string;
}

const STORAGE_KEY = "recruitme:profile-consultant";

function loadSaved(): { consultant: ConsultantFields; manager: ConsultantFields } {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
  } catch { return { consultant: { name: "", email: "", phone: "" }, manager: { name: "", email: "", phone: "" } }; }
}

function Field({ label, value, onChange, placeholder, type = "text" }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-600 mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
      />
    </div>
  );
}

function ConsultantSection({ title, value, onChange }: {
  title: string;
  value: ConsultantFields;
  onChange: (v: ConsultantFields) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-3 bg-slate-50 text-sm font-semibold text-slate-800 hover:bg-slate-100 transition-colors"
      >
        {title}
        {open ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
      </button>
      {open && (
        <div className="px-4 py-4 space-y-3">
          <Field label="Name" value={value.name} onChange={(v) => onChange({ ...value, name: v })} placeholder="Jane Smith" />
          <Field label="Email" value={value.email} onChange={(v) => onChange({ ...value, email: v })} placeholder="jane@placeme.co.nz" type="email" />
          <Field label="Phone" value={value.phone} onChange={(v) => onChange({ ...value, phone: v })} placeholder="021 123 456" />
        </div>
      )}
    </div>
  );
}

export default function CandidateProfilesPage() {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Candidate | null>(null);
  const [role, setRole] = useState("");
  const [dateAvailable, setDateAvailable] = useState("");
  const [consultant, setConsultant] = useState<ConsultantFields>({ name: "", email: "", phone: "" });
  const [manager, setManager] = useState<ConsultantFields>({ name: "", email: "", phone: "" });
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const initRef = useRef(false);

  useEffect(() => {
    if (!initRef.current) {
      initRef.current = true;
      const saved = loadSaved();
      if (saved.consultant) setConsultant(saved.consultant);
      if (saved.manager) setManager(saved.manager);
    }

    fetch("/api/candidates")
      .then((r) => r.json())
      .then((data: Candidate[]) => setCandidates(Array.isArray(data) ? data : []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ consultant, manager }));
    } catch {}
  }, [consultant, manager]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return candidates;
    return candidates.filter((c) =>
      c.name.toLowerCase().includes(q) ||
      c.headline?.toLowerCase().includes(q) ||
      c.job?.title.toLowerCase().includes(q)
    );
  }, [candidates, search]);

  const handleSelect = (c: Candidate) => {
    setSelected(c);
    setRole(c.job?.title ?? c.archivedJobTitle ?? "");
    setError("");
    setSearch("");
  };

  const handleGenerate = async () => {
    if (!selected) return;
    setGenerating(true);
    setError("");
    try {
      const res = await fetch("/api/candidate-profiles/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          candidateId: selected.id,
          role,
          dateAvailable,
          consultant,
          manager,
        }),
      });

      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setError((json as { error?: string }).error ?? "Failed to generate profile");
        return;
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${selected.name.replace(/[^a-zA-Z0-9]/g, "_")}_Candidate_Profile.docx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError("Something went wrong — please try again");
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-3xl mx-auto px-6 py-10">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-1">
            <div className="w-9 h-9 bg-teal-50 rounded-xl flex items-center justify-center">
              <FileText className="w-5 h-5 text-teal-600" />
            </div>
            <h1 className="text-2xl font-bold text-slate-900">Candidate Profiles</h1>
          </div>
          <p className="text-slate-500 text-sm ml-12">Generate a formatted PlaceMe candidate profile document.</p>
        </div>

        <div className="space-y-5">
          {/* Step 1 — Select candidate */}
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100">
              <h2 className="text-sm font-semibold text-slate-800">1. Select Candidate</h2>
            </div>
            <div className="px-5 py-4">
              {selected ? (
                <div className="flex items-center justify-between p-3 bg-teal-50 border border-teal-200 rounded-xl">
                  <div>
                    <p className="text-sm font-semibold text-teal-900">{selected.name}</p>
                    {selected.headline && <p className="text-xs text-teal-700 mt-0.5 line-clamp-1">{selected.headline}</p>}
                  </div>
                  <button
                    onClick={() => { setSelected(null); setRole(""); }}
                    className="text-xs text-teal-600 hover:text-teal-800 font-medium underline"
                  >
                    Change
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <input
                      type="text"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search candidates…"
                      className="w-full pl-9 pr-4 py-2.5 border border-slate-200 rounded-xl text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:border-blue-400"
                    />
                  </div>
                  {loading ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="w-5 h-5 animate-spin text-slate-300" />
                    </div>
                  ) : filtered.length === 0 ? (
                    <p className="text-sm text-slate-400 text-center py-6">No candidates found</p>
                  ) : (
                    <div className="max-h-64 overflow-y-auto space-y-1 rounded-xl border border-slate-100">
                      {filtered.slice(0, 50).map((c) => (
                        <button
                          key={c.id}
                          onClick={() => handleSelect(c)}
                          className="w-full text-left px-4 py-3 hover:bg-slate-50 transition-colors border-b border-slate-50 last:border-0"
                        >
                          <p className="text-sm font-medium text-slate-800">{c.name}</p>
                          {c.headline && <p className="text-xs text-slate-400 line-clamp-1 mt-0.5">{c.headline}</p>}
                          {(c.job?.title || c.archivedJobTitle) && (
                            <p className="text-xs text-blue-500 mt-0.5">{c.job?.title ?? c.archivedJobTitle}</p>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Step 2 — Role details */}
          <div className={cn("bg-white rounded-2xl border border-slate-200 overflow-hidden transition-opacity", !selected && "opacity-40 pointer-events-none")}>
            <div className="px-5 py-4 border-b border-slate-100">
              <h2 className="text-sm font-semibold text-slate-800">2. Role &amp; Availability</h2>
            </div>
            <div className="px-5 py-4 grid grid-cols-2 gap-4">
              <Field label="Role being referred for" value={role} onChange={setRole} placeholder="e.g. Senior Developer" />
              <Field label="Date Available" value={dateAvailable} onChange={setDateAvailable} placeholder="e.g. Immediately, 2 weeks" />
            </div>
          </div>

          {/* Step 3 — Consultant info */}
          <div className={cn("space-y-3 transition-opacity", !selected && "opacity-40 pointer-events-none")}>
            <h2 className="text-sm font-semibold text-slate-700 px-1">3. Consultant Details <span className="font-normal text-slate-400">(saved automatically)</span></h2>
            <ConsultantSection title="Your Consultant" value={consultant} onChange={setConsultant} />
            <ConsultantSection title="Your Candidate Manager" value={manager} onChange={setManager} />
          </div>

          {/* Error */}
          {error && <p className="text-sm text-red-600 px-1">{error}</p>}

          {/* Generate */}
          <button
            onClick={handleGenerate}
            disabled={!selected || generating}
            className={cn(
              "w-full flex items-center justify-center gap-2.5 py-3.5 rounded-xl text-sm font-semibold transition-colors",
              selected && !generating
                ? "bg-teal-600 hover:bg-teal-700 text-white"
                : "bg-slate-100 text-slate-400 cursor-not-allowed"
            )}
          >
            {generating ? (
              <><Loader2 className="w-4 h-4 animate-spin" />Generating profile…</>
            ) : (
              <><Download className="w-4 h-4" />Generate &amp; Download Profile</>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
