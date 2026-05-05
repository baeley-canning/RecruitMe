"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Search, FileText, Loader2, Download, Upload, X, ArrowLeft,
  ArrowRight, CheckCircle2, AlertCircle, Pencil, User, Briefcase,
  ChevronDown, ChevronUp, Scissors,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Candidate {
  id: string;
  name: string;
  headline: string | null;
  location: string | null;
  source: string;
  job: { id: string; title: string; company: string | null } | null;
  archivedJobTitle: string | null;
}

interface ContactFields { name: string; email: string; phone: string }

interface SkillGroup { title: string; skills: string[] }
interface WorkItem   { company: string; role: string; dates: string; bullets: string[] }
interface Qual       { institution: string; courseYear: string }

interface ProfileDraft {
  candidateName:    string;
  targetRole:       string;
  availability:     string;
  executiveSummary: string;
  skillGroups:      SkillGroup[];
  workHistory:      WorkItem[];
  qualifications:   Qual[];
  trimmedPositions: number;
  truncated:        boolean;
}

type Step = "source" | "generating" | "review" | "download";
type SourceMode = "library" | "documents";

// ─── Persistence ──────────────────────────────────────────────────────────────

const STORAGE_KEY = "recruitme:profile-consultant-v2";
const SETTINGS_ENDPOINT = "/api/candidate-profiles/settings";

function str(v: unknown): string { return typeof v === "string" ? v : ""; }

function loadSaved(): { consultant: ContactFields; manager: ContactFields } {
  try {
    const p = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return {
      consultant: { name: str(p.consultant?.name), email: str(p.consultant?.email), phone: str(p.consultant?.phone) },
      manager:    { name: str(p.manager?.name),    email: str(p.manager?.email),    phone: str(p.manager?.phone)    },
    };
  } catch {
    return { consultant: { name:"",email:"",phone:"" }, manager: { name:"",email:"",phone:"" } };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ContactBlock({ label, value, onChange }: {
  label: string;
  value: ContactFields;
  onChange: (v: ContactFields) => void;
}) {
  const f = (field: keyof ContactFields) => (e: React.ChangeEvent<HTMLInputElement>) =>
    onChange({ ...value, [field]: e.target.value });
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-slate-700 uppercase tracking-wide">{label}</p>
      {(["name","email","phone"] as const).map((k) => (
        <input key={k} type="text" placeholder={k.charAt(0).toUpperCase() + k.slice(1)}
          value={value[k]} onChange={f(k)}
          className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      ))}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function CandidateProfilesPage() {
  const [step, setStep]             = useState<Step>("source");
  const [sourceMode, setSourceMode] = useState<SourceMode>("library");

  // Source: library
  const [candidates, setCandidates]   = useState<Candidate[]>([]);
  const [libSearch, setLibSearch]     = useState("");
  const [selectedId, setSelectedId]   = useState<string | null>(null);

  // Source: documents
  const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);
  const [manualName, setManualName]       = useState("");

  // Shared source inputs
  const [targetRole, setTargetRole] = useState("");
  const [jdText, setJdText]         = useState("");
  const [showJd, setShowJd]         = useState(false);

  // Draft review state
  const [draft, setDraft]       = useState<ProfileDraft | null>(null);
  const [genError, setGenError] = useState("");
  const [genStatus, setGenStatus] = useState("");

  // Contact details
  const [consultant, setConsultant] = useState<ContactFields>({ name:"",email:"",phone:"" });
  const [manager,    setManager]    = useState<ContactFields>({ name:"",email:"",phone:"" });
  const [dateAvail,  setDateAvail]  = useState("");

  // Download
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Load candidates + saved settings on mount
  useEffect(() => {
    fetch("/api/candidates?includeFiles=false").then(async (r) => {
      if (r.ok) {
        const data = await r.json() as Candidate[];
        setCandidates(data);
      }
    }).catch(() => {});

    // Load settings: server first, localStorage fallback
    fetch(SETTINGS_ENDPOINT).then(async (r) => {
      if (r.ok) {
        const s = await r.json() as { consultant?: ContactFields; manager?: ContactFields };
        if (s.consultant?.name || s.manager?.name) {
          if (s.consultant) setConsultant(s.consultant);
          if (s.manager)    setManager(s.manager);
          return;
        }
      }
      const saved = loadSaved();
      setConsultant(saved.consultant);
      setManager(saved.manager);
    }).catch(() => {
      const saved = loadSaved();
      setConsultant(saved.consultant);
      setManager(saved.manager);
    });
  }, []);

  // Auto-save contact details
  const saveContacts = (c: ContactFields, m: ContactFields) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ consultant: c, manager: m }));
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      fetch(SETTINGS_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ consultant: c, manager: m }),
      }).catch(() => {});
    }, 500);
  };

  const handleConsultantChange = (v: ContactFields) => { setConsultant(v); saveContacts(v, manager); };
  const handleManagerChange    = (v: ContactFields) => { setManager(v);    saveContacts(consultant, v); };

  // Filter library candidates
  const filteredCandidates = candidates.filter((c) => {
    if (!libSearch.trim()) return true;
    const q = libSearch.toLowerCase();
    return (
      c.name.toLowerCase().includes(q) ||
      (c.headline ?? "").toLowerCase().includes(q) ||
      (c.job?.title ?? "").toLowerCase().includes(q) ||
      (c.job?.company ?? "").toLowerCase().includes(q)
    );
  }).slice(0, 60);

  const selectedCandidate = candidates.find((c) => c.id === selectedId) ?? null;

  // ── Step 1 validation ──────────────────────────────────────────────────────
  const canGenerate = Boolean(
    targetRole.trim() &&
    (sourceMode === "library" ? selectedId : (uploadedFiles.length > 0 && manualName.trim()))
  );

  // ── Generate draft ─────────────────────────────────────────────────────────
  const handleGenerate = async () => {
    if (!canGenerate) return;
    setGenError("");
    setStep("generating");

    const STATUSES = [
      "Extracting profile information…",
      "Selecting relevant experience for the role…",
      "Grouping skills by category…",
      "Writing executive summary…",
    ];
    let si = 0;
    setGenStatus(STATUSES[0]);
    const interval = setInterval(() => {
      si = Math.min(si + 1, STATUSES.length - 1);
      setGenStatus(STATUSES[si]);
    }, 5000);

    try {
      let res: Response;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 90_000); // 90s max
      try {
        if (sourceMode === "library") {
          res = await fetch("/api/candidate-profiles/draft", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ candidateId: selectedId, targetRole: targetRole.trim(), jdText: jdText.trim() || undefined }),
            signal: controller.signal,
          });
        } else {
          const form = new FormData();
          form.append("candidateName", manualName.trim());
          form.append("targetRole",    targetRole.trim());
          if (jdText.trim()) form.append("jdText", jdText.trim());
          uploadedFiles.forEach((f) => form.append("files", f));
          res = await fetch("/api/candidate-profiles/draft", { method: "POST", body: form, signal: controller.signal });
        }
      } finally {
        clearTimeout(timeout);
      }

      clearInterval(interval);

      const data = await res.json() as {
        candidateName?: string;
        targetRole?: string;
        sections?: {
          executiveSummary?: string;
          skillGroups?: SkillGroup[];
          workHistory?: WorkItem[];
          qualifications?: Qual[];
          availability?: string;
          trimmedPositions?: number;
        };
        truncated?: boolean;
        error?: string;
      };

      if (!res.ok || data.error) {
        setGenError(data.error ?? "Generation failed. Try again.");
        setStep("source");
        return;
      }

      setDraft({
        candidateName:    data.candidateName ?? (selectedCandidate?.name ?? manualName),
        targetRole:       data.targetRole    ?? targetRole,
        availability:     data.sections?.availability ?? "",
        executiveSummary: data.sections?.executiveSummary ?? "",
        skillGroups:      data.sections?.skillGroups      ?? [],
        workHistory:      data.sections?.workHistory      ?? [],
        qualifications:   data.sections?.qualifications   ?? [],
        trimmedPositions: data.sections?.trimmedPositions ?? 0,
        truncated:        data.truncated ?? false,
      });
      setDateAvail(data.sections?.availability ?? "");
      setStep("review");
    } catch (err) {
      clearInterval(interval);
      const isTimeout = err instanceof Error && err.name === "AbortError";
      setGenError(isTimeout
        ? "Generation timed out (90s). The AI may be slow — please try again."
        : (err instanceof Error ? err.message : "Network error. Please try again.")
      );
      setStep("source");
    }
  };

  // ── Download ───────────────────────────────────────────────────────────────
  const handleDownload = async () => {
    if (!draft) return;
    setDownloadError("");
    setDownloading(true);
    try {
      const res = await fetch("/api/candidate-profiles/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          candidateName:    draft.candidateName,
          targetRole:       draft.targetRole,
          dateAvailable:    dateAvail,
          executiveSummary: draft.executiveSummary,
          skillGroups:      draft.skillGroups,
          workHistory:      draft.workHistory,
          qualifications:   draft.qualifications,
          consultant,
          manager,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        setDownloadError(err.error ?? "Download failed. Try again.");
        return;
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${draft.candidateName.replace(/[^a-zA-Z0-9]/g, "_")}_Candidate_Profile.docx`;
      a.click();
      URL.revokeObjectURL(url);
      setStep("download");
    } catch {
      setDownloadError("Network error. Please try again.");
    } finally {
      setDownloading(false);
    }
  };

  const handleReset = () => {
    setStep("source");
    setDraft(null);
    setGenError("");
    setSelectedId(null);
    setUploadedFiles([]);
    setManualName("");
    setTargetRole("");
    setJdText("");
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="p-8 max-w-4xl mx-auto">
      <div className="flex items-center gap-3 mb-8">
        <Link href="/jobs" className="text-slate-400 hover:text-slate-600 transition-colors">
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Candidate Profiles</h1>
          <p className="text-slate-500 text-sm mt-0.5">Generate client-ready Word documents tailored to the target role</p>
        </div>
      </div>

      {/* Step indicator */}
      {step !== "source" && step !== "download" && (
        <div className="flex items-center gap-2 mb-6 text-sm">
          {[
            { id: "source",     label: "Source" },
            { id: "generating", label: "Generating" },
            { id: "review",     label: "Review & Edit" },
          ].map(({ id, label }, i, arr) => (
            <div key={id} className="flex items-center gap-2">
              <span className={cn(
                "flex items-center gap-1.5 font-medium",
                step === id ? "text-blue-600" : (
                  arr.findIndex((a) => a.id === step) > i ? "text-emerald-600" : "text-slate-400"
                )
              )}>
                {arr.findIndex((a) => a.id === step) > i
                  ? <CheckCircle2 className="w-4 h-4" />
                  : <span className="w-5 h-5 rounded-full border-2 border-current flex items-center justify-center text-xs">{i + 1}</span>
                }
                {label}
              </span>
              {i < arr.length - 1 && <span className="text-slate-300">›</span>}
            </div>
          ))}
        </div>
      )}

      {/* ── STEP 1: SOURCE ─────────────────────────────────────────────────── */}
      {step === "source" && (
        <div className="space-y-6">
          {genError && (
            <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              {genError}
            </div>
          )}

          {/* Mode toggle */}
          <div className="flex gap-2">
            {(["library","documents"] as SourceMode[]).map((m) => (
              <button key={m} onClick={() => setSourceMode(m)}
                className={cn(
                  "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border transition-colors",
                  sourceMode === m
                    ? "bg-blue-600 text-white border-blue-600"
                    : "bg-white text-slate-600 border-slate-200 hover:border-slate-300"
                )}
              >
                {m === "library" ? <User className="w-4 h-4" /> : <FileText className="w-4 h-4" />}
                {m === "library" ? "From candidate library" : "From documents"}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Left: source selector */}
            <div className="bg-white rounded-xl border border-slate-200 p-5">
              {sourceMode === "library" ? (
                <div className="space-y-3">
                  <h2 className="text-sm font-semibold text-slate-900">Select candidate</h2>
                  <div className="relative">
                    <Search className="absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
                    <input
                      type="text" value={libSearch} onChange={(e) => setLibSearch(e.target.value)}
                      placeholder="Search by name, role, or company…"
                      className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div className="max-h-64 overflow-y-auto space-y-1">
                    {filteredCandidates.length === 0 && (
                      <p className="text-sm text-slate-400 text-center py-6">No candidates found</p>
                    )}
                    {filteredCandidates.map((c) => (
                      <button key={c.id} onClick={() => setSelectedId(c.id)}
                        className={cn(
                          "w-full text-left p-2.5 rounded-lg border text-sm transition-colors",
                          selectedId === c.id
                            ? "border-blue-500 bg-blue-50"
                            : "border-transparent hover:bg-slate-50"
                        )}
                      >
                        <p className="font-medium text-slate-900">{c.name}</p>
                        <p className="text-slate-500 text-xs truncate">
                          {c.headline ?? c.job?.title ?? c.archivedJobTitle ?? ""}
                          {(c.job?.company ?? "") && ` · ${c.job?.company}`}
                        </p>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <h2 className="text-sm font-semibold text-slate-900">Upload documents</h2>
                  <input
                    type="text" value={manualName} onChange={(e) => setManualName(e.target.value)}
                    placeholder="Candidate full name (required)"
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <div
                    onClick={() => fileInputRef.current?.click()}
                    className="border-2 border-dashed border-slate-200 rounded-lg p-6 text-center cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition-colors"
                  >
                    <Upload className="w-6 h-6 text-slate-400 mx-auto mb-2" />
                    <p className="text-sm text-slate-600">CV, LinkedIn export, interview notes</p>
                    <p className="text-xs text-slate-400 mt-1">PDF, Word, or TXT</p>
                    <input ref={fileInputRef} type="file" multiple accept=".pdf,.doc,.docx,.txt"
                      className="hidden"
                      onChange={(e) => {
                        const files = Array.from(e.target.files ?? []);
                        setUploadedFiles((prev) => [...prev, ...files]);
                      }}
                    />
                  </div>
                  {uploadedFiles.length > 0 && (
                    <div className="space-y-1">
                      {uploadedFiles.map((f, i) => (
                        <div key={i} className="flex items-center justify-between p-2 bg-slate-50 rounded-lg">
                          <span className="text-xs text-slate-700 truncate">{f.name}</span>
                          <button onClick={() => setUploadedFiles((prev) => prev.filter((_, j) => j !== i))}>
                            <X className="w-3.5 h-3.5 text-slate-400 hover:text-red-500" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Right: target role + JD */}
            <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
              <h2 className="text-sm font-semibold text-slate-900">Target role</h2>
              <div>
                <label className="text-xs text-slate-500 mb-1 block">Being put forward for <span className="text-red-500">*</span></label>
                <div className="relative">
                  <Briefcase className="absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
                  <input
                    type="text" value={targetRole} onChange={(e) => setTargetRole(e.target.value)}
                    placeholder="e.g. Senior .NET Developer"
                    className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <p className="text-xs text-slate-400 mt-1">The AI will curate the profile to this role — irrelevant experience trimmed automatically</p>
              </div>
              <div>
                <button
                  onClick={() => setShowJd(!showJd)}
                  className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-blue-600 transition-colors"
                >
                  {showJd ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                  {showJd ? "Hide job description" : "Add job description (optional, recommended)"}
                </button>
                {showJd && (
                  <textarea
                    value={jdText} onChange={(e) => setJdText(e.target.value)}
                    rows={6}
                    placeholder="Paste the job description here. The AI will use it to angle the executive summary toward the specific requirements."
                    className="mt-2 w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                  />
                )}
              </div>
              <button
                onClick={handleGenerate} disabled={!canGenerate}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors"
              >
                <ArrowRight className="w-4 h-4" />
                Generate draft
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── STEP 2: GENERATING ─────────────────────────────────────────────── */}
      {step === "generating" && (
        <div className="flex flex-col items-center justify-center py-24 gap-4">
          <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
          <p className="text-slate-700 font-medium">{genStatus}</p>
          <p className="text-slate-400 text-sm">This usually takes 15–25 seconds</p>
        </div>
      )}

      {/* ── STEP 3: REVIEW & EDIT ──────────────────────────────────────────── */}
      {step === "review" && draft && (
        <div className="space-y-5">
          {draft.trimmedPositions > 0 && (
            <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-700">
              <Scissors className="w-4 h-4 mt-0.5 flex-shrink-0" />
              {draft.trimmedPositions} position{draft.trimmedPositions !== 1 ? "s" : ""} trimmed as not relevant to {draft.targetRole}
            </div>
          )}
          {draft.truncated && (
            <div className="flex items-start gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-700">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              Profile is long — only the first 16,000 characters were analysed
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            {/* Main draft editor */}
            <div className="lg:col-span-2 space-y-4">

              {/* Candidate info */}
              <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-3">
                <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                  <User className="w-4 h-4 text-blue-500" /> Candidate
                </h3>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-slate-500 mb-1 block">Name</label>
                    <input value={draft.candidateName}
                      onChange={(e) => setDraft({ ...draft, candidateName: e.target.value })}
                      className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 mb-1 block">Being put forward for</label>
                    <input value={draft.targetRole}
                      onChange={(e) => setDraft({ ...draft, targetRole: e.target.value })}
                      className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 mb-1 block">Availability</label>
                    <input value={dateAvail} onChange={(e) => setDateAvail(e.target.value)}
                      placeholder="e.g. Immediate, 2 weeks notice"
                      className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>
              </div>

              {/* Executive summary */}
              <div className="bg-white rounded-xl border border-slate-200 p-5">
                <h3 className="text-sm font-semibold text-slate-900 mb-3 flex items-center gap-2">
                  <Pencil className="w-4 h-4 text-blue-500" /> Executive Summary
                </h3>
                <textarea
                  value={draft.executiveSummary}
                  onChange={(e) => setDraft({ ...draft, executiveSummary: e.target.value })}
                  rows={6}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                />
              </div>

              {/* Skills */}
              {draft.skillGroups.length > 0 && (
                <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-3">
                  <h3 className="text-sm font-semibold text-slate-900">Key Skills</h3>
                  {draft.skillGroups.map((group, gi) => (
                    <div key={gi} className="space-y-1.5">
                      <input
                        value={group.title}
                        onChange={(e) => {
                          const updated = [...draft.skillGroups];
                          updated[gi] = { ...group, title: e.target.value };
                          setDraft({ ...draft, skillGroups: updated });
                        }}
                        className="w-full px-2.5 py-1 border border-slate-200 rounded text-xs font-semibold text-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                      <div className="flex flex-wrap gap-1.5">
                        {group.skills.map((skill, si) => (
                          <div key={si} className="flex items-center gap-1 bg-blue-50 border border-blue-200 rounded px-2 py-0.5">
                            <span className="text-xs text-blue-700">{skill}</span>
                            <button onClick={() => {
                              const updated = [...draft.skillGroups];
                              updated[gi] = { ...group, skills: group.skills.filter((_, j) => j !== si) };
                              setDraft({ ...draft, skillGroups: updated });
                            }}>
                              <X className="w-3 h-3 text-blue-400 hover:text-red-500" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Work history */}
              {draft.workHistory.length > 0 && (
                <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
                  <h3 className="text-sm font-semibold text-slate-900">Work History</h3>
                  {draft.workHistory.map((job, ji) => (
                    <div key={ji} className="border border-slate-100 rounded-lg p-3 space-y-2">
                      <div className="grid grid-cols-3 gap-2">
                        <input value={job.company}
                          onChange={(e) => {
                            const wh = [...draft.workHistory];
                            wh[ji] = { ...job, company: e.target.value };
                            setDraft({ ...draft, workHistory: wh });
                          }}
                          placeholder="Company"
                          className="px-2.5 py-1.5 border border-slate-200 rounded text-sm font-semibold focus:outline-none focus:ring-1 focus:ring-blue-500"
                        />
                        <input value={job.role}
                          onChange={(e) => {
                            const wh = [...draft.workHistory];
                            wh[ji] = { ...job, role: e.target.value };
                            setDraft({ ...draft, workHistory: wh });
                          }}
                          placeholder="Role"
                          className="px-2.5 py-1.5 border border-slate-200 rounded text-sm italic focus:outline-none focus:ring-1 focus:ring-blue-500"
                        />
                        <input value={job.dates}
                          onChange={(e) => {
                            const wh = [...draft.workHistory];
                            wh[ji] = { ...job, dates: e.target.value };
                            setDraft({ ...draft, workHistory: wh });
                          }}
                          placeholder="Dates"
                          className="px-2.5 py-1.5 border border-slate-200 rounded text-sm text-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        />
                      </div>
                      <div className="space-y-1">
                        {job.bullets.map((bullet, bi) => (
                          <div key={bi} className="flex gap-2">
                            <span className="text-slate-400 mt-2 flex-shrink-0">·</span>
                            <textarea value={bullet} rows={1}
                              onChange={(e) => {
                                const wh = [...draft.workHistory];
                                const bullets = [...job.bullets];
                                bullets[bi] = e.target.value;
                                wh[ji] = { ...job, bullets };
                                setDraft({ ...draft, workHistory: wh });
                              }}
                              className="flex-1 px-2 py-1 border border-slate-100 rounded text-sm resize-none focus:outline-none focus:ring-1 focus:ring-blue-500"
                            />
                            <button onClick={() => {
                              const wh = [...draft.workHistory];
                              wh[ji] = { ...job, bullets: job.bullets.filter((_, j) => j !== bi) };
                              setDraft({ ...draft, workHistory: wh });
                            }} className="mt-1.5">
                              <X className="w-3.5 h-3.5 text-slate-300 hover:text-red-400" />
                            </button>
                          </div>
                        ))}
                      </div>
                      <button onClick={() => {
                        const wh = [...draft.workHistory];
                        wh[ji] = { ...job, bullets: [...job.bullets, ""] };
                        setDraft({ ...draft, workHistory: wh });
                      }} className="text-xs text-blue-500 hover:text-blue-700">
                        + Add bullet
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Qualifications */}
              {draft.qualifications.length > 0 && (
                <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-2">
                  <h3 className="text-sm font-semibold text-slate-900">Qualifications</h3>
                  {draft.qualifications.map((q, qi) => (
                    <div key={qi} className="grid grid-cols-2 gap-2">
                      <input value={q.institution}
                        onChange={(e) => {
                          const quals = [...draft.qualifications];
                          quals[qi] = { ...q, institution: e.target.value };
                          setDraft({ ...draft, qualifications: quals });
                        }}
                        placeholder="Institution"
                        className="px-2.5 py-1.5 border border-slate-200 rounded text-sm font-medium focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                      <input value={q.courseYear}
                        onChange={(e) => {
                          const quals = [...draft.qualifications];
                          quals[qi] = { ...q, courseYear: e.target.value };
                          setDraft({ ...draft, qualifications: quals });
                        }}
                        placeholder="Degree | Year"
                        className="px-2.5 py-1.5 border border-slate-200 rounded text-sm italic focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Right sidebar: contact details + download */}
            <div className="space-y-4">
              <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4 sticky top-6">
                <ContactBlock label="Your Consultant" value={consultant} onChange={handleConsultantChange} />
                <ContactBlock label="Candidate Manager" value={manager} onChange={handleManagerChange} />

                {downloadError && (
                  <p className="text-xs text-red-600 flex items-center gap-1">
                    <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                    {downloadError}
                  </p>
                )}

                <button
                  onClick={handleDownload} disabled={downloading}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
                >
                  {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                  {downloading ? "Building document…" : "Download Word doc"}
                </button>
                <button onClick={handleReset}
                  className="w-full text-sm text-slate-400 hover:text-slate-600 transition-colors"
                >
                  Start over
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── STEP 4: DONE ───────────────────────────────────────────────────── */}
      {step === "download" && draft && (
        <div className="flex flex-col items-center justify-center py-20 gap-5 text-center">
          <div className="w-14 h-14 bg-emerald-50 rounded-full flex items-center justify-center">
            <CheckCircle2 className="w-7 h-7 text-emerald-500" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-slate-900">Profile downloaded</h2>
            <p className="text-slate-500 text-sm mt-1">
              {draft.candidateName} — {draft.targetRole}
            </p>
          </div>
          <div className="flex gap-3">
            <button
              onClick={handleDownload} disabled={downloading}
              className="flex items-center gap-2 px-4 py-2 border border-slate-200 hover:bg-slate-50 text-slate-700 rounded-lg text-sm font-medium transition-colors"
            >
              <Download className="w-4 h-4" />
              {downloading ? "Downloading…" : "Download again"}
            </button>
            <button onClick={() => setStep("review")}
              className="flex items-center gap-2 px-4 py-2 border border-slate-200 hover:bg-slate-50 text-slate-700 rounded-lg text-sm font-medium transition-colors"
            >
              <Pencil className="w-4 h-4" />
              Edit profile
            </button>
            <button onClick={handleReset}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
            >
              New profile
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
