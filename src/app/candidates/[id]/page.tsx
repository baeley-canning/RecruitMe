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
import { formatBytes } from "@/lib/format";
import { scoreTier as canonicalScoreTier, type ScoreTier } from "@/lib/score-utils";
import { displayableLinkedinUrl } from "@/components/candidate/helpers";
import { Card, CardHeader, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { confirm } from "@/components/ui/confirm-dialog";

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
  job: { id: string; title: string; company: string | null } | null;
  archivedJobTitle: string | null;
  archivedJobCompany: string | null;
  files: CandidateFile[];
  otherJobs: OtherJob[];
}

// Score tier styling for the detail page — token-only.
// Bucketing is delegated to the canonical scoreTier helper (80/65/50 for
// match scores). This page needs both a text-colour AND a progress-bar fill
// colour per tier, so we keep a small mapping here rather than routing
// through scoreTierColor (which returns combined bg+text classes for badges).
const TIER_STYLE: Record<ScoreTier, { text: string; fill: string; label: string }> = {
  strong: { text: "text-success",        fill: "bg-success",        label: "Strong" },
  fair:   { text: "text-accent",         fill: "bg-accent",         label: "Good" },
  weak:   { text: "text-warning",        fill: "bg-warning",        label: "Moderate" },
  poor:   { text: "text-text-tertiary",  fill: "bg-text-tertiary",  label: "Weak" },
};


function scoreTier(score: number) {
  return TIER_STYLE[canonicalScoreTier(score, "match")];
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

function typeBadgeClass(type: string) {
  if (type === "cv") return "bg-accent-subtle text-accent";
  if (type === "cover_letter") return "bg-llama-subtle text-llama";
  return "bg-surface-hover text-text-secondary";
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
    if (!await confirm({ message: `Delete "${file.filename}"?`, danger: true, confirmLabel: "Delete" })) return;
    setDeleting(true);
    await fetch(`/api/candidates/${candidateId}/files/${file.id}`, { method: "DELETE" });
    onDeleted(file.id);
  };

  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded border border-separator bg-surface-sunken group hover:bg-surface-hover transition-colors">
      <Badge className={typeBadgeClass(file.type)}>{typeLabel(file.type)}</Badge>
      <div className="flex-1 min-w-0">
        <p className="text-base font-medium text-text-primary truncate">{file.filename}</p>
        <p className="text-xs text-text-tertiary">
          <span className="data-mono">{formatBytes(file.size)}</span>
          <span className="mx-1">·</span>
          <span suppressHydrationWarning>{timeAgo(new Date(file.createdAt))}</span>
        </p>
      </div>
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <a
          href={`/api/candidates/${candidateId}/files/${file.id}`}
          download={file.filename}
          className="h-7 w-7 rounded flex items-center justify-center text-text-secondary hover:text-accent hover:bg-surface-hover transition-colors"
          title="Download"
        >
          <Download className="w-3.5 h-3.5" />
        </a>
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="h-7 w-7 rounded flex items-center justify-center text-text-secondary hover:text-danger hover:bg-surface-hover transition-colors disabled:opacity-50"
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
          className="h-7 px-2 rounded bg-surface-sunken border border-separator text-base text-text-primary focus:outline-none focus:border-accent focus:shadow-focus transition-all"
        >
          <option value="cv">CV / Resume</option>
          <option value="cover_letter">Cover Letter</option>
          <option value="other">Other</option>
        </select>
        <label
          className={cn(
            "inline-flex items-center gap-1.5 h-7 px-3 rounded text-md font-medium cursor-pointer transition-colors",
            uploading
              ? "bg-surface-hover text-text-tertiary cursor-not-allowed"
              : "bg-accent hover:bg-accent-hover text-white"
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
      <p className="text-xs text-text-tertiary">PDF, Word, or plain text · max 10 MB</p>
      {error && <p className="text-xs text-danger flex items-center gap-1"><X className="w-3 h-3" /> {error}</p>}
      {notice && <p className="text-xs text-text-secondary">{notice}</p>}
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
        <Loader2 className="w-5 h-5 animate-spin text-text-tertiary" />
      </div>
    );
  }

  if (notFound || !candidate) {
    return (
      <div className="p-8 text-center text-text-secondary text-base">
        Candidate not found.{" "}
        <Link href="/candidates" className="text-accent hover:text-accent-hover">Back to library</Link>
      </div>
    );
  }

  const { skills, rest } = parseSkills(candidate.headline);
  const initials = candidate.name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  const score = candidate.matchScore;
  const tier = score !== null ? scoreTier(score) : null;
  const allJobs = [
    ...(candidate.job ? [{ id: candidate.job.id, title: candidate.job.title, company: candidate.job.company, matchScore: candidate.matchScore, status: candidate.status }] : []),
    ...candidate.otherJobs,
  ];

  return (
    <div className="min-h-screen bg-surface-base">
      {/* Toolbar */}
      <div className="toolbar">
        <Link
          href="/candidates"
          className="inline-flex items-center gap-1.5 h-7 px-2 rounded text-md text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Candidates
        </Link>
        <span className="text-text-tertiary">/</span>
        <span className="text-md text-text-primary font-medium truncate">{candidate.name}</span>
        <Badge className="ml-1 bg-surface-hover text-text-secondary capitalize">
          {candidate.status.replace(/_/g, " ")}
        </Badge>
        <div className="ml-auto flex items-center gap-1.5">
          {displayableLinkedinUrl(candidate.linkedinUrl) && (
            <a
              href={displayableLinkedinUrl(candidate.linkedinUrl)!}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 h-7 px-3 rounded bg-surface-hover hover:bg-surface-overlay text-text-primary text-md border border-separator transition-colors"
            >
              <LinkedInIcon className="w-3.5 h-3.5" />
              LinkedIn
            </a>
          )}
        </div>
      </div>

      {/* Body — two columns */}
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-5">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

          {/* LEFT — candidate header, score, profile, notes */}
          <div className="lg:col-span-2 space-y-4">

            {/* Header card: avatar + name + meta + score */}
            <Card>
              <CardBody>
                <div className="flex items-start gap-4">
                  {/* Avatar */}
                  <div className="w-14 h-14 rounded-md bg-surface-hover border border-separator flex items-center justify-center text-text-primary text-lg font-semibold flex-shrink-0">
                    {initials}
                  </div>
                  {/* Identity */}
                  <div className="flex-1 min-w-0">
                    <h1 className="text-xl font-semibold text-text-primary truncate">{candidate.name}</h1>
                    {rest && <p className="text-base text-text-secondary mt-0.5">{rest}</p>}
                    {skills.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {skills.slice(0, 8).map((skill) => (
                          <Badge key={skill} className="bg-surface-hover text-text-secondary">
                            {skill}
                          </Badge>
                        ))}
                      </div>
                    )}
                    <div className="flex flex-wrap items-center gap-3 mt-2.5 text-xs text-text-tertiary">
                      {candidate.location && (
                        <span className="flex items-center gap-1">
                          <MapPin className="w-3.5 h-3.5" />
                          {candidate.location}
                        </span>
                      )}
                      <span suppressHydrationWarning>
                        {candidate.profileCapturedAt
                          ? `Captured ${timeAgo(new Date(candidate.profileCapturedAt))}`
                          : `Added ${timeAgo(new Date(candidate.createdAt))}`}
                      </span>
                    </div>
                  </div>
                </div>
              </CardBody>
            </Card>

            {/* Score breakdown */}
            {tier && score !== null && (
              <Card>
                <CardHeader className="flex items-center justify-between">
                  <h2 className="text-md font-semibold text-text-primary">Match score</h2>
                  <Badge className={cn("bg-surface-hover", tier.text)}>{tier.label}</Badge>
                </CardHeader>
                <CardBody>
                  <div className="flex items-center gap-4">
                    <div className="flex items-baseline gap-1">
                      <span className={cn("text-2xl data-mono font-semibold", tier.text)}>{score}</span>
                      <span className="text-md text-text-tertiary data-mono">%</span>
                    </div>
                    <div className="flex-1">
                      <div className="h-1 bg-separator rounded-full overflow-hidden">
                        <div
                          className={cn("h-full rounded-full transition-all", tier.fill)}
                          style={{ width: `${Math.max(2, Math.min(100, score))}%` }}
                        />
                      </div>
                      <p className="text-xs text-text-tertiary mt-1.5">Overall fit against current job</p>
                    </div>
                  </div>
                </CardBody>
              </Card>
            )}

            {/* LinkedIn profile text */}
            {candidate.profileText && (
              <Card>
                <CardHeader className="flex items-center justify-between">
                  <h2 className="text-md font-semibold text-text-primary">LinkedIn profile</h2>
                  <button
                    onClick={() => setProfileExpanded((v) => !v)}
                    className="inline-flex items-center gap-1 h-6 px-2 rounded text-xs text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
                  >
                    {profileExpanded ? (
                      <><ChevronUp className="w-3.5 h-3.5" />Collapse</>
                    ) : (
                      <><ChevronDown className="w-3.5 h-3.5" />Expand</>
                    )}
                  </button>
                </CardHeader>
                <div className="relative px-4 py-3">
                  <div
                    className={cn(
                      "text-base text-text-secondary whitespace-pre-wrap leading-relaxed overflow-hidden transition-all duration-300",
                      profileExpanded ? "max-h-[2000px]" : "max-h-44"
                    )}
                  >
                    {candidate.profileText}
                  </div>
                  {!profileExpanded && (
                    <div className="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-surface-raised to-transparent pointer-events-none" />
                  )}
                </div>
                {!profileExpanded && (
                  <div className="px-4 pb-3">
                    <button
                      onClick={() => setProfileExpanded(true)}
                      className="text-xs text-accent hover:text-accent-hover font-medium"
                    >
                      Show full profile
                    </button>
                  </div>
                )}
              </Card>
            )}

            {/* Notes */}
            <Card>
              <CardHeader className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <StickyNote className="w-3.5 h-3.5 text-text-tertiary" />
                  <h2 className="text-md font-semibold text-text-primary">Notes</h2>
                </div>
                {notesStatus !== "idle" && (
                  <span className={cn(
                    "text-xs flex items-center gap-1",
                    notesStatus === "saved" ? "text-success" : "text-text-tertiary"
                  )}>
                    {notesStatus === "saving" ? (
                      <><Loader2 className="w-3 h-3 animate-spin" />Saving…</>
                    ) : (
                      <><Check className="w-3 h-3" />Saved</>
                    )}
                  </span>
                )}
              </CardHeader>
              <CardBody>
                <textarea
                  value={notes}
                  onChange={(e) => { setNotes(e.target.value); setNotesStatus("idle"); }}
                  onBlur={saveNotes}
                  rows={5}
                  placeholder="Add notes about this candidate…"
                  className="w-full text-base text-text-primary bg-surface-sunken border border-separator rounded px-3 py-2 placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:shadow-focus resize-none transition-all"
                />
              </CardBody>
            </Card>
          </div>

          {/* RIGHT — activity log: docs + jobs */}
          <div className="space-y-4">

            {/* Documents */}
            <Card>
              <CardHeader className="flex items-center gap-2">
                <FileText className="w-3.5 h-3.5 text-text-tertiary" />
                <h2 className="text-md font-semibold text-text-primary">Documents</h2>
                {candidate.files.length > 0 && (
                  <Badge className="ml-auto data-mono">{candidate.files.length}</Badge>
                )}
              </CardHeader>
              <CardBody className="p-3 space-y-1.5">
                {candidate.files.length === 0 && (
                  <p className="text-xs text-text-tertiary text-center py-2">No files yet</p>
                )}
                {candidate.files.map((f) => (
                  <FileRow
                    key={f.id}
                    file={f}
                    candidateId={candidate.id}
                    onDeleted={handleFileDeleted}
                  />
                ))}
                <div className="pt-2">
                  <UploadZone candidateId={candidate.id} onUploaded={handleFileUploaded} />
                </div>
              </CardBody>
            </Card>

            {/* Jobs */}
            <Card>
              <CardHeader className="flex items-center gap-2">
                <Briefcase className="w-3.5 h-3.5 text-text-tertiary" />
                <h2 className="text-md font-semibold text-text-primary">Jobs</h2>
                {allJobs.length > 0 && (
                  <Badge className="ml-auto data-mono">{allJobs.length}</Badge>
                )}
              </CardHeader>
              <CardBody className="p-2 space-y-0.5">
                {allJobs.length === 0 && (
                  <p className="text-xs text-text-tertiary text-center py-2">No jobs linked</p>
                )}
                {allJobs.map((job) => {
                  const jobTier = job.matchScore !== null ? scoreTier(job.matchScore) : null;
                  return (
                    <Link
                      key={job.id}
                      href={`/jobs/${job.id}`}
                      className="flex items-center gap-2 px-3 py-2 rounded hover:bg-surface-hover transition-colors group"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-base font-medium text-text-primary group-hover:text-accent line-clamp-1 transition-colors">
                          {job.title}
                        </p>
                        {job.company && (
                          <p className="text-xs text-text-tertiary line-clamp-1">{job.company}</p>
                        )}
                      </div>
                      {job.matchScore !== null && jobTier && (
                        <span className={cn("text-xs font-medium data-mono flex-shrink-0", jobTier.text)}>
                          {job.matchScore}%
                        </span>
                      )}
                    </Link>
                  );
                })}
              </CardBody>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
