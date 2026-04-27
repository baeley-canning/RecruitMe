"use client";

import { memo, useMemo, useRef, useState, useCallback, useEffect } from "react";
import {
  MapPin,
  ChevronDown,
  ChevronUp,
  Star,
  X,
  Loader2,
  MessageSquare,
  TrendingUp,
  Minus,
  TrendingDown,
  CheckCircle2,
  XCircle,
  Send,
  Copy,
  Check,
  RefreshCw,
  FileText,
  Mail,
  Upload,
  Download,
  Trash2,
} from "lucide-react";

function LinkedInIcon({ className }: { className?: string }) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
    </svg>
  );
}
import { ScoreBadge } from "./score-badge";
import { ScoreRadar } from "./score-radar";
import type { RadarDimensions } from "./score-radar";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { cn, statusLabel, statusBadge, safeParseJson, timeAgo } from "@/lib/utils";
import {
  CATEGORY_WEIGHTS_V2,
  MUST_HAVE_WEIGHT_V2,
  type ScoreBreakdown,
  type MustHaveCoverageStatus,
  type NiceToHaveCoverageStatus,
} from "@/lib/scoring";
import {
  buildProfileExcerpt,
  SCORE_PROFILE_EXCERPT_MAX_CHARS,
} from "@/lib/profile-excerpt";
import { ScreeningSection } from "./screening-section";
import { ReferencePanel } from "./reference-panel";
import { InterviewSection } from "./interview-section";
import { CopyButton } from "./copy-button";
import { OutreachModal } from "./outreach-modal";
import { RejectionEmailModal } from "./rejection-email-modal";
import { OfferLetterModal } from "./offer-letter-modal";

interface AcceptanceSignal {
  label: string;
  positive: boolean;
}

interface AcceptanceData {
  likelihood: "high" | "medium" | "low";
  headline: string;
  signals: AcceptanceSignal[];
  summary: string;
}

interface Candidate {
  id: string;
  name: string;
  headline: string | null;
  location: string | null;
  linkedinUrl: string | null;
  profileText: string | null;
  profileCapturedAt?: string | null;
  matchScore: number | null;
  matchReason: string | null;
  acceptanceScore: number | null;
  acceptanceReason: string | null;
  scoreBreakdown: string | null;
  notes: string | null;
  screeningData: string | null;
  interviewNotes: string | null;
  status: string;
  statusHistory: string | null;
  source: string;
}

interface StatusEvent {
  status: string;
  changedAt: string;
}

interface CandidateCardProps {
  candidate: Candidate;
  jobId: string;
  onStatusChange: (id: string, status: string) => void;
  onScore: (id: string) => void;
  onFetchProfile: (id: string) => void;
  onNotesChange: (id: string, notes: string) => void;
  onLinkedInChange?: (id: string, url: string) => void;
  onScreeningDataChange?: (id: string, data: string) => void;
  onInterviewNotesChange?: (id: string, data: string) => void;
  onDelete: (id: string) => void;
  scoring?: boolean;
  fetchingProfile?: boolean;
}

type LegacyRadarDimensions = Partial<RadarDimensions>;

function candidateSourceLabel(candidate: Candidate) {
  if (candidate.source === "extension") return "LinkedIn extension";
  if (candidate.source === "talent_pool") return "Talent pool";
  if (candidate.source === "bookmarklet") return "LinkedIn capture";
  if (candidate.source === "pdl") return "People Data Labs";
  if (candidate.source === "serpapi") {
    return candidate.profileText && candidate.profileText.length >= 500 ? "LinkedIn profile text" : "SerpAPI snippet";
  }
  return candidate.source ? candidate.source.replace(/_/g, " ") : "Manual";
}

function profileSourceSummary(candidate: Candidate) {
  if (candidate.source === "extension") {
    return "Captured from the RecruitMe LinkedIn extension.";
  }
  if (candidate.source === "pdl") {
    return "Imported from People Data Labs and stored as structured profile text.";
  }
  if (!candidate.profileText) {
    return "No LinkedIn profile text has been stored yet.";
  }
  if (candidate.source === "serpapi" && candidate.profileText.length < 500) {
    return "This is still only the search snippet, not the full LinkedIn capture.";
  }
  return `Stored from ${candidateSourceLabel(candidate).toLowerCase()}.`;
}

function getRadarDimensions(
  breakdown: ScoreBreakdown | null,
  legacyDimensions: LegacyRadarDimensions | undefined
): RadarDimensions | null {
  if (breakdown) {
    return {
      skills: breakdown.categories.skill_fit.score,
      title: breakdown.categories.title_fit.score,
      industry: breakdown.categories.industry_fit.score,
      location: breakdown.categories.location_fit.score,
      seniority: breakdown.categories.seniority_fit.score,
    };
  }

  if (!legacyDimensions) return null;

  return {
    skills: legacyDimensions.skills ?? 0,
    title: legacyDimensions.title ?? 0,
    industry: legacyDimensions.industry ?? 0,
    location: legacyDimensions.location ?? 0,
    seniority: legacyDimensions.seniority ?? 0,
  };
}

function locationFitBadge(score: number | null | undefined) {
  if (score == null) {
    return {
      pill: "bg-slate-100 text-slate-500 border-slate-200",
      icon: "text-slate-400",
      label: "Location unknown",
    };
  }

  if (score >= 75) {
    return {
      pill: "bg-emerald-50 text-emerald-700 border-emerald-200",
      icon: "text-emerald-600",
      label: "Location fit",
    };
  }

  if (score >= 45) {
    return {
      pill: "bg-blue-50 text-blue-700 border-blue-200",
      icon: "text-blue-600",
      label: "Location maybe",
    };
  }

  return {
    pill: "bg-red-50 text-red-700 border-red-200",
    icon: "text-red-600",
    label: "Location mismatch",
  };
}

function LocationFitPill({
  location,
  score,
  compact = false,
}: {
  location: string | null;
  score: number | null | undefined;
  compact?: boolean;
}) {
  if (!location) return null;

  const cfg = locationFitBadge(score);

  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border font-medium",
        compact ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs",
        cfg.pill
      )}
      title={score != null ? `${cfg.label}: ${score}%` : cfg.label}
    >
      <MapPin className={cn(compact ? "w-3 h-3" : "w-3.5 h-3.5", cfg.icon)} />
      <span className="truncate max-w-[220px]">{location}</span>
      {score != null && <span className="tabular-nums opacity-80">{score}%</span>}
    </div>
  );
}

function AcceptanceBadge({
  score,
  data,
}: {
  score: number | null;
  data: AcceptanceData | null;
}) {
  const [showDetail, setShowDetail] = useState(false);
  const [tooltipPos, setTooltipPos] = useState({ top: 0, right: 0 });
  const badgeRef = useRef<HTMLDivElement>(null);

  if (score == null) return null;

  const level = score >= 70 ? "high" : score >= 40 ? "medium" : "low";

  const config = {
    high:   { pill: "bg-emerald-50 text-emerald-700 border-emerald-200", label: "Likely open",  Icon: TrendingUp },
    medium: { pill: "bg-amber-50 text-amber-700 border-amber-200",       label: "May consider", Icon: Minus },
    low:    { pill: "bg-red-50 text-red-600 border-red-100",             label: "Hard to move", Icon: TrendingDown },
  }[level];

  const handleMouseEnter = () => {
    if (!data) return;
    if (badgeRef.current) {
      const rect = badgeRef.current.getBoundingClientRect();
      setTooltipPos({
        top:   rect.bottom + 8,
        right: window.innerWidth - rect.right,
      });
    }
    setShowDetail(true);
  };

  return (
    <>
      <div
        ref={badgeRef}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={() => setShowDetail(false)}
        className={cn(
          "inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border font-medium cursor-default select-none",
          config.pill
        )}
      >
        <config.Icon className="w-3 h-3" />
        {config.label}
      </div>

      {showDetail && data && (
        <div
          className="w-72 bg-slate-900 text-white rounded-xl shadow-2xl overflow-hidden"
          style={{ position: "fixed", top: tooltipPos.top, right: tooltipPos.right, zIndex: 9999 }}
          onMouseEnter={() => setShowDetail(true)}
          onMouseLeave={() => setShowDetail(false)}
        >
          <div className="px-4 pt-3 pb-2 border-b border-slate-700">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">
              Offer Acceptance Likelihood
            </p>
            <p className="text-sm font-medium text-white leading-snug">{data.headline}</p>
          </div>

          {data.signals.length > 0 && (
            <div className="px-4 py-2.5 space-y-1.5 border-b border-slate-700">
              {data.signals.map((s, i) => (
                <div key={i} className="flex items-start gap-2">
                  {s.positive
                    ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0 mt-0.5" />
                    : <XCircle    className="w-3.5 h-3.5 text-red-400    flex-shrink-0 mt-0.5" />
                  }
                  <span className="text-xs text-slate-300 leading-relaxed">{s.label}</span>
                </div>
              ))}
            </div>
          )}

          {data.summary && (
            <div className="px-4 py-2.5 border-b border-slate-700">
              <p className="text-xs text-slate-400 leading-relaxed">{data.summary}</p>
            </div>
          )}

          <div className="px-4 py-3">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs text-slate-500">Likelihood score</span>
              <span className="text-xs font-semibold text-slate-300">{score}%</span>
            </div>
            <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
              <div
                className={cn(
                  "h-full rounded-full",
                  level === "high" ? "bg-emerald-500" : level === "medium" ? "bg-amber-500" : "bg-red-500"
                )}
                style={{ width: `${score}%` }}
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ─── Confidence badge ──────────────────────────────────────────────────────────

function ConfidenceBadge({ breakdown }: { breakdown: ScoreBreakdown }) {
  const [show, setShow] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, right: 0 });

  const { confidence, data_quality } = breakdown;

  const cfg = {
    high:   { pill: "bg-emerald-50 text-emerald-700 border-emerald-200", label: "High confidence" },
    medium: { pill: "bg-amber-50 text-amber-700 border-amber-200",       label: "Medium confidence" },
    low:    { pill: "bg-slate-100 text-slate-500 border-slate-200",      label: "Low confidence" },
  }[confidence.level];

  const qualityLabel = {
    full_profile: "Full profile",
    snippet:      "Snippet only",
    minimal:      "Minimal data",
  }[data_quality];

  return (
    <>
      <div
        ref={ref}
        onMouseEnter={() => {
          if (ref.current) {
            const rect = ref.current.getBoundingClientRect();
            setPos({ top: rect.bottom + 6, right: window.innerWidth - rect.right });
          }
          setShow(true);
        }}
        onMouseLeave={() => setShow(false)}
        className={cn(
          "inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded border font-medium leading-none cursor-default select-none",
          cfg.pill
        )}
      >
        <span className="text-[10px]">◎</span>
        {confidence.score}%
      </div>

      {show && (
        <div
          className="w-64 bg-slate-900 text-white rounded-xl shadow-2xl overflow-hidden"
          style={{ position: "fixed", top: pos.top, right: pos.right, zIndex: 9999 }}
          onMouseEnter={() => setShow(true)}
          onMouseLeave={() => setShow(false)}
        >
          <div className="px-4 pt-3 pb-2 border-b border-slate-700">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-0.5">Scoring Confidence</p>
            <p className="text-sm font-medium text-white">{cfg.label} · {qualityLabel}</p>
          </div>
          <div className="px-4 py-2.5 space-y-1">
            {confidence.reasons.map((r, i) => (
              <p key={i} className="text-xs text-slate-300 leading-snug">· {r}</p>
            ))}
          </div>
          <div className="px-4 pb-3">
            <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden mt-1">
              <div
                className={cn(
                  "h-full rounded-full",
                  confidence.level === "high" ? "bg-emerald-500" : confidence.level === "medium" ? "bg-amber-500" : "bg-slate-500"
                )}
                style={{ width: `${confidence.score}%` }}
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ─── Coverage chips ─────────────────────────────────────────────────────────────

const MH_CONFIG: Record<MustHaveCoverageStatus, { bg: string; text: string; icon: string }> = {
  confirmed:  { bg: "bg-emerald-50 border-emerald-200", text: "text-emerald-700", icon: "✓" },
  equivalent: { bg: "bg-teal-50 border-teal-200",       text: "text-teal-700",    icon: "≈" },
  likely:     { bg: "bg-blue-50 border-blue-200",        text: "text-blue-700",    icon: "~" },
  missing:    { bg: "bg-slate-50 border-slate-200",      text: "text-slate-500",   icon: "?" },
  negative:   { bg: "bg-red-50 border-red-200",          text: "text-red-700",     icon: "✗" },
  unknown:    { bg: "bg-slate-50 border-slate-200",      text: "text-slate-400",   icon: "?" },
};

const NTH_CONFIG: Record<NiceToHaveCoverageStatus, { bg: string; text: string; icon: string }> = {
  confirmed: { bg: "bg-violet-50 border-violet-200",  text: "text-violet-700",  icon: "✓" },
  likely:    { bg: "bg-slate-50 border-slate-200",    text: "text-slate-500",   icon: "~" },
  absent:    { bg: "bg-slate-50 border-slate-100",    text: "text-slate-400",   icon: "–" },
};

function chip(requirement: string, evidence: string, cfg: { bg: string; text: string; icon: string }, key: number) {
  const label = requirement.length > 32 ? requirement.slice(0, 30) + "…" : requirement;
  return (
    <span
      key={key}
      title={evidence}
      className={cn(
        "inline-flex items-center gap-0.5 text-xs px-1.5 py-0.5 rounded border font-medium cursor-default",
        cfg.bg, cfg.text
      )}
    >
      <span className="text-[10px]">{cfg.icon}</span>
      {label}
    </span>
  );
}

function MustHaveCoverageChips({ coverage }: { coverage: ScoreBreakdown["must_have_coverage"] }) {
  if (coverage.length === 0) return null;
  const order: MustHaveCoverageStatus[] = ["confirmed", "equivalent", "likely", "unknown", "missing", "negative"];
  const sorted = [...coverage].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  return (
    <div>
      <p className="text-xs font-medium text-slate-500 mb-1.5">Must-haves</p>
      <div className="flex flex-wrap gap-1">
        {sorted.map((c, i) => chip(c.requirement, c.evidence, MH_CONFIG[c.status], i))}
      </div>
      <p className="text-[10px] text-slate-400 mt-1">Hover for evidence from the profile</p>
    </div>
  );
}

function NiceToHaveCoverageChips({ coverage }: { coverage: NonNullable<ScoreBreakdown["nice_to_have_coverage"]> }) {
  if (!coverage || coverage.length === 0) return null;
  const order: NiceToHaveCoverageStatus[] = ["confirmed", "likely", "absent"];
  const sorted = [...coverage].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  return (
    <div>
      <p className="text-xs font-medium text-slate-500 mb-1.5">Nice-to-haves</p>
      <div className="flex flex-wrap gap-1">
        {sorted.map((c, i) => chip(c.requirement, c.evidence, NTH_CONFIG[c.status], i))}
      </div>
    </div>
  );
}

function ScoringDebugPanel({
  candidate,
  breakdown,
}: {
  candidate: Candidate;
  breakdown: ScoreBreakdown;
}) {
  const excerpt = candidate.profileText
    ? buildProfileExcerpt(candidate.profileText, SCORE_PROFILE_EXCERPT_MAX_CHARS)
    : "";

  const contributions = [
    {
      label: "Skill fit",
      score: breakdown.categories.skill_fit.score,
      weight: CATEGORY_WEIGHTS_V2.skill_fit,
    },
    {
      label: "Location fit",
      score: breakdown.categories.location_fit.score,
      weight: CATEGORY_WEIGHTS_V2.location_fit,
    },
    {
      label: "Seniority fit",
      score: breakdown.categories.seniority_fit.score,
      weight: CATEGORY_WEIGHTS_V2.seniority_fit,
    },
    {
      label: "Title fit",
      score: breakdown.categories.title_fit.score,
      weight: CATEGORY_WEIGHTS_V2.title_fit,
    },
    {
      label: "Industry fit",
      score: breakdown.categories.industry_fit.score,
      weight: CATEGORY_WEIGHTS_V2.industry_fit,
    },
    {
      label: "Nice-to-have fit",
      score: breakdown.categories.nice_to_have_fit.score,
      weight: CATEGORY_WEIGHTS_V2.nice_to_have_fit,
    },
    {
      label: "Keyword alignment",
      score: breakdown.categories.keyword_alignment.score,
      weight: CATEGORY_WEIGHTS_V2.keyword_alignment,
    },
    {
      label: "Must-have coverage",
      score: breakdown.must_have_pct,
      weight: MUST_HAVE_WEIGHT_V2,
    },
  ];

  const contributionValue = (score: number, weight: number) =>
    Math.round(score * weight * 10) / 10;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Scoring Debug</p>
          <p className="text-[11px] text-slate-400 mt-1">
            Exact scorer excerpt, weighted contributions, and must-have evidence.
          </p>
        </div>
        {excerpt && <CopyButton text={excerpt} />}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Overall</p>
          <p className="text-lg font-semibold text-slate-900">{breakdown.overall}%</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Confidence</p>
          <p className="text-lg font-semibold text-slate-900">{breakdown.confidence.score}%</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Must-have coverage</p>
          <p className="text-lg font-semibold text-slate-900">{breakdown.must_have_pct}%</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Evidence coverage</p>
          <p className="text-lg font-semibold text-slate-900">{breakdown.evidence_coverage_score}%</p>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 overflow-hidden">
        <div className="px-3 py-2 border-b border-slate-200 bg-slate-50">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Weighted Formula</p>
        </div>
        <div className="divide-y divide-slate-100">
          {contributions.map((row) => (
            <div key={row.label} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
              <div className="min-w-0">
                <p className="font-medium text-slate-700">{row.label}</p>
                <p className="text-slate-400">Weight {(row.weight * 100).toFixed(0)}%</p>
              </div>
              <div className="text-right flex-shrink-0">
                <p className="font-medium text-slate-700">{row.score}%</p>
                <p className="text-slate-400">+{contributionValue(row.score, row.weight)}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 overflow-hidden">
        <div className="px-3 py-2 border-b border-slate-200 bg-slate-50">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Must-have Evidence</p>
        </div>
        <div className="divide-y divide-slate-100">
          {breakdown.must_have_coverage.map((item, index) => (
            <div key={`${item.requirement}-${index}`} className="px-3 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-medium text-slate-700">{item.requirement}</p>
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
                    MH_CONFIG[item.status].bg,
                    MH_CONFIG[item.status].text
                  )}
                >
                  <span className="text-[10px]">{MH_CONFIG[item.status].icon}</span>
                  {item.status}
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-1 leading-relaxed">{item.evidence}</p>
            </div>
          ))}
        </div>
      </div>

      {excerpt && (
        <div>
          <div className="flex items-center justify-between gap-3 mb-2">
            <div>
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Exact Scorer Excerpt</p>
              <p className="text-[11px] text-slate-400 mt-0.5">
                This is the section-aware text currently sent to the match scorer.
              </p>
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-xs text-slate-700 leading-relaxed whitespace-pre-wrap font-mono">
              {excerpt}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

interface DrawerFile {
  id: string;
  type: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function drawerTypeLabel(type: string) {
  if (type === "cv") return "CV";
  if (type === "cover_letter") return "Cover Letter";
  return "Other";
}

function drawerTypeColor(type: string) {
  if (type === "cv") return "bg-blue-50 text-blue-600 border-blue-100";
  if (type === "cover_letter") return "bg-purple-50 text-purple-600 border-purple-100";
  return "bg-slate-50 text-slate-500 border-slate-100";
}

function DrawerFileRow({ file, candidateId, onDeleted }: { file: DrawerFile; candidateId: string; onDeleted: (id: string) => void }) {
  const [deleting, setDeleting] = useState(false);
  const handleDelete = async () => {
    if (!confirm(`Delete "${file.filename}"?`)) return;
    setDeleting(true);
    await fetch(`/api/candidates/${candidateId}/files/${file.id}`, { method: "DELETE" });
    onDeleted(file.id);
  };
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white border border-slate-100 group hover:border-slate-200 transition-colors">
      <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-medium border flex-shrink-0", drawerTypeColor(file.type))}>
        {drawerTypeLabel(file.type)}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-slate-700 truncate">{file.filename}</p>
        <p className="text-[10px] text-slate-400">{formatBytes(file.size)} · {timeAgo(new Date(file.createdAt))}</p>
      </div>
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <a
          href={`/api/candidates/${candidateId}/files/${file.id}`}
          download={file.filename}
          className="p-1 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
          title="Download"
        >
          <Download className="w-3.5 h-3.5" />
        </a>
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="p-1 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors disabled:opacity-50"
          title="Delete"
        >
          {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
        </button>
      </div>
    </div>
  );
}

function DrawerUploadZone({ candidateId, onUploaded }: { candidateId: string; onUploaded: (file: DrawerFile) => void }) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [type, setType] = useState<"cv" | "cover_letter" | "other">("cv");
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(null);
    setNotice(null);
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
        if (type === "cv" && data.scored === false) {
          setNotice("CV saved — no score generated because this job hasn't been parsed yet.");
        } else if (type === "cv" && data.scored) {
          setNotice("CV uploaded and scored.");
        }
      }
    } catch {
      setError("Upload failed — please try again");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }, [candidateId, type, onUploaded]);

  return (
    <div className="space-y-1.5">
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
        <label className={cn(
          "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-colors",
          uploading ? "bg-slate-100 text-slate-400 cursor-not-allowed" : "bg-blue-600 hover:bg-blue-500 text-white"
        )}>
          {uploading ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Uploading…</> : <><Upload className="w-3.5 h-3.5" />Upload file</>}
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
      <p className="text-[10px] text-slate-400">PDF, Word, or plain text · max 10 MB</p>
      {error && <p className="text-xs text-red-500">{error}</p>}
      {notice && <p className="text-xs text-slate-500">{notice}</p>}
    </div>
  );
}

function ProfileDrawer({
  candidate,
  onClose,
  onLinkedInChange,
  onFetchProfile,
  fetchingProfile = false,
}: {
  candidate: Candidate;
  onClose: () => void;
  onLinkedInChange?: (id: string, url: string) => void;
  onFetchProfile?: (id: string) => void;
  fetchingProfile?: boolean;
}) {
  const breakdown = useMemo(
    () => safeParseJson<ScoreBreakdown | null>(candidate.scoreBreakdown, null),
    [candidate.scoreBreakdown]
  );
  const matchReason = useMemo(
    () => safeParseJson<{ summary?: string; reasoning?: string } | null>(candidate.matchReason, null),
    [candidate.matchReason]
  );
  const acceptanceData = useMemo(
    () => safeParseJson<AcceptanceData | null>(candidate.acceptanceReason, null),
    [candidate.acceptanceReason]
  );
  const displaySummary = breakdown?.recruiter_summary ?? matchReason?.summary ?? null;
  const captureLabel = candidateSourceLabel(candidate);
  const capturedAt = candidate.profileCapturedAt ? new Date(candidate.profileCapturedAt) : null;
  const locationFitScore = breakdown?.categories.location_fit.score ?? null;

  const [editingLinkedIn, setEditingLinkedIn] = useState(false);
  const [linkedInInput, setLinkedInInput] = useState(candidate.linkedinUrl ?? "");

  const [files, setFiles] = useState<DrawerFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/candidates/${candidate.id}/files`, { signal: controller.signal })
      .then((r) => r.ok ? r.json() : [])
      .then(setFiles)
      .catch((e) => { if (e.name !== "AbortError") console.error(e); })
      .finally(() => setFilesLoading(false));
    return () => controller.abort();
  }, [candidate.id]);

  const handleSaveLinkedIn = useCallback(() => {
    onLinkedInChange?.(candidate.id, linkedInInput.trim());
    setEditingLinkedIn(false);
  }, [candidate.id, linkedInInput, onLinkedInChange]);

  const hasGoodProfile = !!(
    candidate.profileText && (candidate.profileText.length >= 500 || candidate.profileCapturedAt)
  );

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/30 backdrop-blur-[2px] z-[1200]"
        onClick={onClose}
      />
      {/* Drawer */}
      <div className="fixed right-0 top-0 h-full w-full max-w-xl bg-white shadow-2xl z-[1210] flex flex-col">
        {/* Header */}
        <div className="flex items-start gap-4 px-6 py-5 border-b border-slate-100 flex-shrink-0">
          <div className="w-12 h-12 rounded-full bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center flex-shrink-0 text-white font-bold text-lg">
            {candidate.name.charAt(0).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="font-bold text-slate-900 text-base leading-tight">{candidate.name}</h2>
              {candidate.linkedinUrl && !editingLinkedIn && (
                <a
                  href={candidate.linkedinUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-slate-400 hover:text-[#0A66C2] transition-colors"
                  title="Open LinkedIn profile"
                >
                  <LinkedInIcon className="w-4 h-4" />
                </a>
              )}
            </div>
            {/* LinkedIn edit */}
            {editingLinkedIn ? (
              <div className="mt-1.5">
                <input
                  type="url"
                  value={linkedInInput}
                  onChange={(e) => setLinkedInInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleSaveLinkedIn(); if (e.key === "Escape") setEditingLinkedIn(false); }}
                  placeholder="https://linkedin.com/in/..."
                  className="w-full text-xs border border-slate-300 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  autoFocus
                />
                <div className="flex gap-2 mt-1">
                  <button onClick={handleSaveLinkedIn} className="text-xs text-blue-600 font-medium hover:text-blue-700">Save</button>
                  <button onClick={() => setEditingLinkedIn(false)} className="text-xs text-slate-500 hover:text-slate-700">Cancel</button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 mt-0.5">
                {candidate.headline && <p className="text-sm text-slate-500">{candidate.headline}</p>}
                <button
                  onClick={() => { setLinkedInInput(candidate.linkedinUrl ?? ""); setEditingLinkedIn(true); }}
                  className="text-[10px] text-slate-400 hover:text-blue-600 underline underline-offset-2 transition-colors flex-shrink-0"
                >
                  {candidate.linkedinUrl ? "Edit LinkedIn" : "Add LinkedIn"}
                </button>
              </div>
            )}
            {candidate.location && (
              <div className="mt-1.5">
                <LocationFitPill location={candidate.location} score={locationFitScore} />
              </div>
            )}
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <Badge className={candidate.source === "extension" ? "bg-blue-50 text-blue-700" : "bg-slate-100 text-slate-600"}>
                {captureLabel}
              </Badge>
              {capturedAt && (
                <span className="text-[11px] text-slate-400">
                  Captured {capturedAt.toLocaleString()}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <ScoreBadge score={candidate.matchScore} size="sm" />
              {candidate.acceptanceScore != null && (
                <AcceptanceBadge score={candidate.acceptanceScore} data={acceptanceData} />
              )}
            </div>
          </div>
          <div className="flex flex-col items-end gap-2 flex-shrink-0">
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-slate-700 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
            {onFetchProfile && candidate.linkedinUrl && (
              fetchingProfile ? (
                <span className="text-[11px] text-slate-400 flex items-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" />Fetching…
                </span>
              ) : hasGoodProfile ? (
                <button
                  onClick={() => onFetchProfile(candidate.id)}
                  className="text-[11px] text-slate-400 hover:text-slate-600 flex items-center gap-1 transition-colors"
                  title="Re-fetch LinkedIn profile"
                >
                  <RefreshCw className="w-3 h-3" />Re-fetch
                </button>
              ) : (
                <button
                  onClick={() => onFetchProfile(candidate.id)}
                  className="text-[11px] text-amber-600 hover:text-amber-700 flex items-center gap-1 font-medium transition-colors"
                  title="Fetch full LinkedIn profile"
                >
                  <RefreshCw className="w-3 h-3" />Fetch profile
                </button>
              )
            )}
          </div>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {/* AI summary */}
          {displaySummary && (
            <div className="p-4 bg-blue-50 border border-blue-100 rounded-xl">
              <p className="text-xs font-semibold text-blue-700 uppercase tracking-wide mb-1">AI Assessment</p>
              <p className="text-sm text-slate-700 leading-relaxed italic">&ldquo;{displaySummary}&rdquo;</p>
            </div>
          )}

          {/* Score breakdown */}
          {breakdown && (
            <div>
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Score breakdown</p>
              <div className="space-y-2">
                {(Object.entries(breakdown.categories) as [string, { score: number; evidence: string }][]).map(([key, cat]) => (
                  <div key={key}>
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="text-xs font-medium text-slate-600 capitalize">{key.replace(/_/g, " ").replace(" fit", "")}</span>
                      <span className="text-xs text-slate-500 tabular-nums">{cat.score}%</span>
                    </div>
                    <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                      <div
                        className={cn(
                          "h-full rounded-full",
                          cat.score >= 80 ? "bg-emerald-500" :
                          cat.score >= 60 ? "bg-blue-500" :
                          cat.score >= 40 ? "bg-amber-500" : "bg-red-400"
                        )}
                        style={{ width: `${cat.score}%` }}
                      />
                    </div>
                    {cat.evidence && (
                      <p className="text-[11px] text-slate-400 mt-0.5 leading-snug">{cat.evidence}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Reasons for / against */}
          {breakdown?.version === 2 && (breakdown.reasons_for?.length > 0 || breakdown.reasons_against?.length > 0) && (
            <div className="grid grid-cols-2 gap-4">
              {breakdown.reasons_for?.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-emerald-700 uppercase tracking-wide mb-2">Reasons for</p>
                  <ul className="space-y-1">
                    {breakdown.reasons_for.map((r, i) => (
                      <li key={i} className="text-xs text-slate-600 flex items-start gap-1.5">
                        <span className="text-emerald-500 flex-shrink-0 mt-0.5">✓</span>{r}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {breakdown.reasons_against?.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-red-600 uppercase tracking-wide mb-2">Reasons against</p>
                  <ul className="space-y-1">
                    {breakdown.reasons_against.map((r, i) => (
                      <li key={i} className="text-xs text-slate-600 flex items-start gap-1.5">
                        <span className="text-red-400 flex-shrink-0 mt-0.5">✗</span>{r}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {breakdown && <ScoringDebugPanel candidate={candidate} breakdown={breakdown} />}

          {/* Notes */}
          {candidate.notes && (
            <div>
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Notes</p>
              <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">{candidate.notes}</p>
            </div>
          )}

          {/* Files */}
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Files</p>
            {filesLoading ? (
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />Loading…
              </div>
            ) : (
              <div className="space-y-2 mb-3">
                {files.length === 0 && (
                  <p className="text-xs text-slate-400">No files uploaded yet.</p>
                )}
                {files.map((f) => (
                  <DrawerFileRow
                    key={f.id}
                    file={f}
                    candidateId={candidate.id}
                    onDeleted={(id) => setFiles((prev) => prev.filter((x) => x.id !== id))}
                  />
                ))}
              </div>
            )}
            <DrawerUploadZone
              candidateId={candidate.id}
              onUploaded={(f) => setFiles((prev) => [f, ...prev])}
            />
          </div>

          {/* Full profile text */}
          {candidate.profileText ? (
            <div>
              <div className="flex items-center justify-between gap-3 mb-2">
                <div>
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">LinkedIn Capture</p>
                  <p className="text-[11px] text-slate-400 mt-0.5">{profileSourceSummary(candidate)}</p>
                </div>
                <CopyButton text={candidate.profileText} />
              </div>
              <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl max-h-[50vh] overflow-y-auto">
                <p className="text-xs text-slate-700 leading-relaxed whitespace-pre-wrap">
                  {candidate.profileText}
                </p>
              </div>
            </div>
          ) : (
            <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl text-center">
              <p className="text-sm text-slate-400">No profile text captured yet.</p>
              <p className="text-xs text-slate-400 mt-1">Use &ldquo;Fetch profile&rdquo; to pull the full LinkedIn profile.</p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

export const CandidateCard = memo(function CandidateCard({
  candidate,
  jobId,
  onStatusChange,
  onScore,
  onFetchProfile,
  onNotesChange,
  onLinkedInChange,
  onScreeningDataChange,
  onInterviewNotesChange,
  onDelete,
  scoring = false,
  fetchingProfile = false,
}: CandidateCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showReasoning, setShowReasoning] = useState(false);
  const [showRadar, setShowRadar] = useState(false);
  const [radarPos, setRadarPos] = useState({ top: 0, right: 0 });
  const scoreBadgeRef = useRef<HTMLDivElement>(null);
  const [editingNotes, setEditingNotes] = useState(false);
  const [notes, setNotes] = useState(candidate.notes ?? "");
  const [editingLinkedIn, setEditingLinkedIn] = useState(false);
  const [linkedInInput, setLinkedInInput] = useState(candidate.linkedinUrl ?? "");
  const [outreachOpen, setOutreachOpen] = useState(false);
  const [rejectionOpen, setRejectionOpen] = useState(false);
  const [offerOpen, setOfferOpen] = useState(false);

  const matchReason = useMemo(
    () =>
      safeParseJson<{
        summary?: string;
        reasoning?: string;
        dimensions?: LegacyRadarDimensions;
        strengths?: string[];
        gaps?: string[];
      } | null>(candidate.matchReason, null),
    [candidate.matchReason]
  );

  const breakdown = useMemo(
    () => safeParseJson<ScoreBreakdown | null>(candidate.scoreBreakdown, null),
    [candidate.scoreBreakdown]
  );
  const acceptanceData = useMemo(
    () => safeParseJson<AcceptanceData | null>(candidate.acceptanceReason, null),
    [candidate.acceptanceReason]
  );
  const captureLabel = candidateSourceLabel(candidate);
  const hasExtensionCapture = candidate.source === "extension" && !!candidate.profileText;
  const locationFitScore = breakdown?.categories.location_fit.score ?? null;
  const radarDimensions = getRadarDimensions(breakdown, matchReason?.dimensions);

  // Use breakdown's recruiter_summary as the primary display summary when available
  const displaySummary = breakdown?.recruiter_summary ?? matchReason?.summary ?? null;

  const handleSaveNotes = () => {
    onNotesChange(candidate.id, notes);
    setEditingNotes(false);
  };

  const handleSaveLinkedIn = () => {
    onLinkedInChange?.(candidate.id, linkedInInput.trim());
    setEditingLinkedIn(false);
  };

  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-sm hover:shadow-md transition-shadow">
      {/* Header row */}
      <div className="flex items-start gap-3 p-4">
        {/* Avatar */}
        <button
          type="button"
          onClick={() => setShowProfile(true)}
          className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center flex-shrink-0 text-white font-semibold text-sm hover:shadow-md transition-shadow"
          title="View stored LinkedIn data"
        >
          {candidate.name.charAt(0).toUpperCase()}
        </button>

        {/* Main info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowProfile(true)}
                  className="font-semibold text-slate-900 text-sm leading-snug hover:text-blue-700 transition-colors text-left"
                  title="View stored LinkedIn data"
                >
                  {candidate.name}
                </button>
                {candidate.linkedinUrl && (
                  <a
                    href={candidate.linkedinUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-slate-400 hover:text-[#0A66C2] transition-colors flex-shrink-0"
                    title="Open LinkedIn profile"
                  >
                    <LinkedInIcon className="w-3.5 h-3.5" />
                  </a>
                )}
              </div>
              {candidate.headline && (
                <p className="text-xs text-slate-500 mt-0.5 line-clamp-1">
                  {candidate.headline}
                </p>
              )}
              {candidate.location && (
                <div className="mt-1">
                  <LocationFitPill location={candidate.location} score={locationFitScore} compact />
                </div>
              )}
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                <button
                  type="button"
                  onClick={() => setShowProfile(true)}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors",
                    hasExtensionCapture
                      ? "bg-blue-50 text-blue-700 hover:bg-blue-100"
                      : "bg-slate-100 text-slate-500 hover:bg-slate-200"
                  )}
                  title="Open stored LinkedIn capture"
                >
                  <FileText className="w-3 h-3" />
                  {captureLabel}
                </button>
                {candidate.profileText && (
                  <span className="text-[11px] text-slate-400">
                    {candidate.profileText.length.toLocaleString()} chars saved
                  </span>
                )}
              </div>
            </div>

            <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
              <div className="flex items-center gap-2">
                {/* Confidence badge — only when breakdown is present */}
                {breakdown && <ConfidenceBadge breakdown={breakdown} />}
                {/* Score badge with radar tooltip on hover */}
                <div
                  ref={scoreBadgeRef}
                  onMouseEnter={() => {
                    if (scoreBadgeRef.current) {
                      const rect = scoreBadgeRef.current.getBoundingClientRect();
                      setRadarPos({ top: rect.bottom + 8, right: window.innerWidth - rect.right });
                    }
                    setShowRadar(true);
                  }}
                  onMouseLeave={() => setShowRadar(false)}
                >
                  <ScoreBadge score={candidate.matchScore} size="sm" />
                </div>
                {showRadar && radarDimensions && (
                  <div
                    style={{ position: "fixed", top: radarPos.top, right: radarPos.right, zIndex: 9999 }}
                    onMouseEnter={() => setShowRadar(true)}
                    onMouseLeave={() => setShowRadar(false)}
                  >
                    <ScoreRadar dimensions={radarDimensions} />
                  </div>
                )}
                <Badge className={statusBadge(candidate.status)}>
                  {statusLabel(candidate.status)}
                </Badge>
              </div>
              {/* Acceptance likelihood badge */}
              <AcceptanceBadge score={candidate.acceptanceScore} data={acceptanceData} />
            </div>
          </div>
        </div>
      </div>

      {/* AI summary + reasoning */}
      {displaySummary && (
        <div className="px-4 pb-2">
          <div className="flex items-start justify-between gap-2">
            <p className="text-xs text-slate-600 leading-relaxed italic flex-1">
              &ldquo;{displaySummary}&rdquo;
            </p>
            {(breakdown?.must_have_coverage?.length || matchReason?.reasoning) && (
              <button
                onClick={() => setShowReasoning((v) => !v)}
                className="text-xs text-blue-600 hover:text-blue-700 whitespace-nowrap flex items-center gap-0.5 flex-shrink-0 mt-0.5 font-medium"
              >
                Why?
                <ChevronDown className={cn("w-3 h-3 transition-transform", showReasoning && "rotate-180")} />
              </button>
            )}
          </div>
          {showReasoning && (
            <div className="mt-2">
              {breakdown ? (
                <div className="space-y-3">
                  {/* Coverage chips: must-haves + nice-to-haves */}
                  <div className="space-y-2">
                    {breakdown.must_have_coverage.length > 0 && (
                      <MustHaveCoverageChips coverage={breakdown.must_have_coverage} />
                    )}
                    {breakdown.version === 2 && breakdown.nice_to_have_coverage?.length > 0 && (
                      <NiceToHaveCoverageChips coverage={breakdown.nice_to_have_coverage} />
                    )}
                  </div>

                  {/* Evidence coverage indicator (v2 only) */}
                  {breakdown.version === 2 && breakdown.evidence_coverage_score !== undefined && (
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-slate-400 whitespace-nowrap">Evidence coverage</span>
                      <div className="h-1.5 flex-1 bg-slate-100 rounded-full overflow-hidden">
                        <div
                          className={cn(
                            "h-full rounded-full",
                            breakdown.evidence_coverage_score >= 60 ? "bg-emerald-400" :
                            breakdown.evidence_coverage_score >= 30 ? "bg-amber-400" : "bg-slate-300"
                          )}
                          style={{ width: `${breakdown.evidence_coverage_score}%` }}
                        />
                      </div>
                      <span className="text-[10px] text-slate-400 tabular-nums w-7 text-right">
                        {breakdown.evidence_coverage_score}%
                      </span>
                    </div>
                  )}

                  {/* Category score bars */}
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-slate-500">Score breakdown</p>
                    {(Object.entries(breakdown.categories) as [string, { score: number; evidence: string }][]).map(([key, cat]) => (
                      <div key={key} className="flex items-start gap-2">
                        <div className="flex items-center gap-1.5 w-28 flex-shrink-0">
                          <div className="h-1.5 flex-1 bg-slate-100 rounded-full overflow-hidden">
                            <div
                              className={cn(
                                "h-full rounded-full",
                                cat.score >= 80 ? "bg-emerald-500" :
                                cat.score >= 60 ? "bg-blue-500" :
                                cat.score >= 40 ? "bg-amber-500" : "bg-red-400"
                              )}
                              style={{ width: `${cat.score}%` }}
                            />
                          </div>
                          <span className="text-[10px] text-slate-500 tabular-nums w-7 text-right">{cat.score}%</span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <span className="text-[10px] font-medium text-slate-500 uppercase tracking-wide">
                            {key.replace(/_/g, " ").replace(" fit", "")}
                          </span>
                          {cat.evidence && (
                            <p className="text-[10px] text-slate-500 leading-snug">{cat.evidence}</p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : matchReason?.reasoning ? (
                <div className="p-3 bg-blue-50 border border-blue-100 rounded-lg">
                  <p className="text-xs font-medium text-blue-800 mb-1">AI Assessment</p>
                  <p className="text-xs text-slate-700 leading-relaxed">{matchReason.reasoning}</p>
                </div>
              ) : null}
            </div>
          )}
        </div>
      )}

      {/* Expanded details */}
      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-slate-100 pt-3">
          {/* v2 breakdown: reasons for / against + missing evidence */}
          {breakdown && breakdown.version === 2 && (
            <>
              {(breakdown.reasons_for?.length > 0 || breakdown.reasons_against?.length > 0) && (
                <div className="grid grid-cols-2 gap-3">
                  {breakdown.reasons_for?.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-emerald-700 mb-1">Reasons for</p>
                      <ul className="space-y-0.5">
                        {breakdown.reasons_for.map((r, i) => (
                          <li key={i} className="text-xs text-slate-600 flex items-start gap-1">
                            <span className="text-emerald-500 mt-0.5 flex-shrink-0">✓</span>
                            {r}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {breakdown.reasons_against?.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-red-600 mb-1">Reasons against</p>
                      <ul className="space-y-0.5">
                        {breakdown.reasons_against.map((r, i) => (
                          <li key={i} className="text-xs text-slate-600 flex items-start gap-1">
                            <span className="text-red-400 mt-0.5 flex-shrink-0">✗</span>
                            {r}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {breakdown.missing_evidence?.length > 0 && (
                <div className="p-2.5 bg-amber-50 border border-amber-100 rounded-lg">
                  <p className="text-xs font-medium text-amber-700 mb-1">Missing evidence</p>
                  <ul className="space-y-0.5">
                    {breakdown.missing_evidence.map((m, i) => (
                      <li key={i} className="text-xs text-amber-800 flex items-start gap-1">
                        <span className="mt-0.5 flex-shrink-0">·</span>
                        {m}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}

          {/* v1 fallback: old strengths/gaps grid when no v2 breakdown */}
          {!breakdown && matchReason && (
            <div className="grid grid-cols-2 gap-3">
              {matchReason.strengths && matchReason.strengths.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-emerald-700 mb-1">Strengths</p>
                  <ul className="space-y-0.5">
                    {matchReason.strengths.map((s, i) => (
                      <li key={i} className="text-xs text-slate-600 flex items-start gap-1">
                        <span className="text-emerald-500 mt-0.5">✓</span>{s}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {matchReason.gaps && matchReason.gaps.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-red-600 mb-1">Gaps</p>
                  <ul className="space-y-0.5">
                    {matchReason.gaps.map((g, i) => (
                      <li key={i} className="text-xs text-slate-600 flex items-start gap-1">
                        <span className="text-red-400 mt-0.5">✗</span>{g}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Notes */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs font-medium text-slate-600">Notes</p>
              {!editingNotes && (
                <button
                  onClick={() => setEditingNotes(true)}
                  className="text-xs text-blue-600 hover:text-blue-700"
                >
                  {notes ? "Edit" : "Add note"}
                </button>
              )}
            </div>
            {editingNotes ? (
              <div>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="w-full text-xs border border-slate-300 rounded-lg px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
                  rows={3}
                  placeholder="Add your notes..."
                  autoFocus
                />
                <div className="flex gap-2 mt-1.5">
                  <button
                    onClick={handleSaveNotes}
                    className="text-xs text-blue-600 font-medium hover:text-blue-700"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => { setNotes(candidate.notes ?? ""); setEditingNotes(false); }}
                    className="text-xs text-slate-500 hover:text-slate-700"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-xs text-slate-500">{notes || "No notes yet"}</p>
            )}
          </div>

          {/* LinkedIn URL — editable when missing or to update */}
          {onLinkedInChange && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs font-medium text-slate-600">LinkedIn URL</p>
                {!editingLinkedIn && (
                  <button
                    onClick={() => { setLinkedInInput(candidate.linkedinUrl ?? ""); setEditingLinkedIn(true); }}
                    className="text-xs text-blue-600 hover:text-blue-700"
                  >
                    {candidate.linkedinUrl ? "Edit" : "Add"}
                  </button>
                )}
              </div>
              {editingLinkedIn ? (
                <div>
                  <input
                    type="url"
                    value={linkedInInput}
                    onChange={(e) => setLinkedInInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleSaveLinkedIn(); if (e.key === "Escape") setEditingLinkedIn(false); }}
                    placeholder="https://linkedin.com/in/..."
                    className="w-full text-xs border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    autoFocus
                  />
                  <div className="flex gap-2 mt-1.5">
                    <button onClick={handleSaveLinkedIn} className="text-xs text-blue-600 font-medium hover:text-blue-700">Save</button>
                    <button onClick={() => setEditingLinkedIn(false)} className="text-xs text-slate-500 hover:text-slate-700">Cancel</button>
                  </div>
                </div>
              ) : candidate.linkedinUrl ? (
                <a href={candidate.linkedinUrl} target="_blank" rel="noopener noreferrer"
                  className="text-xs text-blue-600 hover:underline truncate block max-w-full">
                  {candidate.linkedinUrl}
                </a>
              ) : (
                <p className="text-xs text-slate-400">No LinkedIn URL — add one to enable profile fetch</p>
              )}
            </div>
          )}

          {/* Status timeline */}
          {(() => {
            const history = safeParseJson<StatusEvent[]>(candidate.statusHistory, []);
            if (history.length === 0) return null;
            return (
              <div>
                <p className="text-xs font-medium text-slate-600 mb-2">History</p>
                <div className="relative pl-4 space-y-2">
                  <div className="absolute left-1.5 top-1 bottom-1 w-px bg-slate-200" />
                  {history.map((ev, i) => (
                    <div key={i} className="relative flex items-start gap-2">
                      <div className="absolute -left-3 top-1 w-2 h-2 rounded-full bg-white border-2 border-slate-300" />
                      <div>
                        <span className={cn(
                          "inline-block text-xs px-1.5 py-0.5 rounded font-medium",
                          statusBadge(ev.status)
                        )}>
                          {statusLabel(ev.status)}
                        </span>
                        <span className="text-xs text-slate-400 ml-1.5">
                          {timeAgo(ev.changedAt)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

          {/* Phone screening + Interview notes + Reference checks */}
          <ScreeningSection
            candidateId={candidate.id}
            jobId={jobId}
            screeningData={candidate.screeningData}
            onSaved={(updated) => onScreeningDataChange?.(candidate.id, updated)}
          />
          {["contacted", "interviewing", "offer_sent", "hired"].includes(candidate.status) ? (
            <InterviewSection
              candidateId={candidate.id}
              jobId={jobId}
              interviewNotes={candidate.interviewNotes}
              onSaved={(updated) => onInterviewNotesChange?.(candidate.id, updated)}
            />
          ) : null}
          <ReferencePanel candidateId={candidate.id} jobId={jobId} />
        </div>
      )}

      {/* Action bar */}
      <div className="flex items-center gap-1 px-4 py-2.5 border-t border-slate-100 bg-slate-50 rounded-b-xl">
        {/* Status actions — context-sensitive based on current pipeline stage */}
        <div className="flex items-center gap-1 flex-1 flex-wrap">
          {/* Forward actions */}
          {(candidate.status === "new" || candidate.status === "reviewing") && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onStatusChange(candidate.id, "shortlisted")}
              className="text-amber-600 hover:bg-amber-50 hover:text-amber-700"
            >
              <Star className="w-3.5 h-3.5" />
              Shortlist
            </Button>
          )}
          {candidate.status === "shortlisted" && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onStatusChange(candidate.id, "contacted")}
              className="text-violet-600 hover:bg-violet-50"
            >
              <Send className="w-3.5 h-3.5" />
              Mark Contacted
            </Button>
          )}
          {candidate.status === "contacted" && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onStatusChange(candidate.id, "interviewing")}
              className="text-indigo-600 hover:bg-indigo-50"
            >
              Interviewing
            </Button>
          )}
          {candidate.status === "interviewing" && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onStatusChange(candidate.id, "offer_sent")}
              className="text-emerald-600 hover:bg-emerald-50"
            >
              Send Offer
            </Button>
          )}
          {candidate.status === "offer_sent" && (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onStatusChange(candidate.id, "hired")}
                className="text-green-700 hover:bg-green-50"
              >
                Hired
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onStatusChange(candidate.id, "declined")}
                className="text-orange-600 hover:bg-orange-50"
              >
                Declined
              </Button>
            </>
          )}

          {/* Back step */}
          {candidate.status === "shortlisted" && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onStatusChange(candidate.id, "reviewing")}
              className="text-slate-400 hover:text-slate-600"
            >
              ↩ Reviewing
            </Button>
          )}
          {candidate.status === "contacted" && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onStatusChange(candidate.id, "shortlisted")}
              className="text-slate-400 hover:text-slate-600"
            >
              ↩ Shortlist
            </Button>
          )}
          {candidate.status === "interviewing" && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onStatusChange(candidate.id, "contacted")}
              className="text-slate-400 hover:text-slate-600"
            >
              ↩ Contacted
            </Button>
          )}

          {/* Reject — available on all active stages */}
          {!["hired", "declined", "rejected"].includes(candidate.status) && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onStatusChange(candidate.id, "rejected")}
              className="text-slate-400 hover:text-red-600 hover:bg-red-50"
            >
              <X className="w-3.5 h-3.5" />
              Reject
            </Button>
          )}

          {/* Rejection email — when rejected/declined */}
          {["rejected", "declined"].includes(candidate.status) && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setRejectionOpen(true)}
              className="text-slate-500 hover:text-red-700 hover:bg-red-50"
              title="Draft rejection email"
            >
              <Mail className="w-3.5 h-3.5" />
              Draft email
            </Button>
          )}

          {/* Offer letter — when offer sent or hired */}
          {["offer_sent", "hired"].includes(candidate.status) && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setOfferOpen(true)}
              className="text-emerald-600 hover:bg-emerald-50"
              title="Generate offer letter"
            >
              <Mail className="w-3.5 h-3.5" />
              Offer letter
            </Button>
          )}
        </div>

        {/* Right side */}
        <div className="flex items-center gap-1">
          {(() => {
            // profileCapturedAt means we've already done a deliberate fetch — treat as done
            // regardless of char count (some profiles are genuinely short)
            const hasGoodProfile = !!(
              candidate.profileText && (
                candidate.profileText.length >= 500 || candidate.profileCapturedAt
              )
            );
            return (
              <>
                {/* View: only when there's a meaningful profile */}
                {hasGoodProfile && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setShowProfile(true)}
                    className="text-slate-500 hover:text-blue-700 hover:bg-blue-50"
                    title="View stored LinkedIn profile"
                  >
                    <FileText className="w-3.5 h-3.5" />
                    View
                  </Button>
                )}

                {/* Fetch profile button — prominent when profile missing/thin, subtle icon when good */}
                {candidate.linkedinUrl && (
                  fetchingProfile ? (
                    <Button size="sm" variant="ghost" loading disabled className="text-slate-400">
                      Fetching…
                    </Button>
                  ) : hasGoodProfile ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onFetchProfile(candidate.id)}
                      className="text-slate-400 hover:text-slate-600 hover:bg-slate-100"
                      title="Re-fetch LinkedIn profile"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onFetchProfile(candidate.id)}
                      className="text-amber-600 hover:text-amber-700 hover:bg-amber-50 font-medium"
                      title="Fetch full LinkedIn profile and score"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      Fetch profile
                    </Button>
                  )
                )}
              </>
            );
          })()}
          {candidate.profileText && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onScore(candidate.id)}
              loading={scoring}
              className="text-blue-600 hover:bg-blue-50"
              disabled={scoring}
            >
              {!scoring && <Loader2 className="w-3.5 h-3.5" />}
              {candidate.matchScore != null ? "Re-score" : "Score"}
            </Button>
          )}
          {candidate.profileText && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setOutreachOpen(true)}
              className="text-violet-600 hover:bg-violet-50"
              title="Generate outreach message"
            >
              <Send className="w-3.5 h-3.5" />
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setEditingNotes(true)}
            className="text-slate-500"
          >
            <MessageSquare className="w-3.5 h-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setExpanded(!expanded)}
            className="text-slate-500"
          >
            {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onDelete(candidate.id)}
            className="text-slate-400 hover:text-red-600 hover:bg-red-50"
          >
            <X className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {outreachOpen && (
        <OutreachModal
          jobId={jobId}
          candidateId={candidate.id}
          candidateName={candidate.name}
          onClose={() => setOutreachOpen(false)}
        />
      )}

      {rejectionOpen && (
        <RejectionEmailModal
          jobId={jobId}
          candidateId={candidate.id}
          candidateName={candidate.name}
          onClose={() => setRejectionOpen(false)}
        />
      )}

      {offerOpen && (
        <OfferLetterModal
          jobId={jobId}
          candidateId={candidate.id}
          candidateName={candidate.name}
          onClose={() => setOfferOpen(false)}
        />
      )}

      {showProfile && (
        <ProfileDrawer
          candidate={candidate}
          onClose={() => setShowProfile(false)}
          onLinkedInChange={onLinkedInChange}
          onFetchProfile={onFetchProfile}
          fetchingProfile={fetchingProfile}
        />
      )}
    </div>
  );
});

CandidateCard.displayName = "CandidateCard";
