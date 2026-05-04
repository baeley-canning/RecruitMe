"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Search, FileText, Loader2, Download, ChevronDown, ChevronUp, Upload, X, BookOpen, FolderOpen, ArrowLeft } from "lucide-react";
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

type Mode = "library" | "documents";

const STORAGE_KEY = "recruitme:profile-consultant";

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function loadSaved(): { consultant: ConsultantFields; manager: ConsultantFields } {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    const c = parsed.consultant ?? {};
    const m = parsed.manager ?? {};
    return {
      consultant: { name: str(c.name), email: str(c.email), phone: str(c.phone) },
      manager:    { name: str(m.name), email: str(m.email), phone: str(m.phone) },
    };
  } catch {
    return {
      consultant: { name: "", email: "", phone: "" },
      manager:    { name: "", email: "", phone: "" },
    };
  }
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

function FileDropZone({ files, onChange }: {
  files: File[];
  onChange: (files: File[]) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const accept = ".pdf,.doc,.docx,.txt";
  const ACCEPTED = ["application/pdf", "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "text/plain"];

  const addFiles = useCallback((incoming: FileList | File[]) => {
    const valid = Array.from(incoming).filter(
      (f) => ACCEPTED.includes(f.type) || accept.split(",").some((ext) => f.name.toLowerCase().endsWith(ext))
    );
    if (valid.length === 0) return;
    onChange([...files, ...valid]);
  }, [files, onChange]); // eslint-disable-line react-hooks/exhaustive-deps

  const remove = (i: number) => onChange(files.filter((_, idx) => idx !== i));

  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}
        onClick={() => inputRef.current?.click()}
        className={cn(
          "border-2 border-dashed rounded-xl px-6 py-8 text-center cursor-pointer transition-colors",
          dragging ? "border-teal-400 bg-teal-50" : "border-slate-200 hover:border-slate-300 hover:bg-slate-50"
        )}
      >
        <Upload className="w-6 h-6 text-slate-400 mx-auto mb-2" />
        <p className="text-sm font-medium text-slate-700">Drop files here or click to browse</p>
        <p className="text-xs text-slate-400 mt-1">PDF, Word (.docx), or plain text — CV, interview notes, anything</p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={accept}
          className="hidden"
          onChange={(e) => e.target.files && addFiles(e.target.files)}
        />
      </div>

      {files.length > 0 && (
        <ul className="space-y-2">
          {files.map((f, i) => (
            <li key={i} className="flex items-center gap-3 px-3 py-2 bg-slate-50 rounded-lg border border-slate-200">
              <FileText className="w-4 h-4 text-teal-600 flex-shrink-0" />
              <span className="text-sm text-slate-700 flex-1 truncate">{f.name}</span>
              <span className="text-xs text-slate-400 flex-shrink-0">{(f.size / 1024).toFixed(0)} KB</span>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); remove(i); }}
                className="text-slate-400 hover:text-red-500 transition-colors flex-shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function JdDropZone({ file, onChange }: { file: File | null; onChange: (f: File | null) => void }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const accept = ".pdf,.doc,.docx";
  const ACCEPTED = ["application/pdf", "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"];

  const pick = useCallback((incoming: FileList | File[]) => {
    const f = Array.from(incoming).find(
      (f) => ACCEPTED.includes(f.type) || accept.split(",").some((ext) => f.name.toLowerCase().endsWith(ext))
    );
    if (f) onChange(f);
  }, [onChange]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-2">
      <label className="block text-xs font-medium text-slate-600">Job Description <span className="font-normal text-slate-400">(optional — focuses the summary on the role)</span></label>
      {file ? (
        <div className="flex items-center gap-3 px-3 py-2 bg-slate-50 rounded-lg border border-slate-200">
          <FileText className="w-4 h-4 text-teal-600 flex-shrink-0" />
          <span className="text-sm text-slate-700 flex-1 truncate">{file.name}</span>
          <span className="text-xs text-slate-400 flex-shrink-0">{(file.size / 1024).toFixed(0)} KB</span>
          <button type="button" onClick={() => onChange(null)} className="text-slate-400 hover:text-red-500 transition-colors flex-shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); pick(e.dataTransfer.files); }}
          onClick={() => inputRef.current?.click()}
          className={cn(
            "border-2 border-dashed rounded-xl px-6 py-5 text-center cursor-pointer transition-colors",
            dragging ? "border-teal-400 bg-teal-50" : "border-slate-200 hover:border-slate-300 hover:bg-slate-50"
          )}
        >
          <Upload className="w-5 h-5 text-slate-400 mx-auto mb-1.5" />
          <p className="text-sm font-medium text-slate-700">Drop JD here or click to browse</p>
          <p className="text-xs text-slate-400 mt-0.5">PDF or Word (.docx)</p>
          <input ref={inputRef} type="file" accept={accept} className="hidden" onChange={(e) => e.target.files && pick(e.target.files)} />
        </div>
      )}
    </div>
  );
}

export default function CandidateProfilesPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("library");

  // Library mode state
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loadingCandidates, setLoadingCandidates] = useState(true);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Candidate | null>(null);

  // Documents mode state
  const [docName, setDocName]   = useState("");
  const [docFiles, setDocFiles] = useState<File[]>([]);
  const [jdFile, setJdFile]     = useState<File | null>(null);

  // Shared fields
  const [role, setRole]               = useState("");
  const [dateAvailable, setDateAvailable] = useState("");
  const [consultant, setConsultant]   = useState<ConsultantFields>({ name: "", email: "", phone: "" });
  const [manager, setManager]         = useState<ConsultantFields>({ name: "", email: "", phone: "" });
  const [generating, setGenerating]   = useState(false);
  const [error, setError]             = useState("");
  const initRef = useRef(false);

  useEffect(() => {
    if (!initRef.current) {
      initRef.current = true;
      const saved = loadSaved();
      setConsultant(saved.consultant);
      setManager(saved.manager);
    }
    fetch("/api/candidates")
      .then((r) => r.json())
      .then((data: Candidate[]) => setCandidates(Array.isArray(data) ? data : []))
      .catch(() => {})
      .finally(() => setLoadingCandidates(false));
  }, []);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ consultant, manager })); } catch {}
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

  const switchMode = (m: Mode) => {
    setMode(m);
    setError("");
    setSelected(null);
    setDocName("");
    setDocFiles([]);
    setJdFile(null);
    setRole("");
  };

  const canGenerate = mode === "library"
    ? !!selected
    : !!docName.trim() && docFiles.length > 0;

  const handleGenerate = async () => {
    if (!canGenerate) return;
    setGenerating(true);
    setError("");

    try {
      let res: Response;

      if (mode === "library" && selected) {
        res = await fetch("/api/candidate-profiles/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ candidateId: selected.id, role, dateAvailable, consultant, manager }),
        });
      } else {
        const form = new FormData();
        form.append("candidateName",  docName.trim());
        form.append("role",           role);
        form.append("dateAvailable",  dateAvailable);
        form.append("consultantName",  consultant.name);
        form.append("consultantEmail", consultant.email);
        form.append("consultantPhone", consultant.phone);
        form.append("managerName",     manager.name);
        form.append("managerEmail",    manager.email);
        form.append("managerPhone",    manager.phone);
        docFiles.forEach((f) => form.append("files", f));
        if (jdFile) form.append("jdFile", jdFile);
        res = await fetch("/api/candidate-profiles/generate", { method: "POST", body: form });
      }

      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setError((json as { error?: string }).error ?? "Failed to generate profile");
        return;
      }

      const blob = await res.blob();
      const name  = mode === "library" ? selected!.name : docName.trim();
      const url   = URL.createObjectURL(blob);
      const a     = document.createElement("a");
      a.href      = url;
      a.download  = `${name.replace(/[^a-zA-Z0-9]/g, "_")}_Candidate_Profile.docx`;
      a.click();
      URL.revokeObjectURL(url);

      // Refresh if we might have affected library data
      if (mode === "library") router.refresh();
    } catch {
      setError("Something went wrong — please try again");
    } finally {
      setGenerating(false);
    }
  };

  const ready = canGenerate && !generating;

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-3xl mx-auto px-6 py-10">

        {/* Back */}
        <Link
          href="/jobs"
          className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 transition-colors mb-6"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to app
        </Link>

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

          {/* Mode toggle */}
          <div className="flex gap-2 p-1 bg-slate-100 rounded-xl w-fit">
            <button
              onClick={() => switchMode("library")}
              className={cn(
                "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors",
                mode === "library"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500 hover:text-slate-700"
              )}
            >
              <BookOpen className="w-4 h-4" />
              From Library
            </button>
            <button
              onClick={() => switchMode("documents")}
              className={cn(
                "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors",
                mode === "documents"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500 hover:text-slate-700"
              )}
            >
              <FolderOpen className="w-4 h-4" />
              From Documents
            </button>
          </div>

          {/* ── Library mode: search & select ── */}
          {mode === "library" && (
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
                    {loadingCandidates ? (
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
          )}

          {/* ── Documents mode: name + file upload ── */}
          {mode === "documents" && (
            <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-100">
                <h2 className="text-sm font-semibold text-slate-800">1. Candidate &amp; Documents</h2>
                <p className="text-xs text-slate-400 mt-0.5">Drop in a CV, interview notes, or both — Claude will read them and build the profile.</p>
              </div>
              <div className="px-5 py-5 space-y-4">
                <Field
                  label="Candidate Name"
                  value={docName}
                  onChange={setDocName}
                  placeholder="e.g. Suzzanne Dobson"
                />
                <FileDropZone files={docFiles} onChange={setDocFiles} />
                <JdDropZone file={jdFile} onChange={setJdFile} />
              </div>
            </div>
          )}

          {/* Step 2 — Role & availability */}
          <div className={cn(
            "bg-white rounded-2xl border border-slate-200 overflow-hidden transition-opacity",
            !canGenerate && "opacity-40 pointer-events-none"
          )}>
            <div className="px-5 py-4 border-b border-slate-100">
              <h2 className="text-sm font-semibold text-slate-800">2. Role &amp; Availability</h2>
            </div>
            <div className="px-5 py-4 grid grid-cols-2 gap-4">
              <Field label="Role being referred for" value={role} onChange={setRole} placeholder="e.g. Senior Business Analyst" />
              <Field label="Date Available" value={dateAvailable} onChange={setDateAvailable} placeholder="e.g. Immediately, 2 weeks" />
            </div>
          </div>

          {/* Step 3 — Consultant details */}
          <div className={cn("space-y-3 transition-opacity", !canGenerate && "opacity-40 pointer-events-none")}>
            <h2 className="text-sm font-semibold text-slate-700 px-1">
              3. Consultant Details <span className="font-normal text-slate-400">(saved automatically)</span>
            </h2>
            <ConsultantSection title="Your Consultant" value={consultant} onChange={setConsultant} />
            <ConsultantSection title="Your Candidate Manager" value={manager} onChange={setManager} />
          </div>

          {error && <p className="text-sm text-red-600 px-1">{error}</p>}

          <button
            onClick={handleGenerate}
            disabled={!ready}
            className={cn(
              "w-full flex items-center justify-center gap-2.5 py-3.5 rounded-xl text-sm font-semibold transition-colors",
              ready
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
