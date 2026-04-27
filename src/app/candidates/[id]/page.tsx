"use client";

import { use, useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  MapPin,
  FileText,
  Upload,
  Trash2,
  Download,
  ChevronDown,
  ChevronUp,
  Briefcase,
  Loader2,
  Check,
  X,
  StickyNote,
} from "lucide-react";
import { cn, timeAgo } from "@/lib/utils";

interface CandidateFile {
  id: string;
  type: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

interface OtherJob {
  id: string;
  title: string;
  company: string | null;
  matchScore: number | null;
  status: string;
}

interface CandidateDetail {
  id: string;
  name: string;
  headline: string | null;
  location: string | null;
  linkedinUrl: string | null;
  profileText: string | null;
  matchScore: number | null;
  notes: string | null;
  source: string;
  status: string;
  profileCapturedAt: string | null;
  createdAt: string;
  job: { id: string; title: string; company: string | null };
  files: CandidateFile[];
  otherJobs: OtherJob[];
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function scoreRing(score: number) {
  if (score >= 80) return { ring: "text-emerald-600", bg: "bg-emerald-50", border: "border-emerald-200", label: "Strong" };
  if (score >= 60) return { ring: "text-blue-600", bg: "bg-blue-50", border: "border-blue-200", label: "Good" };
  if (score >= 40) return { ring: "text-amber-500", bg: "bg-amber-50", border: "border-amber-200", label: "Moderate" };
  return { ring: "text-slate-400", bg: "bg-slate-50", border: "border-slate-200", label: "Weak" };
}

function parseSkills(headline: string | null): { skills: string[]; rest: string } {
  if (!headline) return { skills: [], rest: "" };
  const parts = headline.split("|").map((s) => s.trim()).filter(Boolean);
  if (parts.length > 1) return { skills: parts, rest: "" };
  return { skills: [], rest: headline };
}

function typeLabel(type: string) {
  if (type === "cv") return "CV / Resume";
  if (type === "cover_letter") return "Cover Letter";
  return "Other";
}

function typeColor(type: string) {
  if (type === "cv") return "bg-blue-50 text-blue-600 border-blue-100";
  if (type === "cover_letter") return "bg-purple-50 text-purple-600 border-purple-100";
  return "bg-slate-50 text-slate-500 border-slate-100";
}

function LinkedInIcon({ className }: { className?: string }) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 23.2 23.227 23.2 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
    </svg>
  );
}

function FileRow({
  file,
  candidateId,
  onDeleted,
}: {
  file: CandidateFile;
  candidateId: string;
  onDeleted: (id: string) => void;
}) {
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    if (!confirm(`Delete "${file.filename}"?`)) return;
    setDeleting(true);
    await fetch(`/api/candidates/${candidateId}/files/${file.id}`, { method: "DELETE" });
    onDeleted(file.id);
  };

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-white border border-slate-100 group hover:border-slate-200 transition-colors">
      <div className={cn("px-1.5 py-0.5 rounded text-xs font-medium border flex-shrink-0", typeColor(file.type))}>
        {typeLabel(file.type)}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-slate-700 truncate">{file.filename}</p>
        <p className="text-xs text-slate-400">{formatBytes(file.size)} · {timeAgo(new Date(file.createdAt))}</p>
      </div>
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <a
          href={`/api/candidates/${candidateId}/files/${file.id}`}
          download={file.filename}
          className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
          title="Download"
        >
          <Download className="w-3.5 h-3.5" />
        </a>
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50"
          title="Delete"
        >
          {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
        </button>
      </div>
    </div>
  );
}

function UploadZone({
  candidateId,
  onUploaded,
}: {
  candidateId: string;
  onUploaded: (file: CandidateFile) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [type, setType] = useState<"cv" | "cover_letter" | "other">("cv");
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      setError(null);
      setUploading(true);
      try {
        const form = new FormData();
        form.append("file", files[0]);
        form.append("type", type);
        const res = await fetch(`/api/candidates/${candidateId}/files`, { method: "POST", body: form });
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          setError(json.error ?? "Upload failed");
        } else {
          const data = await res.json();
          onUploaded(data);
          if (type === "cv") {
            setNotice(data.scored
              ? "CV uploaded and scored against this candidate's job."
              : "CV saved. To score it, open the candidate from a job page where the JD has been parsed.");
          }
        }
      } catch {
        setError("Upload failed — please try again");
      } finally {
        setUploading(false);
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    [candidateId, type, onUploaded]
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <select
          value={type}
          onChange={(e) => setType(e.target.value as typeof type)}
          className="text-xs border border-slate-200 rounded-lg px-2 py-1.5 bg-white text-slate-600 focus:outline-none focus:border-blue-400"
        >
          <option value="cv">CV / Resume</option>
          <option value="cover_letter">Cover Letter</option>
          <option value="other">Other</option>
        </select>
        <label
          className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-colors",
            uploading
              ? "bg-slate-100 text-slate-400 cursor-not-allowed"
              : "bg-blue-600 hover:bg-blue-500 text-white"
          )}
        >
          {uploading ? (
            <><Loader2 className="w-3.5 h-3.5 animate-spin" />Uploading…</>
          ) : (
            <><Upload className="w-3.5 h-3.5" />Upload file</>
          )}
          <input
            ref={inputRef}
            type="file"
            accept=".pdf,.doc,.docx,.txt,.md"
            className="hidden"
            disabled={uploading}
            onChange={(e) => handleFiles(e.target.files)}
          />
        </label>
      </div>
      <p className="text-xs text-slate-400">PDF, Word, or plain text · max 10 MB</p>
      {error && <p className="text-xs text-red-500 flex items-center gap-1"><X className="w-3 h-3" /> {error}</p>}
      {notice && <p className="text-xs text-slate-500">{notice}</p>}
    </div>
  );
}

export default function CandidateDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [candidate, setCandidate] = useState<CandidateDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [profileExpanded, setProfileExpanded] = useState(false);
  const [notes, setNotes] = useState("");
  const [notesStatus, setNotesStatus] = useState<"idle" | "saving" | "saved">("idle");

  useEffect(() => {
    fetch(`/api/candidates/${id}`)
      .then((r) => {
        if (r.status === 404 || r.status === 403) { setNotFound(true); return null; }
        return r.json();
      })
      .then((data) => {
        if (data) {
          setCandidate(data);
          setNotes(data.notes ?? "");
        }
      })
      .finally(() => setLoading(false));
  }, [id]);

  const saveNotes = useCallback(async () => {
    if (!candidate) return;
    setNotesStatus("saving");
    await fetch(`/api/candidates/${candidate.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes }),
    });
    setNotesStatus("saved");
    setTimeout(() => setNotesStatus("idle"), 2000);
  }, [candidate, notes]);

  const handleFileUploaded = useCallback((file: CandidateFile) => {
    setCandidate((prev) => prev ? { ...prev, files: [file, ...prev.files] } : prev);
  }, []);

  const handleFileDeleted = useCallback((fileId: string) => {
    setCandidate((prev) => prev ? { ...prev, files: prev.files.filter((f) => f.id !== fileId) } : prev);
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 animate-spin text-slate-300" />
      </div>
    );
  }

  if (notFound || !candidate) {
    return (
      <div className="p-8 text-center text-slate-500">
        Candidate not found.{" "}
        <Link href="/candidates" className="text-blue-600 hover:underline">Back to library</Link>
      </div>
    );
  }

  const { skills, rest } = parseSkills(candidate.headline);
  const initials = candidate.name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  const scoreInfo = candidate.matchScore !== null ? scoreRing(candidate.matchScore) : null;
  const allJobs = [
    { id: candidate.job.id, title: candidate.job.title, company: candidate.job.company, matchScore: candidate.matchScore, status: candidate.status },
    ...candidate.otherJobs,
  ];

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Top bar */}
      <div className="bg-white border-b border-slate-200 px-8 py-3">
        <Link
          href="/candidates"
          className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-900 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Candidates Library
        </Link>
      </div>

      {/* Hero header */}
      <div className="bg-white border-b border-slate-200">
        <div className="max-w-5xl mx-auto px-8 py-8">
          <div className="flex items-start gap-6">
            {/* Avatar */}
            <div className="relative flex-shrink-0">
              <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white text-2xl font-bold shadow-lg shadow-blue-200">
                {initials}
              </div>
              {scoreInfo && (
                <div className={cn(
                  "absolute -bottom-2 -right-2 w-9 h-9 rounded-xl border-2 border-white flex items-center justify-center text-xs font-bold shadow-sm",
                  scoreInfo.bg, scoreInfo.ring
                )}>
                  {candidate.matchScore}
                </div>
              )}
            </div>

            {/* Name + details */}
            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h1 className="text-2xl font-bold text-slate-900">{candidate.name}</h1>
                  {rest && <p className="text-slate-500 mt-0.5">{rest}</p>}
                </div>
                {scoreInfo && (
                  <div className={cn("flex flex-col items-center px-4 py-2 rounded-xl border", scoreInfo.bg, scoreInfo.border)}>
                    <span className={cn("text-2xl font-bold", scoreInfo.ring)}>{candidate.matchScore}%</span>
                    <span className={cn("text-xs font-medium", scoreInfo.ring)}>{scoreInfo.label}</span>
                  </div>
                )}
              </div>

              {/* Skill tags */}
              {skills.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-3">
                  {skills.map((skill) => (
                    <span
                      key={skill}
                      className="px-2.5 py-1 bg-slate-100 text-slate-600 rounded-lg text-xs font-medium hover:bg-blue-50 hover:text-blue-700 transition-colors"
                    >
                      {skill}
                    </span>
                  ))}
                </div>
              )}

              {/* Meta row */}
              <div className="flex flex-wrap items-center gap-4 mt-3">
                {candidate.location && (
                  <span className="flex items-center gap-1.5 text-sm text-slate-500">
                    <MapPin className="w-3.5 h-3.5" />
                    {candidate.location}
                  </span>
                )}
                {candidate.linkedinUrl && (
                  <a
                    href={candidate.linkedinUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-sm text-[#0077B5] hover:text-[#005582] font-medium transition-colors"
                  >
                    <LinkedInIcon className="w-4 h-4" />
                    LinkedIn profile
                  </a>
                )}
                <span className="text-sm text-slate-400">
                  {candidate.profileCapturedAt
                    ? `Captured ${timeAgo(new Date(candidate.profileCapturedAt))}`
                    : `Added ${timeAgo(new Date(candidate.createdAt))}`}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="max-w-5xl mx-auto px-8 py-7">
        <div className="grid grid-cols-3 gap-6">

          {/* Left — profile + notes */}
          <div className="col-span-2 space-y-5">

            {/* LinkedIn Profile */}
            {candidate.profileText && (
              <section className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
                <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
                  <h2 className="text-sm font-semibold text-slate-800">LinkedIn Profile</h2>
                  <button
                    onClick={() => setProfileExpanded((v) => !v)}
                    className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-700 transition-colors"
                  >
                    {profileExpanded ? (
                      <><ChevronUp className="w-3.5 h-3.5" />Collapse</>
                    ) : (
                      <><ChevronDown className="w-3.5 h-3.5" />Expand</>
                    )}
                  </button>
                </div>
                <div className="relative px-5 py-4">
                  <div
                    className={cn(
                      "text-sm text-slate-600 whitespace-pre-wrap leading-relaxed overflow-hidden transition-all duration-300",
                      profileExpanded ? "max-h-[2000px]" : "max-h-44"
                    )}
                  >
                    {candidate.profileText}
                  </div>
                  {!profileExpanded && (
                    <div className="absolute bottom-0 left-0 right-0 h-14 bg-gradient-to-t from-white to-transparent pointer-events-none" />
                  )}
                </div>
                {!profileExpanded && (
                  <div className="px-5 pb-4">
                    <button
                      onClick={() => setProfileExpanded(true)}
                      className="text-xs text-blue-600 hover:text-blue-700 font-medium"
                    >
                      Show full profile
                    </button>
                  </div>
                )}
              </section>
            )}

            {/* Notes */}
            <section className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
              <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
                <div className="flex items-center gap-2">
                  <StickyNote className="w-4 h-4 text-slate-400" />
                  <h2 className="text-sm font-semibold text-slate-800">Notes</h2>
                </div>
                {notesStatus !== "idle" && (
                  <span className={cn("text-xs flex items-center gap-1", notesStatus === "saved" ? "text-emerald-600" : "text-slate-400")}>
                    {notesStatus === "saving" ? (
                      <><Loader2 className="w-3 h-3 animate-spin" />Saving…</>
                    ) : (
                      <><Check className="w-3 h-3" />Saved</>
                    )}
                  </span>
                )}
              </div>
              <div className="px-5 py-4">
                <textarea
                  value={notes}
                  onChange={(e) => { setNotes(e.target.value); setNotesStatus("idle"); }}
                  onBlur={saveNotes}
                  rows={5}
                  placeholder="Add notes about this candidate…"
                  className="w-full text-sm text-slate-700 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 placeholder-slate-400 focus:outline-none focus:border-blue-400 focus:bg-white resize-none transition-colors"
                />
              </div>
            </section>
          </div>

          {/* Right — docs + jobs */}
          <div className="space-y-5">

            {/* Documents */}
            <section className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
              <div className="flex items-center gap-2 px-5 py-4 border-b border-slate-100">
                <FileText className="w-4 h-4 text-slate-400" />
                <h2 className="text-sm font-semibold text-slate-800">Documents</h2>
                {candidate.files.length > 0 && (
                  <span className="ml-auto text-xs text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded-full">
                    {candidate.files.length}
                  </span>
                )}
              </div>
              <div className="px-4 py-4 space-y-2">
                {candidate.files.length === 0 && (
                  <p className="text-xs text-slate-400 text-center py-2">No files yet</p>
                )}
                {candidate.files.map((f) => (
                  <FileRow
                    key={f.id}
                    file={f}
                    candidateId={candidate.id}
                    onDeleted={handleFileDeleted}
                  />
                ))}
              </div>
              <div className="px-4 pb-4">
                <UploadZone candidateId={candidate.id} onUploaded={handleFileUploaded} />
              </div>
            </section>

            {/* Jobs */}
            <section className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
              <div className="flex items-center gap-2 px-5 py-4 border-b border-slate-100">
                <Briefcase className="w-4 h-4 text-slate-400" />
                <h2 className="text-sm font-semibold text-slate-800">Jobs</h2>
              </div>
              <div className="px-3 py-3 space-y-1">
                {allJobs.map((job) => (
                  <Link
                    key={job.id}
                    href={`/jobs/${job.id}`}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-slate-50 transition-colors group"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-700 group-hover:text-blue-600 line-clamp-1 transition-colors">
                        {job.title}
                      </p>
                      {job.company && (
                        <p className="text-xs text-slate-400 line-clamp-1">{job.company}</p>
                      )}
                    </div>
                    {job.matchScore !== null && (
                      <span className={cn(
                        "text-xs font-bold px-2 py-0.5 rounded-lg flex-shrink-0",
                        scoreRing(job.matchScore).bg,
                        scoreRing(job.matchScore).ring
                      )}>
                        {job.matchScore}%
                      </span>
                    )}
                  </Link>
                ))}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
