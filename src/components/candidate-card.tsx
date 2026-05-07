"use client";

import { memo, useMemo, useRef, useState, useCallback } from "react";
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
  RefreshCw,
  FileText,
  Mail,
  Gauge,
} from "lucide-react";

function LinkedInIcon({ className }: { className?: string }) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
    </svg>
  );
}

// JobAdder "JA" badge — shows when a candidate is linked in JobAdder
function JobAdderBadge({ url, className }: { url: string | null; className?: string }) {
  const base = cn(
    "inline-flex items-center justify-center w-5 h-5 rounded text-[9px] font-bold leading-none border transition-colors",
    url
      ? "bg-orange-500 text-white border-orange-600"
      : "bg-slate-100 text-slate-400 border-slate-200 hover:border-orange-300 hover:text-orange-500",
    className
  );
  if (url) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className={base} title="Open in JobAdder">
        JA
      </a>
    );
  }
  return <span className={base}>JA</span>;
}
import { ScoreBadge } from "./score-badge";
import { ScoreRadar } from "./score-radar";
import type { RadarDimensions } from "./score-radar";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { cn, statusLabel, statusBadge, safeParseJson } from "@/lib/utils";
import {
  CATEGORY_WEIGHTS_V2,
  MUST_HAVE_WEIGHT_V2,
  type ScoreBreakdown,
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
import { isPlausibleLocation } from "@/lib/location";
import { ScoreBreakdownPanel } from "./candidate/ScoreBreakdownPanel";
import { MH_CONFIG } from "./candidate/ScoreBreakdownPanel";
import { CandidateFilesSection } from "./candidate/CandidateFilesSection";
import { CandidateStatusHistory } from "./candidate/CandidateStatusHistory";
import { ScoreCorrectionButton } from "./candidate/score-correction-button";
import { CaptureMetadataPanel } from "./candidate/capture-metadata-panel";
import { ContactLog } from "./candidate/contact-log";

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
  jobAdderUrl: string | null;
  profileText: string | null;
  profileCapturedAt?: string | null;
  matchScore: number | null;
  provisionalScore?: number | null;
  profileTextHash: string | null;
  matchReason: string | null;
  fetchPriorityScore?: number | null;
  fetchPriorityReason?: string | null;
  acceptanceScore: number | null;
  acceptanceReason: string | null;
  scoreBreakdown: string | null;
  notes: string | null;
  screeningData: string | null;
  interviewNotes: string | null;
  status: string;
  statusHistory: string | null;
  source: string;
  captureMetadata?: string | null;
}

// ── Pipeline action configuration ────────────────────────────────────────────
// Maps each pipeline status to: forward action, optional back action, and
// special document actions. Replacing 140 lines of JSX if-else chains.
type StatusAction = { label: string; to: string; icon?: string; className: string };
const PIPELINE_FORWARD: Record<string, StatusAction> = {
  new:          { label: "Shortlist",       to: "shortlisted",  icon: "star",  className: "text-amber-600 hover:bg-amber-50 hover:text-amber-700" },
  reviewing:    { label: "Shortlist",       to: "shortlisted",  icon: "star",  className: "text-amber-600 hover:bg-amber-50 hover:text-amber-700" },
  shortlisted:  { label: "Mark Contacted",  to: "contacted",    icon: "send",  className: "text-violet-600 hover:bg-violet-50" },
  contacted:    { label: "Interviewing",    to: "interviewing",                className: "text-indigo-600 hover:bg-indigo-50" },
  interviewing: { label: "Send Offer",      to: "offer_sent",                  className: "text-emerald-600 hover:bg-emerald-50" },
  // offer_sent is intentionally absent — it has two forward options (Hired / Declined)
  // which are handled explicitly below. Never add offer_sent here or both paths will render.
} as const satisfies Partial<Record<string, StatusAction>>;
const PIPELINE_BACK: Record<string, StatusAction> = {
  shortlisted:  { label: "↩ Reviewing",    to: "reviewing",   className: "text-slate-400 hover:text-slate-600" },
  contacted:    { label: "↩ Shortlist",    to: "shortlisted", className: "text-slate-400 hover:text-slate-600" },
  interviewing: { label: "↩ Contacted",    to: "contacted",   className: "text-slate-400 hover:text-slate-600" },
};
const TERMINAL_STATUSES = new Set(["hired", "declined", "rejected"]);

interface CandidateCardProps {
  candidate: Candidate;
  jobId: string;
  onStatusChange: (id: string, status: string) => void;
  onScore: (id: string) => void;
  onFetchProfile: (id: string) => void;
  onNotesChange: (id: string, notes: string) => void;
  onLinkedInChange?: (id: string, url: string) => void;
  onJobAdderChange?: (id: string, url: string) => void;
  onScreeningDataChange?: (id: string, data: string) => void;
  onInterviewNotesChange?: (id: string, data: string) => void;
  onDelete: (id: string) => void;
  scoring?: boolean;
  fetchingProfile?: boolean;
  fetchQueueState?: string;
  fetchQueuePosition?: number;
  contactCount?: number;
}

type LegacyRadarDimensions = Partial<RadarDimensions>;

function candidateSourceLabel(candidate: Candidate) {
  const profileChars = candidate.profileText?.trim().length ?? 0;
  if (candidate.source === "extension") {
    if (profileChars > 0 && profileChars < 500) return "LinkedIn partial capture";
    if (profileChars >= 500 && profileChars < 2000) return "LinkedIn partial profile";
    return "LinkedIn extension";
  }
  if (candidate.source === "talent_pool") return "Talent pool";
  if (candidate.source === "bookmarklet") return "LinkedIn capture";
  if (candidate.source === "pdl") return "People Data Labs";
  if (candidate.source === "serpapi") return "SerpAPI snippet";
  return candidate.source ? candidate.source.replace(/_/g, " ") : "Manual";
}

function profileSourceSummary(candidate: Candidate) {
  const profileChars = candidate.profileText?.trim().length ?? 0;
  if (candidate.source === "extension") {
    if (profileChars > 0 && profileChars < 500) {
      return "The extension captured only a short partial profile. Fetch again before trusting the score.";
    }
    if (profileChars >= 500 && profileChars < 2000) {
      return "The extension captured a partial profile. Treat the score as provisional.";
    }
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
      industry: breakdown.categories.domain_fit?.score ?? breakdown.categories.industry_fit?.score ?? 50,
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
  if (!location || !isPlausibleLocation(location)) return null;

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

interface FetchPriorityReason {
  label?: string;
  summary?: string;
  signals?: string[];
  risks?: string[];
  matchedTerms?: string[];
}

function FetchPriorityBadge({
  score,
  reason,
}: {
  score: number | null | undefined;
  reason: FetchPriorityReason | null;
}) {
  const [show, setShow] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, right: 0 });

  if (score == null) return null;

  const cfg =
    score >= 80
      ? { pill: "bg-emerald-50 text-emerald-700 border-emerald-200", label: "Strong lead" }
      : score >= 65
        ? { pill: "bg-blue-50 text-blue-700 border-blue-200", label: "Worth fetching" }
        : score >= 50
          ? { pill: "bg-amber-50 text-amber-700 border-amber-200", label: "Possible lead" }
          : { pill: "bg-slate-100 text-slate-500 border-slate-200", label: "Weak lead" };

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
        <Gauge className="w-3 h-3" />
        Fetch {score}%
      </div>

      {show && (
        <div
          className="w-72 bg-slate-900 text-white rounded-xl shadow-2xl overflow-hidden"
          style={{ position: "fixed", top: pos.top, right: pos.right, zIndex: 9999 }}
          onMouseEnter={() => setShow(true)}
          onMouseLeave={() => setShow(false)}
        >
          <div className="px-4 pt-3 pb-2 border-b border-slate-700">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-0.5">Fetch Priority</p>
            <p className="text-sm font-medium text-white">{reason?.label ?? cfg.label}</p>
            <p className="text-xs text-slate-400 mt-1">
              Lead quality from search evidence. This is not the candidate match score.
            </p>
          </div>
          {reason?.summary && (
            <div className="px-4 py-2 border-b border-slate-700">
              <p className="text-xs text-slate-300 leading-relaxed">{reason.summary}</p>
            </div>
          )}
          {(reason?.signals?.length || reason?.risks?.length) && (
            <div className="px-4 py-2.5 space-y-2">
              {reason?.signals?.slice(0, 4).map((signal, i) => (
                <p key={`s-${i}`} className="text-xs text-slate-300 leading-snug">+ {signal}</p>
              ))}
              {reason?.risks?.slice(0, 3).map((risk, i) => (
                <p key={`r-${i}`} className="text-xs text-amber-200 leading-snug">- {risk}</p>
              ))}
            </div>
          )}
        </div>
      )}
    </>
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
      label: "Domain fit",
      score: breakdown.categories.domain_fit?.score ?? breakdown.categories.industry_fit?.score ?? 50,
      weight: CATEGORY_WEIGHTS_V2.domain_fit,
    },
    {
      label: "Nice-to-have fit",
      score: breakdown.categories.nice_to_have_fit.score,
      weight: CATEGORY_WEIGHTS_V2.nice_to_have_fit,
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

function ProfileDrawer({
  candidate,
  jobId,
  onClose,
  onLinkedInChange,
  onFetchProfile,
  fetchingProfile = false,
  fetchQueueState,
  fetchQueuePosition,
}: {
  candidate: Candidate;
  jobId: string;
  onClose: () => void;
  onLinkedInChange?: (id: string, url: string) => void;
  onFetchProfile?: (id: string) => void;
  fetchingProfile?: boolean;
  fetchQueueState?: string;
  fetchQueuePosition?: number;
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
  const fetchPriorityReason = useMemo(
    () => safeParseJson<FetchPriorityReason | null>(candidate.fetchPriorityReason ?? null, null),
    [candidate.fetchPriorityReason]
  );
  const displaySummary = breakdown?.recruiter_summary ?? matchReason?.summary ?? null;
  const captureLabel = candidateSourceLabel(candidate);
  const capturedAt = candidate.profileCapturedAt ? new Date(candidate.profileCapturedAt) : null;
  const locationFitScore = breakdown?.categories.location_fit.score ?? null;
  const profileChars = candidate.profileText?.trim().length ?? 0;
  const hasFetchedProfile = Boolean(candidate.profileCapturedAt || (candidate.source === "extension" && profileChars > 0));

  const [editingLinkedIn, setEditingLinkedIn] = useState(false);
  const [linkedInInput, setLinkedInInput] = useState(candidate.linkedinUrl ?? "");
  const handleSaveLinkedIn = useCallback(() => {
    onLinkedInChange?.(candidate.id, linkedInInput.trim());
    setEditingLinkedIn(false);
  }, [candidate.id, linkedInInput, onLinkedInChange]);

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
                <span className="text-[11px] text-slate-400" suppressHydrationWarning>
                  Captured {capturedAt.toLocaleString()}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <ScoreBadge score={candidate.matchScore} size="sm" />
              {!hasFetchedProfile && (
                <FetchPriorityBadge score={candidate.fetchPriorityScore} reason={fetchPriorityReason} />
              )}
              {candidate.acceptanceScore != null && (
                <AcceptanceBadge score={candidate.acceptanceScore} data={acceptanceData} />
              )}
              <ScoreCorrectionButton
                jobId={jobId}
                candidateId={candidate.id}
                currentScore={candidate.matchScore}
              />
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
              fetchQueueState === "queued" ? (
                <span className="text-[11px] text-amber-500 flex items-center gap-1 font-medium">
                  <span className="w-3 h-3 rounded-full border-2 border-amber-400 border-t-transparent animate-spin inline-block" />
                  Queued{fetchQueuePosition ? ` #${fetchQueuePosition}` : ""}
                </span>
              ) : (fetchQueueState === "waiting" || fetchQueueState === "fetching") ? (
                <span className="text-[11px] text-blue-500 flex items-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" />Fetching…
                </span>
              ) : hasFetchedProfile ? (
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
          <CandidateFilesSection candidateId={candidate.id} />

          {/* Contact log — shared across all recruiters in the org */}
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Contact history</p>
            <ContactLog candidateId={candidate.id} />
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
              {candidate.captureMetadata && (
                <div className="mb-2">
                  <CaptureMetadataPanel raw={candidate.captureMetadata} />
                </div>
              )}
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
  onJobAdderChange,
  onScreeningDataChange,
  onInterviewNotesChange,
  onDelete,
  scoring = false,
  fetchingProfile = false,
  fetchQueueState,
  fetchQueuePosition,
  contactCount = 0,
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
  const [editingJobAdder, setEditingJobAdder] = useState(false);
  const [jobAdderInput, setJobAdderInput] = useState(candidate.jobAdderUrl ?? "");
  const [jobAdderSaveError, setJobAdderSaveError] = useState<string | null>(null);
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
  const fetchPriorityReason = useMemo(
    () => safeParseJson<FetchPriorityReason | null>(candidate.fetchPriorityReason ?? null, null),
    [candidate.fetchPriorityReason]
  );
  const captureLabel = candidateSourceLabel(candidate);
  const hasExtensionCapture = candidate.source === "extension" && !!candidate.profileText;
  const locationFitScore = breakdown?.categories.location_fit.score ?? null;
  const radarDimensions = getRadarDimensions(breakdown, matchReason?.dimensions);
  const profileChars = candidate.profileText?.trim().length ?? 0;
  // Only treat as fetched if there's still a linkedinUrl — deleting the URL means
  // the Re-fetch button would fail, so revert to "Fetch profile" state.
  const hasFetchedProfile = Boolean(
    candidate.linkedinUrl && (candidate.profileCapturedAt || hasExtensionCapture)
  );
  const hasViewableProfile = profileChars >= 500;

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

  const handleSaveJobAdder = async () => {
    try {
      await onJobAdderChange?.(candidate.id, jobAdderInput.trim());
      setEditingJobAdder(false);
      setJobAdderSaveError(null);
    } catch {
      setJobAdderSaveError("Failed to save — try again");
    }
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
                  <a href={candidate.linkedinUrl} target="_blank" rel="noopener noreferrer"
                    className="text-slate-400 hover:text-[#0A66C2] transition-colors flex-shrink-0"
                    title="Open LinkedIn profile">
                    <LinkedInIcon className="w-3.5 h-3.5" />
                  </a>
                )}
                <JobAdderBadge url={candidate.jobAdderUrl} />
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
                  <span className="text-[11px] text-slate-400" suppressHydrationWarning>
                    {candidate.profileText.length.toLocaleString()} chars saved
                  </span>
                )}
              </div>
            </div>

            <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
              {!hasFetchedProfile && candidate.matchScore != null && (
                <span className="text-[9px] font-semibold uppercase tracking-wide text-orange-500 bg-orange-50 border border-orange-200 rounded px-1 py-0.5">
                  Provisional
                </span>
              )}
              {/* Score delta: shown after full-profile scoring when the provisional snapshot exists */}
              {hasFetchedProfile && candidate.provisionalScore != null && candidate.matchScore != null &&
               Math.abs(candidate.matchScore - candidate.provisionalScore) >= 8 && (
                <span
                  title={`Provisional score was ${candidate.provisionalScore}% at import`}
                  className={cn(
                    "text-[9px] font-semibold px-1 py-0.5 rounded border",
                    candidate.matchScore > candidate.provisionalScore
                      ? "text-emerald-700 bg-emerald-50 border-emerald-200"
                      : "text-rose-700 bg-rose-50 border-rose-200"
                  )}
                >
                  {candidate.matchScore > candidate.provisionalScore ? "▲" : "▼"} was {candidate.provisionalScore}%
                </span>
              )}
              <div className="flex items-center gap-2">
                {/* Confidence badge — only when breakdown is present */}
                {breakdown && <ConfidenceBadge breakdown={breakdown} />}
                {!hasFetchedProfile && (
                  <FetchPriorityBadge score={candidate.fetchPriorityScore} reason={fetchPriorityReason} />
                )}
                {/* Score badge with radar tooltip on hover */}
                <div
                  ref={scoreBadgeRef}
                  className="relative"
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
                  {/* Amber dot: profile updated since last score */}
                  {candidate.matchScore != null && !candidate.profileTextHash && candidate.profileText && (
                    <span
                      title="Profile updated since last score — re-score recommended"
                      className="absolute -top-1 -right-1 w-2 h-2 bg-amber-400 rounded-full border border-white"
                    />
                  )}
                  {/* Amber dot: provisional score — no full profile captured yet */}
                  {candidate.matchScore != null && !hasFetchedProfile && (
                    <span
                      title="Provisional score — based on a LinkedIn snippet, not a full profile. Fetch the full profile for a reliable score."
                      className="absolute -top-1 -left-1 w-2 h-2 bg-orange-400 rounded-full border border-white"
                    />
                  )}
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
                {contactCount > 0 && (
                  <span
                    className="inline-flex items-center gap-1 text-[10px] text-violet-700 bg-violet-50 border border-violet-200 rounded-full px-1.5 py-0.5 font-medium"
                    title={`${contactCount} contact${contactCount !== 1 ? "s" : ""} logged`}
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-violet-500 inline-block" />
                    {contactCount}
                  </span>
                )}
              </div>
              {/* Acceptance likelihood badge */}
              <AcceptanceBadge score={candidate.acceptanceScore} data={acceptanceData} />
            </div>
          </div>
        </div>
      </div>

      {/* AI summary + reasoning */}
      <ScoreBreakdownPanel
        breakdown={breakdown}
        matchReason={matchReason}
        showReasoning={showReasoning}
        setShowReasoning={setShowReasoning}
        displaySummary={displaySummary}
      />

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

          {/* LinkedIn URL */}
          {onLinkedInChange && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs font-medium text-slate-600">LinkedIn URL</p>
                {!editingLinkedIn && (
                  <button onClick={() => { setLinkedInInput(candidate.linkedinUrl ?? ""); setEditingLinkedIn(true); }}
                    className="text-xs text-blue-600 hover:text-blue-700">
                    {candidate.linkedinUrl ? "Edit" : "Add"}
                  </button>
                )}
              </div>
              {editingLinkedIn ? (
                <div>
                  <input type="url" value={linkedInInput} onChange={(e) => setLinkedInInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleSaveLinkedIn(); if (e.key === "Escape") setEditingLinkedIn(false); }}
                    placeholder="https://linkedin.com/in/..." autoFocus
                    className="w-full text-xs border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <div className="flex gap-2 mt-1.5">
                    <button onClick={handleSaveLinkedIn} className="text-xs text-blue-600 font-medium hover:text-blue-700">Save</button>
                    <button onClick={() => setEditingLinkedIn(false)} className="text-xs text-slate-500 hover:text-slate-700">Cancel</button>
                  </div>
                </div>
              ) : candidate.linkedinUrl ? (
                <a href={candidate.linkedinUrl} target="_blank" rel="noopener noreferrer"
                  className="text-xs text-blue-600 hover:underline truncate block max-w-full">{candidate.linkedinUrl}</a>
              ) : (
                <p className="text-xs text-slate-400">No LinkedIn URL — add one to enable profile fetch</p>
              )}
            </div>
          )}

          {/* JobAdder URL */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-1.5">
                <JobAdderBadge url={null} className="w-4 h-4 text-[8px]" />
                <p className="text-xs font-medium text-slate-600">JobAdder</p>
              </div>
              {!editingJobAdder && (
                <button onClick={() => { setJobAdderInput(candidate.jobAdderUrl ?? ""); setJobAdderSaveError(null); setEditingJobAdder(true); }}
                  className="text-xs text-orange-500 hover:text-orange-600">
                  {candidate.jobAdderUrl ? "Edit" : "Link"}
                </button>
              )}
            </div>
            {editingJobAdder ? (
              <div>
                <input type="url" value={jobAdderInput} onChange={(e) => setJobAdderInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleSaveJobAdder(); if (e.key === "Escape") setEditingJobAdder(false); }}
                  placeholder="https://app.jobadder.com/candidates/..." autoFocus
                  className="w-full text-xs border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-orange-400"
                />
                <div className="flex gap-2 mt-1.5">
                  <button onClick={handleSaveJobAdder} className="text-xs text-orange-500 font-medium hover:text-orange-600">Save</button>
                  <button onClick={() => setEditingJobAdder(false)} className="text-xs text-slate-500 hover:text-slate-700">Cancel</button>
                </div>
                {jobAdderSaveError && <p className="text-xs text-amber-600 mt-1">{jobAdderSaveError}</p>}
              </div>
            ) : candidate.jobAdderUrl ? (
              <a href={candidate.jobAdderUrl} target="_blank" rel="noopener noreferrer"
                className="text-xs text-orange-500 hover:underline truncate block max-w-full">{candidate.jobAdderUrl}</a>
            ) : (
              <p className="text-xs text-slate-400">Not linked — paste the JobAdder candidate URL to link</p>
            )}
          </div>

          {/* Status timeline */}
          <CandidateStatusHistory statusHistory={candidate.statusHistory} />

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
        {/* Status actions — driven by PIPELINE_FORWARD / PIPELINE_BACK config */}
        <div className="flex items-center gap-1 flex-1 flex-wrap">
          {/* Forward step */}
          {PIPELINE_FORWARD[candidate.status] && (() => {
            const a = PIPELINE_FORWARD[candidate.status];
            return (
              <Button size="sm" variant="ghost" onClick={() => onStatusChange(candidate.id, a.to)} className={a.className}>
                {a.icon === "star" && <Star className="w-3.5 h-3.5" />}
                {a.icon === "send" && <Send className="w-3.5 h-3.5" />}
                {a.label}
              </Button>
            );
          })()}
          {/* offer_sent has two forward options */}
          {candidate.status === "offer_sent" && (<>
            <Button size="sm" variant="ghost" onClick={() => onStatusChange(candidate.id, "hired")}   className="text-green-700 hover:bg-green-50">Hired</Button>
            <Button size="sm" variant="ghost" onClick={() => onStatusChange(candidate.id, "declined")} className="text-orange-600 hover:bg-orange-50">Declined</Button>
          </>)}
          {/* Back step */}
          {PIPELINE_BACK[candidate.status] && (() => {
            const a = PIPELINE_BACK[candidate.status];
            return <Button size="sm" variant="ghost" onClick={() => onStatusChange(candidate.id, a.to)} className={a.className}>{a.label}</Button>;
          })()}
          {/* Reject — available on all non-terminal stages */}
          {!TERMINAL_STATUSES.has(candidate.status) && (
            <Button size="sm" variant="ghost" onClick={() => onStatusChange(candidate.id, "rejected")} className="text-slate-400 hover:text-red-600 hover:bg-red-50">
              <X className="w-3.5 h-3.5" />Reject
            </Button>
          )}
          {/* Document actions */}
          {["rejected","declined"].includes(candidate.status) && (
            <Button size="sm" variant="ghost" onClick={() => setRejectionOpen(true)} className="text-slate-500 hover:text-red-700 hover:bg-red-50" title="Draft rejection email">
              <Mail className="w-3.5 h-3.5" />Draft email
            </Button>
          )}
          {["offer_sent","hired"].includes(candidate.status) && (
            <Button size="sm" variant="ghost" onClick={() => setOfferOpen(true)} className="text-emerald-600 hover:bg-emerald-50" title="Generate offer letter">
              <Mail className="w-3.5 h-3.5" />Offer letter
            </Button>
          )}
        </div>

        {/* Right side */}
        <div className="flex items-center gap-1">
          {(() => {
            return (
              <>
                {/* View: only when there's enough stored text to inspect */}
                {hasViewableProfile && (
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

                {/* Fetch profile button — prominent until first successful capture, subtle afterwards */}
                {candidate.linkedinUrl && (
                  fetchQueueState === "queued" ? (
                    <Button size="sm" variant="ghost" disabled className="text-amber-500 font-medium">
                      <span className="w-3 h-3 rounded-full border-2 border-amber-400 border-t-transparent animate-spin inline-block mr-1" />
                      #{fetchQueuePosition ?? "Q"}
                    </Button>
                  ) : (fetchQueueState === "waiting" || fetchQueueState === "fetching") ? (
                    <Button size="sm" variant="ghost" loading disabled className="text-blue-500">
                      Fetching…
                    </Button>
                  ) : hasFetchedProfile ? (
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
          jobId={jobId}
          onClose={() => setShowProfile(false)}
          onLinkedInChange={onLinkedInChange}
          onFetchProfile={onFetchProfile}
          fetchingProfile={fetchingProfile}
          fetchQueueState={fetchQueueState}
          fetchQueuePosition={fetchQueuePosition}
        />
      )}
    </div>
  );
});

CandidateCard.displayName = "CandidateCard";
