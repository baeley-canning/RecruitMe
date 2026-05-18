"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Search, FileText, Loader2, Download, Upload, X, ArrowLeft,
  ArrowRight, CheckCircle2, AlertCircle, Pencil, User, Briefcase,
  ChevronDown, ChevronUp, Scissors,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";

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

// Shared input recipe — the Logic Pro form input class.
const INPUT = "w-full h-7 px-2.5 rounded bg-surface-sunken border border-separator text-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:shadow-focus transition-all";
const INPUT_INLINE = "w-full h-7 px-2 rounded bg-surface-sunken border border-separator text-base text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:shadow-focus transition-all";

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
    <div className="space-y-1.5">
      <p className="text-2xs font-semibold text-text-tertiary uppercase tracking-wider">{label}</p>
      {(["name","email","phone"] as const).map((k) => (
        <input
          key={k}
          type="text"
          placeholder={k.charAt(0).toUpperCase() + k.slice(1)}
          value={value[k]}
          onChange={f(k)}
          className={INPUT}
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
      a.download = `${(draft.candidateName.replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "") || "Candidate")}_Candidate_Profile.docx`;
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
    <div>
      {/* Toolbar */}
      <div className="toolbar">
        <Link href="/jobs" className="text-text-secondary hover:text-text-primary transition-colors">
          <ArrowLeft className="w-3.5 h-3.5" />
        </Link>
        <h1 className="text-md font-semibold text-text-primary" aria-describedby="candidate-profiles-subtitle">Candidate Profiles</h1>
        <span className="text-xs text-text-tertiary hidden sm:inline">
          Generate client-ready Word documents tailored to the target role
        </span>
      </div>

      <div className="p-4 max-w-4xl mx-auto">
        <div className="mb-4">
          <p id="candidate-profiles-subtitle" className="text-text-secondary text-sm">
            Pitches a candidate to a client: pick someone from your library (or upload their CV) and export a tailored .docx profile.
          </p>
          <p className="text-xs text-text-tertiary mt-1">
            Looking to source candidates for a role instead? Start a{" "}
            <Link href="/jobs/new" className="text-accent hover:text-accent-hover font-medium">new job</Link>.
          </p>
        </div>

        {/* Step indicator */}
        {step !== "source" && step !== "download" && (
          <div className="flex items-center gap-2 mb-4 text-base">
            {[
              { id: "source",     label: "Source" },
              { id: "generating", label: "Generating" },
              { id: "review",     label: "Review & Edit" },
            ].map(({ id, label }, i, arr) => (
              <div key={id} className="flex items-center gap-2">
                <span className={cn(
                  "flex items-center gap-1.5 font-medium",
                  step === id
                    ? "text-accent"
                    : (arr.findIndex((a) => a.id === step) > i ? "text-success" : "text-text-tertiary")
                )}>
                  {arr.findIndex((a) => a.id === step) > i
                    ? <CheckCircle2 className="w-4 h-4" />
                    : <span className="w-5 h-5 rounded-full border-2 border-current flex items-center justify-center text-xs">{i + 1}</span>
                  }
                  {label}
                </span>
                {i < arr.length - 1 && <span className="text-text-tertiary">›</span>}
              </div>
            ))}
          </div>
        )}

        {/* ── STEP 1: SOURCE ─────────────────────────────────────────────────── */}
        {step === "source" && (
          <div className="space-y-4">
            {genError && (
              <div className="flex items-start gap-2 p-2.5 bg-danger-subtle border border-separator rounded text-xs text-danger">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                {genError}
              </div>
            )}

            {/* Mode toggle */}
            <div className="flex gap-1.5">
              {(["library","documents"] as SourceMode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setSourceMode(m)}
                  className={cn(
                    "inline-flex items-center gap-1.5 h-7 px-3 rounded text-md font-medium border transition-colors",
                    sourceMode === m
                      ? "bg-accent text-white border-accent"
                      : "bg-surface-raised text-text-secondary border-separator hover:bg-surface-hover hover:text-text-primary"
                  )}
                >
                  {m === "library" ? <User className="w-3.5 h-3.5" /> : <FileText className="w-3.5 h-3.5" />}
                  {m === "library" ? "From candidate library" : "From documents"}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Left: source selector */}
              <Card>
                <CardBody>
                  {sourceMode === "library" ? (
                    <div className="space-y-3">
                      <h2 className="text-md font-semibold text-text-primary">Select candidate</h2>
                      <div className="relative">
                        <Search className="absolute left-2.5 top-2 w-3.5 h-3.5 text-text-tertiary" />
                        <input
                          type="text"
                          value={libSearch}
                          onChange={(e) => setLibSearch(e.target.value)}
                          placeholder="Search by name, role, or company…"
                          className={`${INPUT} pl-8`}
                        />
                      </div>
                      <div className="max-h-64 overflow-y-auto space-y-1">
                        {filteredCandidates.length === 0 && (
                          <p className="text-base text-text-tertiary text-center py-6">No candidates found</p>
                        )}
                        {filteredCandidates.map((c) => (
                          <button
                            key={c.id}
                            onClick={() => setSelectedId(c.id)}
                            className={cn(
                              "w-full text-left p-2 rounded border text-base transition-colors",
                              selectedId === c.id
                                ? "border-accent bg-accent-subtle"
                                : "border-transparent hover:bg-surface-hover"
                            )}
                          >
                            <p className="font-medium text-text-primary">{c.name}</p>
                            <p className="text-text-secondary text-xs truncate">
                              {c.headline ?? c.job?.title ?? c.archivedJobTitle ?? ""}
                              {(c.job?.company ?? "") && ` · ${c.job?.company}`}
                            </p>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <h2 className="text-md font-semibold text-text-primary">Upload documents</h2>
                      <input
                        type="text"
                        value={manualName}
                        onChange={(e) => setManualName(e.target.value)}
                        placeholder="Candidate full name (required)"
                        className={INPUT}
                      />
                      <div
                        onClick={() => fileInputRef.current?.click()}
                        className="border-2 border-dashed border-separator-strong rounded-md p-4 text-center cursor-pointer hover:border-accent hover:bg-surface-hover transition-colors"
                      >
                        <Upload className="w-5 h-5 text-text-tertiary mx-auto mb-1.5" />
                        <p className="text-base text-text-secondary">CV, LinkedIn export, interview notes</p>
                        <p className="text-xs text-text-tertiary mt-0.5">PDF, Word, or TXT</p>
                        <input
                          ref={fileInputRef}
                          type="file"
                          multiple
                          accept=".pdf,.doc,.docx,.txt"
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
                            <div key={i} className="flex items-center justify-between p-2 bg-surface-sunken rounded border border-separator">
                              <span className="text-xs text-text-primary truncate">{f.name}</span>
                              <button onClick={() => setUploadedFiles((prev) => prev.filter((_, j) => j !== i))}>
                                <X className="w-3.5 h-3.5 text-text-tertiary hover:text-danger" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </CardBody>
              </Card>

              {/* Right: target role + JD */}
              <Card>
                <CardBody className="space-y-3">
                  <h2 className="text-md font-semibold text-text-primary">Target role</h2>
                  <div>
                    <label className="text-xs text-text-secondary mb-1 block">
                      Being put forward for <span className="text-danger">*</span>
                    </label>
                    <div className="relative">
                      <Briefcase className="absolute left-2.5 top-2 w-3.5 h-3.5 text-text-tertiary" />
                      <input
                        type="text"
                        value={targetRole}
                        onChange={(e) => setTargetRole(e.target.value)}
                        placeholder="e.g. Senior .NET Developer"
                        className={`${INPUT} pl-8`}
                      />
                    </div>
                    <p className="text-xs text-text-tertiary mt-1">
                      The AI will curate the profile to this role — irrelevant experience trimmed automatically
                    </p>
                  </div>
                  <div>
                    <button
                      onClick={() => setShowJd(!showJd)}
                      className="flex items-center gap-1.5 text-xs text-text-secondary hover:text-accent transition-colors"
                    >
                      {showJd ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                      {showJd ? "Hide job description" : "Add job description (optional, recommended)"}
                    </button>
                    {showJd && (
                      <textarea
                        value={jdText}
                        onChange={(e) => setJdText(e.target.value)}
                        rows={6}
                        placeholder="Paste the job description here. The AI will use it to angle the executive summary toward the specific requirements."
                        className="mt-2 w-full px-2.5 py-2 rounded bg-surface-sunken border border-separator text-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:shadow-focus transition-all resize-none"
                      />
                    )}
                  </div>
                  <Button onClick={handleGenerate} disabled={!canGenerate} variant="primary" size="lg" className="w-full">
                    <ArrowRight className="w-4 h-4" />
                    Generate draft
                  </Button>
                </CardBody>
              </Card>
            </div>
          </div>
        )}

        {/* ── STEP 2: GENERATING ─────────────────────────────────────────────── */}
        {step === "generating" && (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <Loader2 className="w-7 h-7 text-accent animate-spin" />
            <p className="text-md font-medium text-text-primary">{genStatus}</p>
            <p className="text-xs text-text-tertiary">This usually takes 15–25 seconds</p>
          </div>
        )}

        {/* ── STEP 3: REVIEW & EDIT ──────────────────────────────────────────── */}
        {step === "review" && draft && (
          <div className="space-y-4">
            {draft.trimmedPositions > 0 && (
              <div className="flex items-start gap-2 p-2.5 bg-warning-subtle border border-separator rounded text-xs text-warning">
                <Scissors className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                {draft.trimmedPositions} position{draft.trimmedPositions !== 1 ? "s" : ""} trimmed as not relevant to {draft.targetRole}
              </div>
            )}
            {draft.truncated && (
              <div className="flex items-start gap-2 p-2.5 bg-accent-subtle border border-separator rounded text-xs text-accent">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                Profile is long — only the first 16,000 characters were analysed
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {/* Main draft editor */}
              <div className="lg:col-span-2 space-y-3">
                {/* Candidate info */}
                <Card>
                  <CardBody className="space-y-2.5">
                    <h3 className="text-md font-semibold text-text-primary flex items-center gap-2">
                      <User className="w-3.5 h-3.5 text-accent" /> Candidate
                    </h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      <div>
                        <label className="text-xs text-text-secondary mb-1 block">Name</label>
                        <input
                          value={draft.candidateName}
                          onChange={(e) => setDraft({ ...draft, candidateName: e.target.value })}
                          className={INPUT}
                        />
                      </div>
                      <div>
                        <label className="text-xs text-text-secondary mb-1 block">Being put forward for</label>
                        <input
                          value={draft.targetRole}
                          onChange={(e) => setDraft({ ...draft, targetRole: e.target.value })}
                          className={INPUT}
                        />
                      </div>
                      <div>
                        <label className="text-xs text-text-secondary mb-1 block">Availability</label>
                        <input
                          value={dateAvail}
                          onChange={(e) => setDateAvail(e.target.value)}
                          placeholder="e.g. Immediate, 2 weeks notice"
                          className={INPUT}
                        />
                      </div>
                    </div>
                  </CardBody>
                </Card>

                {/* Executive summary */}
                <Card>
                  <CardBody>
                    <h3 className="text-md font-semibold text-text-primary mb-2 flex items-center gap-2">
                      <Pencil className="w-3.5 h-3.5 text-accent" /> Executive Summary
                    </h3>
                    <textarea
                      value={draft.executiveSummary}
                      onChange={(e) => setDraft({ ...draft, executiveSummary: e.target.value })}
                      rows={6}
                      className="w-full px-2.5 py-2 rounded bg-surface-sunken border border-separator text-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:shadow-focus transition-all resize-none"
                    />
                  </CardBody>
                </Card>

                {/* Skills */}
                {draft.skillGroups.length > 0 && (
                  <Card>
                    <CardBody className="space-y-2.5">
                      <h3 className="text-md font-semibold text-text-primary">Key Skills</h3>
                      {draft.skillGroups.map((group, gi) => (
                        <div key={gi} className="space-y-1.5">
                          <input
                            value={group.title}
                            onChange={(e) => {
                              const updated = [...draft.skillGroups];
                              updated[gi] = { ...group, title: e.target.value };
                              setDraft({ ...draft, skillGroups: updated });
                            }}
                            className="w-full px-2 py-1 rounded bg-surface-sunken border border-separator text-xs font-semibold text-text-primary focus:outline-none focus:border-accent focus:shadow-focus transition-all"
                          />
                          <div className="flex flex-wrap gap-1.5">
                            {group.skills.map((skill, si) => (
                              <div key={si} className="flex items-center gap-1 bg-accent-subtle border border-separator rounded-sm px-2 py-0.5">
                                <span className="text-xs text-accent">{skill}</span>
                                <button onClick={() => {
                                  const updated = [...draft.skillGroups];
                                  updated[gi] = { ...group, skills: group.skills.filter((_, j) => j !== si) };
                                  setDraft({ ...draft, skillGroups: updated });
                                }}>
                                  <X className="w-3 h-3 text-accent hover:text-danger" />
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </CardBody>
                  </Card>
                )}

                {/* Work history */}
                {draft.workHistory.length > 0 && (
                  <Card>
                    <CardBody className="space-y-3">
                      <h3 className="text-md font-semibold text-text-primary">Work History</h3>
                      {draft.workHistory.map((job, ji) => (
                        <div key={ji} className="border border-separator rounded-md p-2.5 space-y-2 bg-surface-sunken">
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                            <input
                              value={job.company}
                              onChange={(e) => {
                                const wh = [...draft.workHistory];
                                wh[ji] = { ...job, company: e.target.value };
                                setDraft({ ...draft, workHistory: wh });
                              }}
                              placeholder="Company"
                              className={`${INPUT_INLINE} font-semibold`}
                            />
                            <input
                              value={job.role}
                              onChange={(e) => {
                                const wh = [...draft.workHistory];
                                wh[ji] = { ...job, role: e.target.value };
                                setDraft({ ...draft, workHistory: wh });
                              }}
                              placeholder="Role"
                              className={`${INPUT_INLINE} italic`}
                            />
                            <input
                              value={job.dates}
                              onChange={(e) => {
                                const wh = [...draft.workHistory];
                                wh[ji] = { ...job, dates: e.target.value };
                                setDraft({ ...draft, workHistory: wh });
                              }}
                              placeholder="Dates"
                              className={`${INPUT_INLINE} text-text-secondary data-mono`}
                            />
                          </div>
                          <div className="space-y-1">
                            {job.bullets.map((bullet, bi) => (
                              <div key={bi} className="flex gap-2">
                                <span className="text-text-tertiary mt-1.5 flex-shrink-0">·</span>
                                <textarea
                                  value={bullet}
                                  rows={1}
                                  onChange={(e) => {
                                    const wh = [...draft.workHistory];
                                    const bullets = [...job.bullets];
                                    bullets[bi] = e.target.value;
                                    wh[ji] = { ...job, bullets };
                                    setDraft({ ...draft, workHistory: wh });
                                  }}
                                  className="flex-1 px-2 py-1 rounded bg-surface-base border border-separator-subtle text-base text-text-primary resize-none focus:outline-none focus:border-accent focus:shadow-focus transition-all"
                                />
                                <button onClick={() => {
                                  const wh = [...draft.workHistory];
                                  wh[ji] = { ...job, bullets: job.bullets.filter((_, j) => j !== bi) };
                                  setDraft({ ...draft, workHistory: wh });
                                }} className="mt-1.5">
                                  <X className="w-3.5 h-3.5 text-text-tertiary hover:text-danger" />
                                </button>
                              </div>
                            ))}
                          </div>
                          <button onClick={() => {
                            const wh = [...draft.workHistory];
                            wh[ji] = { ...job, bullets: [...job.bullets, ""] };
                            setDraft({ ...draft, workHistory: wh });
                          }} className="text-xs text-accent hover:text-accent-hover">
                            + Add bullet
                          </button>
                        </div>
                      ))}
                    </CardBody>
                  </Card>
                )}

                {/* Qualifications */}
                {draft.qualifications.length > 0 && (
                  <Card>
                    <CardBody className="space-y-2">
                      <h3 className="text-md font-semibold text-text-primary">Qualifications</h3>
                      {draft.qualifications.map((q, qi) => (
                        <div key={qi} className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <input
                            value={q.institution}
                            onChange={(e) => {
                              const quals = [...draft.qualifications];
                              quals[qi] = { ...q, institution: e.target.value };
                              setDraft({ ...draft, qualifications: quals });
                            }}
                            placeholder="Institution"
                            className={`${INPUT_INLINE} font-medium`}
                          />
                          <input
                            value={q.courseYear}
                            onChange={(e) => {
                              const quals = [...draft.qualifications];
                              quals[qi] = { ...q, courseYear: e.target.value };
                              setDraft({ ...draft, qualifications: quals });
                            }}
                            placeholder="Degree | Year"
                            className={`${INPUT_INLINE} italic`}
                          />
                        </div>
                      ))}
                    </CardBody>
                  </Card>
                )}
              </div>

              {/* Right sidebar: contact details + download */}
              <div className="space-y-3">
                <Card className="sticky top-4">
                  <CardBody className="space-y-3">
                    <ContactBlock label="Your Consultant" value={consultant} onChange={handleConsultantChange} />
                    <ContactBlock label="Candidate Manager" value={manager} onChange={handleManagerChange} />

                    {downloadError && (
                      <p className="text-xs text-danger flex items-center gap-1">
                        <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                        {downloadError}
                      </p>
                    )}

                    <Button
                      onClick={handleDownload}
                      disabled={downloading}
                      loading={downloading}
                      variant="primary"
                      size="lg"
                      className="w-full"
                    >
                      {!downloading && <Download className="w-4 h-4" />}
                      {downloading ? "Building document…" : "Download Word doc"}
                    </Button>
                    <button
                      onClick={handleReset}
                      className="w-full text-xs text-text-tertiary hover:text-text-primary transition-colors"
                    >
                      Start over
                    </button>
                  </CardBody>
                </Card>
              </div>
            </div>
          </div>
        )}

        {/* ── STEP 4: DONE ───────────────────────────────────────────────────── */}
        {step === "download" && draft && (
          <div className="flex flex-col items-center justify-center py-16 gap-4 text-center">
            <div className="w-12 h-12 bg-success-subtle rounded-full flex items-center justify-center">
              <CheckCircle2 className="w-6 h-6 text-success" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-text-primary">Profile downloaded</h2>
              <p className="text-text-secondary text-base mt-0.5">
                {draft.candidateName} — {draft.targetRole}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                onClick={handleDownload}
                disabled={downloading}
                variant="secondary"
                size="lg"
              >
                <Download className="w-3.5 h-3.5" />
                {downloading ? "Downloading…" : "Download again"}
              </Button>
              <Button onClick={() => setStep("review")} variant="secondary" size="lg">
                <Pencil className="w-3.5 h-3.5" />
                Edit profile
              </Button>
              <Button onClick={handleReset} variant="primary" size="lg">
                New profile
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
