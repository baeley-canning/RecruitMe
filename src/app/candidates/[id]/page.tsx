"use client";

import { use, useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  FileText,
  Upload,
  Trash2,
  Download,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Briefcase,
  Loader2,
  Check,
  X,
  StickyNote,
  AlertTriangle,
  Phone,
  Globe,
  DollarSign,
  Clock,
  CalendarCheck,
  Shield,
  Heart,
} from "lucide-react";
import { cn, timeAgo, safeParseJson } from "@/lib/utils";
import { formatBytes } from "@/lib/format";
import { scoreTier as canonicalScoreTier, type ScoreTier } from "@/lib/score-utils";
import { displayableLinkedinUrl } from "@/components/candidate/helpers";
import { CandidateIdentityBlock } from "@/components/candidate/identity-block";
import { CVPreview } from "@/components/candidate/cv-preview";
import { getCandidatePhotoUrl } from "@/lib/candidate-photo";
import { LinkedInIcon } from "@/components/candidate/icons";
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

interface ScreeningData {
  availability?: string;
  salaryExpectation?: string;
  visaStatus?: string;
  noticePeriod?: string;
  motivations?: string;
  notes?: string;
  screenedAt?: string;
}

interface CandidateDetail {
  id: string;
  name: string;
  headline: string | null;
  location: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  jobAdderUrl: string | null;
  profileText: string | null;
  matchScore: number | null;
  notes: string | null;
  screeningData: string | null;
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

const TIER_STYLE: Record<ScoreTier, { text: string; fill: string; label: string }> = {
  strong: { text: "text-success",       fill: "bg-success",       label: "Strong match" },
  fair:   { text: "text-accent",        fill: "bg-accent",        label: "Good match" },
  weak:   { text: "text-warning",       fill: "bg-warning",       label: "Moderate match" },
  poor:   { text: "text-text-tertiary", fill: "bg-text-tertiary", label: "Weak match" },
};

function scoreTier(score: number) {
  return TIER_STYLE[canonicalScoreTier(score, "match")];
}

const SOURCE_LABEL: Record<string, string> = {
  manual: "Added manually",
  serpapi: "LinkedIn search",
  pdl: "PDL",
  extension: "LinkedIn extension",
  talent_pool: "Talent pool",
  jobadder_import: "JobAdder import",
};

const STATUS_LABEL: Record<string, string> = {
  new: "New",
  reviewing: "Reviewing",
  shortlisted: "Shortlisted",
  contacted: "Contacted",
  interviewing: "Interviewing",
  offer_sent: "Offer sent",
  hired: "Hired",
  declined: "Declined",
  rejected: "Rejected",
};

const STATUS_COLOR: Record<string, string> = {
  new:          "bg-surface-hover text-text-secondary",
  reviewing:    "bg-surface-hover text-text-secondary",
  shortlisted:  "bg-accent-subtle text-accent",
  contacted:    "bg-warning-subtle text-warning",
  interviewing: "bg-warning-subtle text-warning",
  offer_sent:   "bg-warning-subtle text-warning",
  hired:        "bg-success-subtle text-success",
  declined:     "bg-surface-hover text-text-tertiary",
  rejected:     "bg-surface-hover text-text-tertiary",
};

function typeLabel(type: string) {
  if (type === "cv") return "CV / Resume";
  if (type === "cover_letter") return "Cover Letter";
  return "Other";
}

function typeBadgeClass(type: string) {
  if (type === "cv") return "bg-accent-subtle text-accent";
  if (type === "cover_letter") return "bg-warning-subtle text-warning";
  return "bg-surface-hover text-text-secondary";
}

// Extract skills and employer from headline.
// Format: "Title at Company" or "Title | Skill | Skill" or plain headline.
function parseHeadline(headline: string | null): {
  title: string | null;
  employer: string | null;
  skills: string[];
  rest: string;
} {
  if (!headline) return { title: null, employer: null, skills: [], rest: "" };

  // Pipe-separated skills
  const pipeParts = headline.split("|").map((s) => s.trim()).filter(Boolean);
  if (pipeParts.length > 1) {
    return { title: pipeParts[0] ?? null, employer: null, skills: pipeParts.slice(1), rest: "" };
  }

  // "Title at Employer" pattern — stop at pipe, paren, dash, or em-dash so
  // complex headlines like "Engineer at Acme Corp | 10 yrs" don't bleed
  // "| 10 yrs" into the employer field.
  const atMatch = headline.match(/^(.+?)\s+at\s+([^|(–—]+)/i);
  if (atMatch) {
    const employer = atMatch[2]?.trim() ?? null;
    if (employer) {
      return { title: atMatch[1]?.trim() ?? null, employer, skills: [], rest: "" };
    }
  }

  return { title: null, employer: null, skills: [], rest: headline };
}

function LinkedInBadge({ url }: { url: string | null }) {
  const display = displayableLinkedinUrl(url);
  if (!display) return null;
  return (
    <a
      href={display}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 text-xs text-text-secondary hover:text-accent transition-colors"
    >
      <LinkedInIcon className="w-3.5 h-3.5" />
      View LinkedIn
    </a>
  );
}

function FileRow({
  file,
  candidateId,
  onDeleted,
  defaultExpanded = false,
}: {
  file: CandidateFile;
  candidateId: string;
  onDeleted: (id: string) => void;
  /** Default-open the inline preview. Set true for the primary CV so
   *  recruiters see the resume immediately, matching the JobAdder UX. */
  defaultExpanded?: boolean;
}) {
  const [deleting, setDeleting] = useState(false);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const previewable = file.mimeType === "application/pdf";

  const handleDelete = async () => {
    if (!await confirm({ message: `Delete "${file.filename}"?`, danger: true, confirmLabel: "Delete" })) return;
    setDeleting(true);
    await fetch(`/api/candidates/${candidateId}/files/${file.id}`, { method: "DELETE" });
    onDeleted(file.id);
  };

  return (
    <div>
      <div className="flex items-center gap-2 px-3 py-2 rounded border border-separator bg-surface-sunken group hover:bg-surface-hover transition-colors">
        {previewable ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="p-0.5 -ml-0.5 text-text-tertiary hover:text-text-secondary rounded transition-colors flex-shrink-0"
            title={expanded ? "Hide preview" : "Show preview"}
            aria-expanded={expanded}
          >
            {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>
        ) : (
          <span className="w-3.5 h-3.5 flex-shrink-0" aria-hidden />
        )}
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
      {expanded && previewable && (
        <CVPreview candidateId={candidateId} file={file} height={640} className="mt-2" />
      )}
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
            setNotice(
              data.scored
                ? "CV uploaded and scored against this candidate's job."
                : "CV saved. To score it, open the candidate from a job page where the JD has been parsed.",
            );
          }
        }
      } catch {
        setError("Upload failed — please try again");
      } finally {
        setUploading(false);
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    [candidateId, type, onUploaded],
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
              : "bg-accent hover:bg-accent-hover text-white",
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

// A single labelled detail row — icon + label + value
function DetailRow({
  icon: Icon,
  label,
  value,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value?: string | null;
  children?: React.ReactNode;
}) {
  if (!value && !children) return null;
  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-separator last:border-0">
      <div className="flex items-center gap-1.5 w-36 flex-shrink-0 text-xs text-text-tertiary mt-0.5">
        <Icon className="w-3.5 h-3.5 flex-shrink-0" />
        <span>{label}</span>
      </div>
      <div className="flex-1 min-w-0 text-sm text-text-primary">
        {children ?? value}
      </div>
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

  const { title, employer, skills, rest } = parseHeadline(candidate.headline);
  const screening = safeParseJson<ScreeningData>(candidate.screeningData, {});
  // Only show the "Profile details" card if there's at least one concrete field to display.
  const hasProfileDetails = !!(
    employer || title || candidate.phone ||
    displayableLinkedinUrl(candidate.linkedinUrl) ||
    candidate.jobAdderUrl ||
    (!employer && !title && candidate.headline)
  );
  const score = candidate.matchScore;
  const tier = score !== null ? scoreTier(score) : null;
  const allJobs = [
    ...(candidate.job
      ? [{ id: candidate.job.id, title: candidate.job.title, company: candidate.job.company, matchScore: candidate.matchScore, status: candidate.status }]
      : []),
    ...candidate.otherJobs,
  ];
  const hasCV = candidate.files.some((f) => f.type === "cv");
  const hasScreeningData = !!(
    screening.availability ||
    screening.salaryExpectation ||
    screening.visaStatus ||
    screening.noticePeriod ||
    screening.motivations ||
    screening.notes
  );

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
        <Badge className={cn("ml-1 capitalize", STATUS_COLOR[candidate.status] ?? "bg-surface-hover text-text-secondary")}>
          {STATUS_LABEL[candidate.status] ?? candidate.status.replace(/_/g, " ")}
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
          {candidate.jobAdderUrl && (
            <a
              href={candidate.jobAdderUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 h-7 px-3 rounded bg-accent-subtle hover:bg-accent/25 text-accent text-md border border-separator transition-colors"
              title="Open this candidate's JobAdder record"
            >
              <Globe className="w-3.5 h-3.5" />
              JobAdder
            </a>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-5">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

          {/* LEFT — identity, profile details, screening, profile text, notes */}
          <div className="lg:col-span-2 space-y-4">

            {/* ── Header card ─────────────────────────────────────────────── */}
            <Card>
              <CardBody>
                <div className="flex items-start gap-4">
                  <CandidateIdentityBlock
                    name={candidate.name}
                    headline={rest || title || candidate.headline}
                    location={candidate.location}
                    phone={candidate.phone}
                    linkedinUrl={candidate.linkedinUrl}
                    photoUrl={getCandidatePhotoUrl({ linkedinUrl: candidate.linkedinUrl })}
                    score={score}
                    size="lg"
                    showScore={score !== null}
                    showPhone={!!candidate.phone}
                    showLinkedIn={false}
                    className="flex-1"
                  />
                </div>

                {/* Skills tags (from pipe-separated headline) */}
                {skills.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-3 pt-3 border-t border-separator">
                    {skills.map((skill) => (
                      <Badge key={skill} className="bg-surface-hover text-text-secondary">
                        {skill}
                      </Badge>
                    ))}
                  </div>
                )}
              </CardBody>
            </Card>

            {/* ── Empty-state warning ─────────────────────────────────────── */}
            {!candidate.profileText?.trim() && candidate.files.length === 0 && (
              <Card>
                <CardBody>
                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-md bg-warning-subtle flex items-center justify-center flex-shrink-0">
                      <AlertTriangle className="w-4 h-4 text-warning" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h2 className="text-md font-semibold text-text-primary">No CV or profile text yet</h2>
                      <p className="text-base text-text-secondary mt-1 leading-relaxed">
                        Two options:
                      </p>
                      <ul className="mt-2 space-y-1 text-base text-text-secondary leading-relaxed">
                        <li className="flex items-start gap-2">
                          <span className="text-warning font-semibold flex-shrink-0">(a)</span>
                          <span>upload a CV file in Documents below, or</span>
                        </li>
                        <li className="flex items-start gap-2">
                          <span className="text-warning font-semibold flex-shrink-0">(b)</span>
                          <span>open the candidate from a job page and use &ldquo;Fetch Profile&rdquo; or paste profile text.</span>
                        </li>
                      </ul>
                    </div>
                  </div>
                </CardBody>
              </Card>
            )}

            {/* ── Profile details ─────────────────────────────────────────── */}
            {hasProfileDetails && <Card>
              <CardHeader>
                <h2 className="text-md font-semibold text-text-primary">Profile details</h2>
              </CardHeader>
              <CardBody className="py-0">
                {employer && (
                  <DetailRow icon={Briefcase} label="Current employer" value={employer} />
                )}
                {title && (
                  <DetailRow icon={Briefcase} label="Current title" value={title} />
                )}
                {candidate.phone && (
                  <DetailRow icon={Phone} label="Phone">
                    <a href={`tel:${candidate.phone}`} className="text-accent hover:text-accent-hover transition-colors">
                      {candidate.phone}
                    </a>
                  </DetailRow>
                )}
                {displayableLinkedinUrl(candidate.linkedinUrl) && (
                  <DetailRow icon={Globe} label="LinkedIn">
                    <LinkedInBadge url={candidate.linkedinUrl} />
                  </DetailRow>
                )}
                {candidate.jobAdderUrl && (
                  <DetailRow icon={Globe} label="JobAdder">
                    <a
                      href={candidate.jobAdderUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-accent hover:text-accent-hover transition-colors"
                    >
                      Open in JobAdder
                    </a>
                  </DetailRow>
                )}
                {/* Fallback if no structured fields parsed but headline exists */}
                {!employer && !title && candidate.headline && (
                  <DetailRow icon={Briefcase} label="Headline" value={candidate.headline} />
                )}
              </CardBody>
            </Card>}

            {/* ── Screening data ──────────────────────────────────────────── */}
            {hasScreeningData && (
              <Card>
                <CardHeader>
                  <h2 className="text-md font-semibold text-text-primary">Screening notes</h2>
                  {screening.screenedAt && (
                    <span className="ml-auto text-xs text-text-tertiary" suppressHydrationWarning>
                      Screened {timeAgo(new Date(screening.screenedAt))}
                    </span>
                  )}
                </CardHeader>
                <CardBody className="py-0">
                  {screening.salaryExpectation && (
                    <DetailRow icon={DollarSign} label="Salary expectation" value={screening.salaryExpectation} />
                  )}
                  {screening.availability && (
                    <DetailRow icon={CalendarCheck} label="Availability" value={screening.availability} />
                  )}
                  {screening.noticePeriod && (
                    <DetailRow icon={Clock} label="Notice period" value={screening.noticePeriod} />
                  )}
                  {screening.visaStatus && (
                    <DetailRow icon={Shield} label="Visa / work rights" value={screening.visaStatus} />
                  )}
                  {screening.motivations && (
                    <DetailRow icon={Heart} label="Motivations" value={screening.motivations} />
                  )}
                  {screening.notes && (
                    <DetailRow icon={StickyNote} label="Screening notes" value={screening.notes} />
                  )}
                </CardBody>
              </Card>
            )}

            {/* ── Match score ─────────────────────────────────────────────── */}
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
                      <p className="text-xs text-text-tertiary mt-1.5">
                        {allJobs.length > 0
                          ? `Score against "${allJobs[0]?.title ?? "current role"}"`
                          : "Overall fit against current job"}
                      </p>
                    </div>
                  </div>
                </CardBody>
              </Card>
            )}

            {/* ── LinkedIn profile text ───────────────────────────────────── */}
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
                      profileExpanded ? "max-h-[2000px]" : "max-h-44",
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

            {/* ── Notes ──────────────────────────────────────────────────── */}
            <Card>
              <CardHeader className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <StickyNote className="w-3.5 h-3.5 text-text-tertiary" />
                  <h2 className="text-md font-semibold text-text-primary">Notes</h2>
                </div>
                {notesStatus !== "idle" && (
                  <span
                    className={cn(
                      "text-xs flex items-center gap-1",
                      notesStatus === "saved" ? "text-success" : "text-text-tertiary",
                    )}
                  >
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
                  rows={4}
                  placeholder="Add notes about this candidate…"
                  className="w-full text-base text-text-primary bg-surface-sunken border border-separator rounded px-3 py-2 placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:shadow-focus resize-none transition-all"
                />
              </CardBody>
            </Card>
          </div>

          {/* RIGHT — contact/meta, documents, jobs */}
          <div className="space-y-4">

            {/* ── Contact & meta ──────────────────────────────────────────── */}
            <Card>
              <CardHeader>
                <h2 className="text-md font-semibold text-text-primary">Details</h2>
              </CardHeader>
              <CardBody className="space-y-2.5">
                {candidate.phone && (
                  <div className="flex items-center gap-2">
                    <Phone className="w-3.5 h-3.5 text-text-tertiary flex-shrink-0" />
                    <a href={`tel:${candidate.phone}`} className="text-sm text-accent hover:text-accent-hover transition-colors">
                      {candidate.phone}
                    </a>
                  </div>
                )}
                {displayableLinkedinUrl(candidate.linkedinUrl) && (
                  <div className="flex items-center gap-2">
                    <LinkedInIcon className="w-3.5 h-3.5 text-text-tertiary flex-shrink-0" />
                    <a
                      href={displayableLinkedinUrl(candidate.linkedinUrl)!}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-accent hover:text-accent-hover truncate transition-colors"
                    >
                      LinkedIn profile
                    </a>
                  </div>
                )}
                <div className="pt-1 border-t border-separator space-y-1.5 text-xs text-text-tertiary">
                  <div className="flex justify-between">
                    <span>Source</span>
                    <span className="text-text-secondary">{SOURCE_LABEL[candidate.source] ?? candidate.source}</span>
                  </div>
                  {candidate.profileCapturedAt && (
                    <div className="flex justify-between">
                      <span>Captured</span>
                      <span className="text-text-secondary" suppressHydrationWarning>
                        {timeAgo(new Date(candidate.profileCapturedAt))}
                      </span>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <span>Added</span>
                    <span className="text-text-secondary" suppressHydrationWarning>
                      {timeAgo(new Date(candidate.createdAt))}
                    </span>
                  </div>
                  {hasCV && (
                    <div className="flex justify-between">
                      <span>CV</span>
                      <span className="text-success">Uploaded</span>
                    </div>
                  )}
                </div>
              </CardBody>
            </Card>

            {/* ── Documents ───────────────────────────────────────────────── */}
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
                    // First CV (newest, list comes back ordered desc) is the
                    // candidate's primary resume — default-open the preview
                    // so the JobAdder-like "see the CV immediately" UX works.
                    defaultExpanded={f.id === candidate.files.find((x) => x.type === "cv")?.id}
                  />
                ))}
                <div className="pt-2">
                  <UploadZone candidateId={candidate.id} onUploaded={handleFileUploaded} />
                </div>
              </CardBody>
            </Card>

            {/* ── Jobs ────────────────────────────────────────────────────── */}
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
                        <Badge
                          className={cn(
                            "mt-1 capitalize text-2xs",
                            STATUS_COLOR[job.status] ?? "bg-surface-hover text-text-secondary",
                          )}
                        >
                          {STATUS_LABEL[job.status] ?? job.status.replace(/_/g, " ")}
                        </Badge>
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
