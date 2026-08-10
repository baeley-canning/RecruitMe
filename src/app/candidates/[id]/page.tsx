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
  X,
  AlertTriangle,
  Phone,
  Camera,
  ExternalLink,
} from "lucide-react";
import { showToast } from "@/components/ui/toast";
import { cn, timeAgo, safeParseJson } from "@/lib/utils";
import { formatBytes } from "@/lib/format";
import { scoreTier as canonicalScoreTier, type ScoreTier } from "@/lib/score-utils";
import { displayableLinkedinUrl } from "@/components/candidate/helpers";
import { EditableField } from "@/components/candidate/editable-field";
import { CandidateIdentityBlock } from "@/components/candidate/identity-block";
import { IdentityMergePanel } from "@/components/candidate/identity-merge-panel";
import { ScreeningSummary } from "@/components/candidate/screening-summary";
import { CVPreview } from "@/components/candidate/cv-preview";
import { getCandidatePhotoUrl } from "@/lib/candidate-photo";
import { LinkedInIcon, JobAdderIcon, SeekIcon } from "@/components/candidate/icons";
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
  email: string | null;
  linkedinUrl: string | null;
  jobAdderUrl: string | null;
  seekUrl: string | null;
  photoFileId: string | null;
  profileText: string | null;
  matchScore: number | null;
  notes: string | null;
  screeningData: string | null;
  suitability: "preferred" | "excluded" | null;
  source: string;
  status: string;
  profileCapturedAt: string | null;
  createdAt: string;
  job: { id: string; title: string; company: string | null } | null;
  archivedJobTitle: string | null;
  archivedJobCompany: string | null;
  files: CandidateFile[];
  otherJobs: OtherJob[];
  /** JSON: {date,interviewer,format,impression,technical,culture,recommendation,updatedAt} */
  interviewNotes: string | null;
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
  seek_import: "SEEK import",
  seek: "SEEK",
  scraper: "Scraper import",
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

/** Number of table columns — kept as a constant so the expanded preview
 *  row's colSpan stays in sync with the header. Columns: Type, Name, Size,
 *  Uploaded, Actions. */
const FILE_TABLE_COLS = 5;

type FileSortKey = "name" | "size" | "createdAt";
type SortDir = "asc" | "desc";

function FileTableRow({
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
    <>
      <tr className="border-b border-separator last:border-0 hover:bg-surface-hover/40 transition-colors">
        {/* Type column — holds chevron + type badge */}
        <td className="py-2 px-3 align-middle">
          <div className="flex items-center gap-1.5">
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
          </div>
        </td>
        {/* Document name */}
        <td className="py-2 px-3 align-middle min-w-0">
          <p className="text-base font-medium text-text-primary truncate" title={file.filename}>
            {file.filename}
          </p>
        </td>
        {/* File size */}
        <td className="py-2 px-3 align-middle text-xs text-text-secondary data-mono whitespace-nowrap">
          {formatBytes(file.size)}
        </td>
        {/* Uploaded (relative time) */}
        <td className="py-2 px-3 align-middle text-xs text-text-tertiary whitespace-nowrap">
          <span suppressHydrationWarning>{timeAgo(new Date(file.createdAt))}</span>
        </td>
        {/* Actions (no header) */}
        <td className="py-2 px-3 align-middle whitespace-nowrap text-right">
          <div className="inline-flex items-center gap-1">
            {previewable && (
              <a
                href={`/api/candidates/${candidateId}/files/${file.id}?inline=1`}
                target="_blank"
                rel="noopener noreferrer"
                className="h-7 w-7 rounded inline-flex items-center justify-center text-text-secondary hover:text-accent hover:bg-surface-hover transition-colors"
                title="Open in new tab"
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            )}
            <a
              href={`/api/candidates/${candidateId}/files/${file.id}`}
              download={file.filename}
              className="h-7 w-7 rounded inline-flex items-center justify-center text-text-secondary hover:text-accent hover:bg-surface-hover transition-colors"
              title="Download"
            >
              <Download className="w-3.5 h-3.5" />
            </a>
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="h-7 w-7 rounded inline-flex items-center justify-center text-text-secondary hover:text-danger hover:bg-surface-hover transition-colors disabled:opacity-50"
              title="Delete"
            >
              {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            </button>
          </div>
        </td>
      </tr>
      {expanded && previewable && (
        <tr className="border-b border-separator last:border-0">
          <td colSpan={FILE_TABLE_COLS} className="p-2 bg-surface-sunken">
            <CVPreview candidateId={candidateId} file={file} height={640} />
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * JobAdder-style sortable file table. Default sort is createdAt desc so the
 * newest upload is on top — matching the previous list ordering and keeping
 * the "primary CV" (used for auto-expand) at row 0.
 *
 * Type column is intentionally not sortable: with 1-6 files the grouping
 * adds no value and would just be one more thing for the recruiter to click.
 */
function FilesTable({
  files,
  candidateId,
  onDeleted,
}: {
  files: CandidateFile[];
  candidateId: string;
  onDeleted: (id: string) => void;
}) {
  const [sortKey, setSortKey] = useState<FileSortKey>("createdAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const toggleSort = (key: FileSortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      // Sensible defaults: name asc, size desc (biggest first), date desc (newest first)
      setSortDir(key === "name" ? "asc" : "desc");
    }
  };

  // Identify the primary CV BEFORE sorting so the auto-expand flag is stable
  // across re-sorts — i.e. the newest CV stays the default-expanded one even
  // if the recruiter sorts by name.
  const primaryCvId = files.find((f) => f.type === "cv")?.id;

  const sorted = [...files].sort((a, b) => {
    let cmp = 0;
    if (sortKey === "name") {
      cmp = a.filename.localeCompare(b.filename, undefined, { sensitivity: "base" });
    } else if (sortKey === "size") {
      cmp = a.size - b.size;
    } else {
      cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    }
    return sortDir === "asc" ? cmp : -cmp;
  });

  const sortIndicator = (key: FileSortKey) =>
    sortKey === key ? (sortDir === "asc" ? " ▲" : " ▼") : "";

  const headerBase =
    "py-2 px-3 text-left text-2xs uppercase tracking-wide text-text-tertiary font-medium";
  const sortableHeader = cn(headerBase, "cursor-pointer hover:text-text-secondary select-none");

  return (
    <div className="overflow-x-auto rounded border border-separator">
      <table className="w-full border-separate border-spacing-0 text-sm">
        <thead className="bg-surface-hover">
          <tr>
            <th scope="col" className={headerBase}>Type</th>
            <th
              scope="col"
              className={sortableHeader}
              onClick={() => toggleSort("name")}
              aria-sort={sortKey === "name" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
            >
              Document Name{sortIndicator("name")}
            </th>
            <th
              scope="col"
              className={sortableHeader}
              onClick={() => toggleSort("size")}
              aria-sort={sortKey === "size" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
            >
              File Size{sortIndicator("size")}
            </th>
            <th
              scope="col"
              className={sortableHeader}
              onClick={() => toggleSort("createdAt")}
              aria-sort={sortKey === "createdAt" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
            >
              Uploaded{sortIndicator("createdAt")}
            </th>
            <th scope="col" className={cn(headerBase, "text-right")}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr>
              <td
                colSpan={FILE_TABLE_COLS}
                className="py-4 px-3 text-xs text-text-tertiary text-center"
              >
                No files yet
              </td>
            </tr>
          ) : (
            sorted.map((f) => (
              <FileTableRow
                key={f.id}
                file={f}
                candidateId={candidateId}
                onDeleted={onDeleted}
                // Newest CV is the primary resume — default-open its preview
                // so the JobAdder-like "see the CV immediately" UX works.
                defaultExpanded={f.id === primaryCvId}
              />
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Recruiter-facing affordance to upload / replace / remove a candidate's
 * headshot. The whole control is intentionally small — a single icon button
 * that opens the system file picker, mirroring how the in-app CV upload
 * works. The button is unconditionally visible to any logged-in user with
 * access to the candidate; the route does the org-scoped auth check.
 *
 * Visible label: "Upload photo" / "Change photo" — explicit verbs do better
 * than a camera glyph alone in usability testing.
 */
function PhotoUploadControl({
  candidateId,
  hasPhoto,
  onPhotoChanged,
}: {
  candidateId: string;
  hasPhoto: boolean;
  onPhotoChanged: (photoFileId: string | null) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      setUploading(true);
      try {
        const form = new FormData();
        form.append("file", files[0]);
        const res = await fetch(`/api/candidates/${candidateId}/photo`, { method: "POST", body: form });
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          showToast(json.error ?? "Photo upload failed", "error");
        } else {
          const data = await res.json() as { photoFileId: string };
          onPhotoChanged(data.photoFileId);
          showToast("Photo updated", "success");
        }
      } catch {
        showToast("Photo upload failed — please try again", "error");
      } finally {
        setUploading(false);
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    [candidateId, onPhotoChanged],
  );

  const handleRemove = useCallback(async () => {
    if (!await confirm({ message: "Remove this candidate's photo?", danger: true, confirmLabel: "Remove" })) return;
    setRemoving(true);
    try {
      const res = await fetch(`/api/candidates/${candidateId}/photo`, { method: "DELETE" });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        showToast(json.error ?? "Could not remove photo", "error");
      } else {
        onPhotoChanged(null);
        showToast("Photo removed", "success");
      }
    } catch {
      showToast("Could not remove photo", "error");
    } finally {
      setRemoving(false);
    }
  }, [candidateId, onPhotoChanged]);

  return (
    <div className="flex items-center gap-1.5 flex-shrink-0">
      <label
        className={cn(
          "inline-flex items-center gap-1.5 h-7 px-2.5 rounded text-xs font-medium cursor-pointer transition-colors border border-separator",
          uploading
            ? "bg-surface-hover text-text-tertiary cursor-not-allowed"
            : "bg-surface-hover hover:bg-surface-overlay text-text-secondary hover:text-text-primary",
        )}
        title={hasPhoto ? "Replace photo" : "Upload photo"}
      >
        {uploading ? (
          <><Loader2 className="w-3 h-3 animate-spin" /> Uploading…</>
        ) : (
          <><Camera className="w-3 h-3" /> {hasPhoto ? "Change photo" : "Upload photo"}</>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          disabled={uploading}
          onChange={(e) => handleFile(e.target.files)}
        />
      </label>
      {hasPhoto && (
        <button
          type="button"
          onClick={handleRemove}
          disabled={removing}
          className="inline-flex items-center justify-center h-7 w-7 rounded border border-separator text-text-secondary hover:text-danger hover:bg-surface-hover transition-colors disabled:opacity-50"
          title="Remove photo"
          aria-label="Remove photo"
        >
          {removing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
        </button>
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
              : "bg-accent hover:bg-accent-hover text-text-inverse",
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

/**
 * Three-state segmented control for Candidate.suitability. Click a button to
 * set; click an active button to clear back to neutral. Optimistic update via
 * the passed onChange.
 */
function SuitabilityControl({
  value,
  onChange,
}: {
  value: "preferred" | "excluded" | null;
  onChange: (next: "preferred" | "excluded" | null) => void;
}) {
  const buttonCls = (active: boolean, tone: "preferred" | "excluded") =>
    cn(
      "inline-flex items-center gap-1 px-2 py-1 rounded-sm text-xs font-medium border transition-colors",
      active
        ? tone === "preferred"
          ? "bg-success-subtle text-success border-success/30"
          : "bg-danger-subtle text-danger border-danger/30"
        : "bg-surface-raised text-text-tertiary border-separator hover:bg-surface-hover",
    );
  return (
    <div className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={() => onChange(value === "excluded" ? null : "excluded")}
        className={buttonCls(value === "excluded", "excluded")}
        title="Exclude this candidate from future search results"
      >
        Exclude
      </button>
      <button
        type="button"
        onClick={() => onChange(value === "preferred" ? null : "preferred")}
        className={buttonCls(value === "preferred", "preferred")}
        title="Mark as preferred — boosted in shortlist suggestions"
      >
        Prefer
      </button>
      {value === null && (
        <span className="text-2xs text-text-tertiary ml-1">neither</span>
      )}
    </div>
  );
}

/**
 * Variant of DetailRow that ALWAYS renders, showing an "Add X" / "Not set"
 * placeholder when the value/children are absent. JobAdder-style — recruiter
 * sees which fields exist even when empty. Used inside the 2-column Profile
 * Details grid below.
 */
function DetailField({
  label,
  value,
  children,
  emptyLabel = "Not set",
}: {
  label: string;
  value?: string | null;
  children?: React.ReactNode;
  emptyLabel?: string;
}) {
  const hasContent = Boolean(value || children);
  return (
    <div className="py-2 border-b border-separator last:border-0">
      <p className="text-2xs text-text-tertiary uppercase tracking-wide mb-1">{label}</p>
      <div className={cn("text-sm", hasContent ? "text-text-primary" : "text-text-tertiary italic")}>
        {hasContent ? (children ?? value) : emptyLabel}
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
  const [loadError, setLoadError] = useState(false);
  const [profileExpanded, setProfileExpanded] = useState(false);
  const [notes, setNotes] = useState("");
  const [notesStatus, setNotesStatus] = useState<"idle" | "saving" | "saved">("idle");

  const loadCandidate = useCallback(() => {
    setLoading(true); setLoadError(false); setNotFound(false);
    fetch(`/api/candidates/${id}`)
      .then((r) => {
        if (r.status === 404 || r.status === 403) { setNotFound(true); return null; }
        // A transient error (500 / dropped connection) is NOT "not found" — surface
        // it distinctly with a retry instead of the misleading "Candidate not found".
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (data) { setCandidate(data); setNotes(data.notes ?? ""); }
      })
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, [id]);
  useEffect(() => { loadCandidate(); }, [loadCandidate]);

  const saveNotes = useCallback(async () => {
    if (!candidate) return;
    setNotesStatus("saving");
    try {
      const res = await fetch(`/api/candidates/${candidate.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setNotesStatus("saved");
      setTimeout(() => setNotesStatus("idle"), 2000);
    } catch {
      // Never show "saved" on a failed PATCH — tell the user it didn't stick.
      setNotesStatus("idle");
      showToast("Couldn't save notes — try again.", "error");
    }
  }, [candidate, notes]);

  const handleFileUploaded = useCallback((file: CandidateFile) => {
    setCandidate((prev) => prev ? { ...prev, files: [file, ...prev.files] } : prev);
  }, []);

  const handleFileDeleted = useCallback((fileId: string) => {
    setCandidate((prev) => prev ? { ...prev, files: prev.files.filter((f) => f.id !== fileId) } : prev);
  }, []);

  const handlePhotoChanged = useCallback((photoFileId: string | null) => {
    setCandidate((prev) => prev ? { ...prev, photoFileId } : prev);
  }, []);

  const handleSuitabilityChange = useCallback(async (next: "preferred" | "excluded" | null) => {
    if (!candidate) return;
    const prevSuitability = candidate.suitability;
    // Optimistic update — flips the segmented control immediately.
    setCandidate((prev) => prev ? { ...prev, suitability: next } : prev);
    try {
      const res = await fetch(`/api/candidates/${candidate.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suitability: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      // Roll back the optimistic flip so the UI doesn't lie about a failed save.
      setCandidate((prev) => prev ? { ...prev, suitability: prevSuitability } : prev);
      showToast("Couldn't update suitability — try again.", "error");
    }
  }, [candidate]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-5 h-5 animate-spin text-text-tertiary" />
      </div>
    );
  }

  if (loadError && !candidate) {
    return (
      <div className="p-8 text-center text-text-secondary text-base">
        Couldn&apos;t load this candidate.{" "}
        <button onClick={loadCandidate} className="text-accent hover:text-accent-hover">Retry</button>
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
  const score = candidate.matchScore;
  const tier = score !== null ? scoreTier(score) : null;
  const allJobs = [
    ...(candidate.job
      ? [{ id: candidate.job.id, title: candidate.job.title, company: candidate.job.company, matchScore: candidate.matchScore, status: candidate.status }]
      : []),
    ...candidate.otherJobs,
  ];
  const hasCV = candidate.files.some((f) => f.type === "cv");

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
              className="inline-flex items-center gap-1.5 h-7 px-3 rounded bg-surface-hover hover:bg-surface-overlay text-text-primary text-md border border-separator transition-colors"
              title="Open this candidate's JobAdder record"
            >
              <JobAdderIcon className="w-3.5 h-3.5" />
              JobAdder
            </a>
          )}
          {candidate.seekUrl && /^https?:\/\//i.test(candidate.seekUrl) && (
            <a
              href={candidate.seekUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 h-7 px-3 rounded bg-surface-hover hover:bg-surface-overlay text-text-primary text-md border border-separator transition-colors"
              title="Open this candidate's SEEK profile"
            >
              <SeekIcon className="w-3.5 h-3.5" />
              SEEK
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
                    email={candidate.email}
                    linkedinUrl={candidate.linkedinUrl}
                    photoUrl={getCandidatePhotoUrl({ candidateId: candidate.id, photoFileId: candidate.photoFileId })}
                    score={score}
                    size="lg"
                    showScore={score !== null}
                    showPhone={!!candidate.phone}
                    showLinkedIn={false}
                    className="flex-1"
                  />
                  {/* Photo upload affordance — visible to any recruiter who
                      can edit this candidate. The dedicated /photo route
                      enforces the same org-scoped auth as the /files route. */}
                  <PhotoUploadControl
                    candidateId={candidate.id}
                    hasPhoto={Boolean(candidate.photoFileId)}
                    onPhotoChanged={handlePhotoChanged}
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

            {/* ── Identity & duplicates (merge-review; self-gates on the flag) ─ */}
            <IdentityMergePanel candidateId={candidate.id} />

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

            {/* ── Profile details (JobAdder-style 2-column field grid) ────── */}
            <Card>
              <CardHeader>
                <h2 className="text-md font-semibold text-text-primary">Profile details</h2>
              </CardHeader>
              <CardBody>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6">
                  {/* ─── Left column: contact + employment ───────────────── */}
                  <div>
                    <DetailField label="Current employer" value={employer} emptyLabel="Not extracted" />
                    <DetailField label="Current title" value={title} emptyLabel="Not extracted" />
                    <EditableField
                      candidateId={candidate.id} field="phone" value={candidate.phone}
                      label="Phone" emptyLabel="Not set" type="tel" placeholder="+64 21 123 4567"
                      renderValue={(v) => <a href={`tel:${v}`} className="text-accent hover:text-accent-hover transition-colors">{v}</a>}
                      onSaved={(v) => setCandidate((prev) => prev ? { ...prev, phone: v } : prev)}
                    />
                    <EditableField
                      candidateId={candidate.id} field="email" value={candidate.email}
                      label="Email" emptyLabel="Not set" type="email" placeholder="name@example.com"
                      renderValue={(v) => <a href={`mailto:${v}`} className="text-accent hover:text-accent-hover transition-colors break-all">{v}</a>}
                      onSaved={(v) => setCandidate((prev) => prev ? { ...prev, email: v } : prev)}
                    />
                    <EditableField
                      candidateId={candidate.id} field="location" value={candidate.location}
                      label="Location" emptyLabel="Not set" placeholder="Wellington, NZ"
                      onSaved={(v) => setCandidate((prev) => prev ? { ...prev, location: v } : prev)}
                    />
                    <DetailField label="Source" value={candidate.source.replace(/_/g, " ")} />
                  </div>

                  {/* ─── Right column: links + recruiter markers ─────────── */}
                  <div>
                    <EditableField
                      candidateId={candidate.id} field="linkedinUrl" value={candidate.linkedinUrl}
                      label="LinkedIn" emptyLabel="Not linked" type="url" placeholder="https://www.linkedin.com/in/…"
                      validate={(v) => /^https?:\/\//i.test(v) ? null : "Must start with http(s)://"}
                      renderValue={(v) => displayableLinkedinUrl(v)
                        ? <LinkedInBadge url={v} />
                        : <a href={v} target="_blank" rel="noopener noreferrer" className="text-accent hover:text-accent-hover transition-colors break-all">{v} ↗</a>}
                      onSaved={(v) => setCandidate((prev) => prev ? { ...prev, linkedinUrl: v } : prev)}
                    />
                    <EditableField
                      candidateId={candidate.id} field="jobAdderUrl" value={candidate.jobAdderUrl}
                      label="JobAdder" emptyLabel="Not linked" type="url" placeholder="https://…jobadder.com/candidate/…"
                      validate={(v) => /^https?:\/\//i.test(v) ? null : "Must start with http(s)://"}
                      renderValue={(v) => <a href={v} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-xs text-text-secondary hover:text-accent transition-colors"><JobAdderIcon className="w-3.5 h-3.5" />View JobAdder</a>}
                      onSaved={(v) => setCandidate((prev) => prev ? { ...prev, jobAdderUrl: v } : prev)}
                    />
                    <EditableField
                      candidateId={candidate.id} field="seekUrl" value={candidate.seekUrl}
                      label="SEEK" emptyLabel="Not linked" type="url" placeholder="https://…seek.com…/profile/…"
                      renderValue={(v) => /^https?:\/\//i.test(v)
                        ? <a href={v} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-xs text-text-secondary hover:text-accent transition-colors"><SeekIcon className="w-3.5 h-3.5" />View SEEK</a>
                        : <span className="break-all">{v}</span>}
                      onSaved={(v) => setCandidate((prev) => prev ? { ...prev, seekUrl: v } : prev)}
                    />
                    <DetailField label="Suitability">
                      <SuitabilityControl
                        value={candidate.suitability}
                        onChange={handleSuitabilityChange}
                      />
                    </DetailField>
                    {/* Match score against the candidate's current job (if any) — uses
                        the existing TIER_STYLE palette so colours stay consistent with
                        the score-bar visualisation below. Phase 1 #3 (tier-word badges
                        everywhere) lands the same treatment across pipeline cards. */}
                    <DetailField label="Match score" emptyLabel="No score yet">
                      {score !== null && tier ? (
                        <span className={cn("inline-flex items-center px-2 py-0.5 rounded-sm text-xs font-medium bg-surface-hover", tier.text)}>
                          {tier.label} · {score}%
                        </span>
                      ) : null}
                    </DetailField>
                    {/* Fallback if no structured employer/title but headline exists */}
                    {!employer && !title && candidate.headline && (
                      <DetailField label="Headline" value={candidate.headline} />
                    )}
                  </div>
                </div>
              </CardBody>
            </Card>

            {/* ── Screening summary (Phase E2) ──────────────────────────────
                Consolidates the old "Screening notes" card + the standalone
                "Notes" card + the previously-invisible interviewNotes JSON
                into one card with a 4-tile glance + expandable long-form rows. */}
            <ScreeningSummary
              screening={screening}
              interviewNotes={candidate.interviewNotes}
              notes={notes}
              setNotes={setNotes}
              onSaveNotes={saveNotes}
              notesStatus={notesStatus}
              setNotesStatus={setNotesStatus}
            />

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
              <CardBody className="p-3 space-y-3">
                <FilesTable
                  files={candidate.files}
                  candidateId={candidate.id}
                  onDeleted={handleFileDeleted}
                />
                <div className="pt-1">
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
