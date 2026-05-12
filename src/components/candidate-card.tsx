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
  MessageCircle,
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
  AlertTriangle,
} from "lucide-react";

import { LinkedInIcon, JobAdderBadge } from "./candidate/icons";
import type { FetchState } from "./fetch-queue-panel";
import {
  candidateSourceLabel,
  profileSourceSummary,
  getRadarDimensions,
  locationFitBadge,
  displayableLinkedinUrl,
} from "./candidate/helpers";
import { ScoreBadge } from "./score-badge";
import { ScoreRadar } from "./score-radar";
import type { RadarDimensions } from "./score-radar";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { cn, statusLabel, safeParseJson } from "@/lib/utils";
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
import { UploadCvButton } from "./candidate/UploadCvButton";
import { ProfileTextSection } from "./candidate/ProfileTextSection";
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
  /** Mirrors AcceptancePrediction.scoredBy on the server. Drives the
   *  Llama badge next to the acceptance score so a Llama-sourced
   *  likelihood is never displayed as if Claude produced it. */
  scoredBy?: "claude" | "ollama";
}

interface Candidate {
  id: string;
  name: string;
  headline: string | null;
  location: string | null;
  linkedinUrl: string | null;
  jobAdderUrl: string | null;
  phone?: string | null;
  /** Other active jobs (same org) where this candidate's LinkedIn URL also
   *  appears. Used to surface "Also on N other jobs" so the recruiter
   *  doesn't double-message. Provided by the GET /api/jobs/:id endpoint. */
  otherActiveJobs?: Array<{ jobId: string; title: string; company: string | null; matchScore: number | null }>;
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
  contactEvents?: Array<{ type: string; userName: string; createdAt: string }>;
  // Cross-org library access — set when the candidate's home org is
  // different from the viewer's, so the card can show a "Shared from X" tag.
  sharedFromOrgName?: string | null;
}

// ── Pipeline action configuration ────────────────────────────────────────────
// Maps each pipeline status to: forward action, optional back action, and
// special document actions. Replacing 140 lines of JSX if-else chains.
type StatusAction = { label: string; to: string; icon?: string; className: string };
const PIPELINE_FORWARD: Record<string, StatusAction> = {
  new:          { label: "Shortlist",       to: "shortlisted",  icon: "star",  className: "text-warning hover:text-warning hover:bg-warning-subtle" },
  reviewing:    { label: "Shortlist",       to: "shortlisted",  icon: "star",  className: "text-warning hover:text-warning hover:bg-warning-subtle" },
  shortlisted:  { label: "Mark Contacted",  to: "contacted",    icon: "send",  className: "text-accent hover:text-accent hover:bg-accent-subtle" },
  contacted:    { label: "Interviewing",    to: "interviewing",                className: "text-accent hover:text-accent hover:bg-accent-subtle" },
  interviewing: { label: "Send Offer",      to: "offer_sent",                  className: "text-success hover:text-success hover:bg-success-subtle" },
  // offer_sent is intentionally absent — it has two forward options (Hired / Declined)
  // which are handled explicitly below. Never add offer_sent here or both paths will render.
} as const satisfies Partial<Record<string, StatusAction>>;
const PIPELINE_BACK: Record<string, StatusAction> = {
  shortlisted:  { label: "↩ Reviewing",    to: "reviewing",   className: "text-text-tertiary hover:text-text-primary hover:bg-surface-hover" },
  contacted:    { label: "↩ Shortlist",    to: "shortlisted", className: "text-text-tertiary hover:text-text-primary hover:bg-surface-hover" },
  interviewing: { label: "↩ Contacted",    to: "contacted",   className: "text-text-tertiary hover:text-text-primary hover:bg-surface-hover" },
};
const TERMINAL_STATUSES = new Set(["hired", "declined", "rejected"]);

// Token-based status pill mapping (overrides legacy slate/blue/amber/etc in
// lib/utils.statusBadge so the candidate card stays on-design without
// touching the shared util — other agents are editing that file).
const STATUS_PILL_TOKENS: Record<string, string> = {
  new:          "bg-surface-hover text-text-secondary",
  reviewing:    "bg-surface-hover text-text-secondary",
  shortlisted:  "bg-accent-subtle text-accent",
  contacted:    "bg-warning-subtle text-warning",
  interviewing: "bg-warning-subtle text-warning",
  offer_sent:   "bg-warning-subtle text-warning",
  hired:        "bg-success-subtle text-success",
  // Recruiter dismissed the candidate — this is not an error state, so
  // we deliberately keep it tonally neutral (NOT danger red).
  declined:     "bg-surface-hover text-text-tertiary",
  rejected:     "bg-surface-hover text-text-tertiary",
};
function statusPillTokens(status: string): string {
  return STATUS_PILL_TOKENS[status] ?? "bg-surface-hover text-text-secondary";
}

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
  fetchQueueState?: FetchState;
  contactCount?: number;
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

  // Use locationFitBadge() only for the label string — colours are derived
  // locally from design tokens so the pill matches the dark Pro App palette.
  const cfg = locationFitBadge(score);
  const tone =
    score == null      ? "bg-surface-hover text-text-tertiary"
    : score >= 75      ? "bg-success-subtle text-success"
    : score >= 45      ? "bg-accent-subtle  text-accent"
    :                    "bg-danger-subtle  text-danger";

  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sm font-medium",
        compact ? "px-1.5 py-0.5 text-xs" : "px-2 py-0.5 text-xs",
        tone,
      )}
      title={score != null ? `${cfg.label}: ${score}%` : cfg.label}
    >
      <MapPin className="w-3 h-3" />
      <span className="truncate max-w-[220px]">{location}</span>
      {score != null && <span className="data-mono opacity-80">{score}%</span>}
    </div>
  );
}

function LlamaPill({ context }: { context: "match" | "acceptance" }) {
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-xs font-medium bg-llama-subtle text-llama"
      title={
        context === "match"
          ? "This candidate was scored by the local Llama model because Claude was unavailable. The score has been penalised to reflect lower confidence. Re-score when Claude is back."
          : "Acceptance likelihood was predicted by the local Llama model because Claude was unavailable. Treat as provisional and re-run prediction when Claude is back."
      }
    >
      Llama
    </span>
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
    high:   { pill: "bg-success-subtle text-success", label: "Likely open",  Icon: TrendingUp },
    medium: { pill: "bg-warning-subtle text-warning", label: "May consider", Icon: Minus },
    low:    { pill: "bg-surface-hover  text-text-tertiary", label: "Hard to move", Icon: TrendingDown },
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
        title="Offer acceptance likelihood — how likely this candidate is to accept an offer based on their career signals"
        className={cn(
          "inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-sm font-medium cursor-default select-none",
          config.pill,
        )}
      >
        <config.Icon className="w-3 h-3" />
        {config.label}
      </div>

      {showDetail && data && (
        <div
          className="w-72 bg-surface-overlay text-text-primary rounded-md shadow-overlay overflow-hidden border border-separator"
          style={{ position: "fixed", top: tooltipPos.top, right: tooltipPos.right, zIndex: 9999 }}
          onMouseEnter={() => setShowDetail(true)}
          onMouseLeave={() => setShowDetail(false)}
        >
          <div className="px-3 pt-2.5 pb-2 border-b border-separator">
            <p className="text-2xs font-semibold text-text-tertiary uppercase tracking-wide mb-1">
              Offer Acceptance Likelihood
            </p>
            <p className="text-sm font-medium text-text-primary leading-snug">{data.headline}</p>
          </div>

          {data.signals.length > 0 && (
            <div className="px-3 py-2 space-y-1.5 border-b border-separator">
              {data.signals.map((s, i) => (
                <div key={i} className="flex items-start gap-2">
                  {s.positive
                    ? <CheckCircle2 className="w-3.5 h-3.5 text-success flex-shrink-0 mt-0.5" />
                    : <XCircle    className="w-3.5 h-3.5 text-danger  flex-shrink-0 mt-0.5" />
                  }
                  <span className="text-xs text-text-secondary leading-relaxed">{s.label}</span>
                </div>
              ))}
            </div>
          )}

          {data.summary && (
            <div className="px-3 py-2 border-b border-separator">
              <p className="text-xs text-text-tertiary leading-relaxed">{data.summary}</p>
            </div>
          )}

          <div className="px-3 py-2.5">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs text-text-tertiary">Likelihood score</span>
              <span className="text-xs font-semibold text-text-secondary data-mono">{score}%</span>
            </div>
            <div className="h-1 bg-surface-sunken rounded-sm overflow-hidden">
              <div
                className={cn(
                  "h-full rounded-sm",
                  level === "high" ? "bg-success" : level === "medium" ? "bg-warning" : "bg-danger",
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
    high:   { pill: "bg-success-subtle text-success",        label: "High confidence" },
    medium: { pill: "bg-warning-subtle text-warning",        label: "Medium confidence" },
    low:    { pill: "bg-surface-hover  text-text-tertiary",  label: "Low confidence" },
  }[confidence.level];

  const qualityLabel = {
    full_profile: "Full profile",
    snippet:      "Snippet only",
    minimal:      "Minimal data",
  }[data_quality];
  const captureWarning = breakdown.profile_capture_warning;

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
          "inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-sm font-medium leading-none cursor-default select-none",
          cfg.pill,
        )}
      >
        <span className="text-[10px]">◎</span>
        <span className="data-mono">{confidence.score}%</span>
      </div>

      {show && (
        <div
          className="w-64 bg-surface-overlay text-text-primary rounded-md shadow-overlay overflow-hidden border border-separator"
          style={{ position: "fixed", top: pos.top, right: pos.right, zIndex: 9999 }}
          onMouseEnter={() => setShow(true)}
          onMouseLeave={() => setShow(false)}
        >
          <div className="px-3 pt-2.5 pb-2 border-b border-separator">
            <p className="text-2xs font-semibold text-text-tertiary uppercase tracking-wide mb-0.5">Scoring Confidence</p>
            <p className="text-sm font-medium text-text-primary">
              {captureWarning ? "Capture warning" : cfg.label} · {qualityLabel}
            </p>
          </div>
          <div className="px-3 py-2 space-y-1">
            {captureWarning && (
              <p className="text-xs text-warning leading-snug">{captureWarning.message}</p>
            )}
            {confidence.reasons.map((r, i) => (
              <p key={i} className="text-xs text-text-secondary leading-snug">· {r}</p>
            ))}
          </div>
          <div className="px-3 pb-2.5">
            <div className="h-1 bg-surface-sunken rounded-sm overflow-hidden mt-1">
              <div
                className={cn(
                  "h-full rounded-sm",
                  confidence.level === "high" ? "bg-success" : confidence.level === "medium" ? "bg-warning" : "bg-text-tertiary",
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
      ? { pill: "bg-success-subtle text-success",        label: "Strong lead" }
      : score >= 65
        ? { pill: "bg-accent-subtle text-accent",        label: "Worth fetching" }
        : score >= 50
          ? { pill: "bg-warning-subtle text-warning",    label: "Possible lead" }
          : { pill: "bg-surface-hover text-text-tertiary", label: "Weak lead" };

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
          "inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-sm font-medium leading-none cursor-default select-none",
          cfg.pill,
        )}
      >
        <Gauge className="w-3 h-3" />
        <span>Fetch <span className="data-mono">{score}%</span></span>
      </div>

      {show && (
        <div
          className="w-72 bg-surface-overlay text-text-primary rounded-md shadow-overlay overflow-hidden border border-separator"
          style={{ position: "fixed", top: pos.top, right: pos.right, zIndex: 9999 }}
          onMouseEnter={() => setShow(true)}
          onMouseLeave={() => setShow(false)}
        >
          <div className="px-3 pt-2.5 pb-2 border-b border-separator">
            <p className="text-2xs font-semibold text-text-tertiary uppercase tracking-wide mb-0.5">Fetch Priority</p>
            <p className="text-sm font-medium text-text-primary">{reason?.label ?? cfg.label}</p>
            <p className="text-xs text-text-tertiary mt-1">
              Lead quality from search evidence. This is not the candidate match score.
            </p>
          </div>
          {reason?.summary && (
            <div className="px-3 py-2 border-b border-separator">
              <p className="text-xs text-text-secondary leading-relaxed">{reason.summary}</p>
            </div>
          )}
          {(reason?.signals?.length || reason?.risks?.length) && (
            <div className="px-3 py-2 space-y-1.5">
              {reason?.signals?.slice(0, 4).map((signal, i) => (
                <p key={`s-${i}`} className="text-xs text-text-secondary leading-snug">+ {signal}</p>
              ))}
              {reason?.risks?.slice(0, 3).map((risk, i) => (
                <p key={`r-${i}`} className="text-xs text-warning leading-snug">- {risk}</p>
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
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-2xs font-semibold text-text-tertiary uppercase tracking-wide">Scoring Debug</p>
          <p className="text-xs text-text-tertiary mt-1">
            Exact scorer excerpt, weighted contributions, and must-have evidence.
          </p>
        </div>
        {excerpt && <CopyButton text={excerpt} />}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="rounded border border-separator bg-surface-sunken px-3 py-2">
          <p className="text-2xs font-semibold uppercase tracking-wide text-text-tertiary">Overall</p>
          <p className="text-md font-semibold text-text-primary data-mono">{breakdown.overall}%</p>
        </div>
        <div className="rounded border border-separator bg-surface-sunken px-3 py-2">
          <p className="text-2xs font-semibold uppercase tracking-wide text-text-tertiary">Confidence</p>
          <p className="text-md font-semibold text-text-primary data-mono">{breakdown.confidence.score}%</p>
        </div>
        <div className="rounded border border-separator bg-surface-sunken px-3 py-2">
          <p className="text-2xs font-semibold uppercase tracking-wide text-text-tertiary">Must-have coverage</p>
          <p className="text-md font-semibold text-text-primary data-mono">{breakdown.must_have_pct}%</p>
        </div>
        <div className="rounded border border-separator bg-surface-sunken px-3 py-2">
          <p className="text-2xs font-semibold uppercase tracking-wide text-text-tertiary">Evidence coverage</p>
          <p className="text-md font-semibold text-text-primary data-mono">{breakdown.evidence_coverage_score}%</p>
        </div>
      </div>

      <div className="rounded border border-separator overflow-hidden">
        <div className="px-3 py-2 border-b border-separator bg-surface-sunken">
          <p className="text-2xs font-semibold uppercase tracking-wide text-text-tertiary">Weighted Formula</p>
        </div>
        <div className="divide-y divide-separator">
          {contributions.map((row) => (
            <div key={row.label} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
              <div className="min-w-0">
                <p className="font-medium text-text-secondary">{row.label}</p>
                <p className="text-text-tertiary">Weight <span className="data-mono">{(row.weight * 100).toFixed(0)}%</span></p>
              </div>
              <div className="text-right flex-shrink-0">
                <p className="font-medium text-text-secondary data-mono">{row.score}%</p>
                <p className="text-text-tertiary data-mono">+{contributionValue(row.score, row.weight)}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded border border-separator overflow-hidden">
        <div className="px-3 py-2 border-b border-separator bg-surface-sunken">
          <p className="text-2xs font-semibold uppercase tracking-wide text-text-tertiary">Must-have Evidence</p>
        </div>
        <div className="divide-y divide-separator">
          {breakdown.must_have_coverage.map((item, index) => (
            <div key={`${item.requirement}-${index}`} className="px-3 py-2">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-medium text-text-secondary">{item.requirement}</p>
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs font-medium",
                    MH_CONFIG[item.status].bg,
                    MH_CONFIG[item.status].text,
                  )}
                >
                  <span className="text-2xs">{MH_CONFIG[item.status].icon}</span>
                  {item.status}
                </span>
              </div>
              <p className="text-xs text-text-tertiary mt-1 leading-relaxed">{item.evidence}</p>
            </div>
          ))}
        </div>
      </div>

      {excerpt && (
        <div>
          <div className="flex items-center justify-between gap-3 mb-2">
            <div>
              <p className="text-2xs font-semibold text-text-tertiary uppercase tracking-wide">Exact Scorer Excerpt</p>
              <p className="text-xs text-text-tertiary mt-0.5">
                This is the section-aware text currently sent to the match scorer.
              </p>
            </div>
          </div>
          <div className="rounded border border-separator bg-surface-sunken p-3">
            <p className="text-xs text-text-secondary leading-relaxed whitespace-pre-wrap font-mono">
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
}: {
  candidate: Candidate;
  jobId: string;
  onClose: () => void;
  onLinkedInChange?: (id: string, url: string) => void;
  onFetchProfile?: (id: string) => void;
  fetchingProfile?: boolean;
  fetchQueueState?: FetchState;
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
        className="fixed inset-0 bg-black/50 backdrop-blur-[2px] z-[1200]"
        onClick={onClose}
      />
      {/* Drawer */}
      <div className="fixed right-0 top-0 h-full w-full max-w-xl bg-surface-raised shadow-overlay z-[1210] flex flex-col border-l border-separator">
        {/* Header */}
        <div className="flex items-start gap-3 px-4 py-4 border-b border-separator flex-shrink-0">
          <div className="w-10 h-10 rounded-md bg-surface-hover flex items-center justify-center flex-shrink-0 text-text-primary font-semibold text-md">
            {candidate.name.charAt(0).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="font-semibold text-text-primary text-md leading-tight">{candidate.name}</h2>
              {displayableLinkedinUrl(candidate.linkedinUrl) && !editingLinkedIn && (
                <a
                  href={displayableLinkedinUrl(candidate.linkedinUrl)!}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-text-tertiary hover:text-accent transition-colors"
                  title="Open LinkedIn profile"
                >
                  <LinkedInIcon className="w-3.5 h-3.5" />
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
                  className="w-full h-7 text-md px-2.5 rounded bg-surface-sunken border border-separator text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:shadow-focus transition-all"
                  autoFocus
                />
                <div className="flex gap-2 mt-1">
                  <button onClick={handleSaveLinkedIn} className="text-xs text-accent font-medium hover:text-accent-hover">Save</button>
                  <button onClick={() => setEditingLinkedIn(false)} className="text-xs text-text-tertiary hover:text-text-primary">Cancel</button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 mt-0.5">
                {candidate.headline && <p className="text-base text-text-secondary">{candidate.headline}</p>}
                <button
                  onClick={() => { setLinkedInInput(candidate.linkedinUrl ?? ""); setEditingLinkedIn(true); }}
                  className="text-xs text-text-tertiary hover:text-accent underline underline-offset-2 transition-colors flex-shrink-0"
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
            {/* Phone (from Firmable enrichment). tel: link so recruiter can
                click-to-call from mobile / desktop softphones. */}
            {candidate.phone && (
              <a
                href={`tel:${candidate.phone.replace(/[^+\d]/g, "")}`}
                className="inline-flex items-center gap-1 mt-1.5 text-xs text-text-secondary hover:text-accent transition-colors"
                title="Click to call"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 5a2 2 0 012-2h2.28a1 1 0 01.95.68l1.49 4.48a1 1 0 01-.5 1.21l-1.6.8a11 11 0 005.52 5.52l.8-1.6a1 1 0 011.21-.5l4.48 1.49a1 1 0 01.68.95V19a2 2 0 01-2 2h-1C9.72 21 3 14.28 3 6V5z" />
                </svg>
                <span className="data-mono">{candidate.phone}</span>
              </a>
            )}
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <Badge className={candidate.source === "extension" ? "bg-accent-subtle text-accent" : "bg-surface-hover text-text-secondary"}>
                {captureLabel}
              </Badge>
              {capturedAt && (
                <span className="text-xs text-text-tertiary" suppressHydrationWarning>
                  Captured <span className="data-mono">{capturedAt.toLocaleString()}</span>
                </span>
              )}
              {/* Cross-job presence — same LinkedIn URL on N other active
                  jobs in this org. Subtle amber pill so it's noticeable
                  during scan but doesn't dominate the card. Hover tooltip
                  lists the jobs so the recruiter can avoid double-outreach. */}
              {candidate.otherActiveJobs && candidate.otherActiveJobs.length > 0 && (
                <span
                  className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-sm bg-warning-subtle text-warning"
                  title={`Also on:\n${candidate.otherActiveJobs.map((j) => ` • ${j.title}${j.company ? ` @ ${j.company}` : ""}${j.matchScore != null ? ` — ${j.matchScore}%` : ""}`).join("\n")}`}
                >
                  Also on <span className="data-mono">{candidate.otherActiveJobs.length}</span> other job{candidate.otherActiveJobs.length === 1 ? "" : "s"}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <ScoreBadge score={candidate.matchScore} size="sm" />
              {breakdown?.scoredBy === "ollama" && <LlamaPill context="match" />}
              {!hasFetchedProfile && (
                <FetchPriorityBadge score={candidate.fetchPriorityScore} reason={fetchPriorityReason} />
              )}
              {candidate.acceptanceScore != null && (
                <AcceptanceBadge score={candidate.acceptanceScore} data={acceptanceData} />
              )}
              {candidate.acceptanceScore != null && acceptanceData?.scoredBy === "ollama" && (
                <LlamaPill context="acceptance" />
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
              className="text-text-tertiary hover:text-text-primary hover:bg-surface-hover rounded transition-colors p-1.5 -m-1.5"
              aria-label="Close candidate detail"
            >
              <X className="w-4 h-4" />
            </button>
            {onFetchProfile && displayableLinkedinUrl(candidate.linkedinUrl) && (
              (fetchQueueState === "waiting" || fetchQueueState === "fetching") ? (
                <span className="text-xs text-accent flex items-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" />Fetching…
                </span>
              ) : hasFetchedProfile ? (
                <button
                  onClick={() => onFetchProfile(candidate.id)}
                  className="text-xs text-text-tertiary hover:text-text-primary flex items-center gap-1 transition-colors"
                  title="Re-fetch LinkedIn profile"
                >
                  <RefreshCw className="w-3 h-3" />Re-fetch
                </button>
              ) : (
                <button
                  onClick={() => onFetchProfile(candidate.id)}
                  className="text-xs text-warning hover:text-warning-hover flex items-center gap-1 font-medium transition-colors"
                  title="Fetch full LinkedIn profile"
                >
                  <RefreshCw className="w-3 h-3" />Fetch profile
                </button>
              )
            )}
          </div>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {/* AI summary */}
          {displaySummary && (
            <div className="p-3 bg-accent-subtle border border-separator rounded-md">
              <p className="text-2xs font-semibold text-accent uppercase tracking-wide mb-1">AI Assessment</p>
              <p className="text-base text-text-primary leading-relaxed italic">&ldquo;{displaySummary}&rdquo;</p>
            </div>
          )}

          {/* Score breakdown */}
          {breakdown && (
            <div>
              <p className="text-2xs font-semibold text-text-tertiary uppercase tracking-wide mb-2">Score breakdown</p>
              <div className="space-y-2">
                {(Object.entries(breakdown.categories) as [string, { score: number; evidence: string }][]).map(([key, cat]) => (
                  <div key={key}>
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="text-xs font-medium text-text-secondary capitalize">{key.replace(/_/g, " ").replace(" fit", "")}</span>
                      <span className="text-xs text-text-tertiary data-mono">{cat.score}%</span>
                    </div>
                    <div className="h-1 bg-surface-sunken rounded-sm overflow-hidden">
                      <div
                        className={cn(
                          "h-full rounded-sm",
                          cat.score >= 80 ? "bg-success" :
                          cat.score >= 60 ? "bg-accent" :
                          cat.score >= 40 ? "bg-warning" : "bg-danger",
                        )}
                        style={{ width: `${cat.score}%` }}
                      />
                    </div>
                    {cat.evidence && (
                      <p className="text-xs text-text-tertiary mt-0.5 leading-snug">{cat.evidence}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Reasons for / against */}
          {breakdown?.version === 2 && (breakdown.reasons_for?.length > 0 || breakdown.reasons_against?.length > 0) && (
            <div className="grid grid-cols-2 gap-3">
              {breakdown.reasons_for?.length > 0 && (
                <div>
                  <p className="text-2xs font-semibold text-success uppercase tracking-wide mb-2">Reasons for</p>
                  <ul className="space-y-1">
                    {breakdown.reasons_for.map((r, i) => (
                      <li key={i} className="text-xs text-text-secondary flex items-start gap-1.5">
                        <span className="text-success flex-shrink-0 mt-0.5">✓</span>{r}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {breakdown.reasons_against?.length > 0 && (
                <div>
                  <p className="text-2xs font-semibold text-danger uppercase tracking-wide mb-2">Reasons against</p>
                  <ul className="space-y-1">
                    {breakdown.reasons_against.map((r, i) => (
                      <li key={i} className="text-xs text-text-secondary flex items-start gap-1.5">
                        <span className="text-danger flex-shrink-0 mt-0.5">✗</span>{r}
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
              <p className="text-2xs font-semibold text-text-tertiary uppercase tracking-wide mb-2">Notes</p>
              <p className="text-base text-text-secondary leading-relaxed whitespace-pre-wrap">{candidate.notes}</p>
            </div>
          )}

          {/* Files */}
          <CandidateFilesSection candidateId={candidate.id} />

          {/* Contact log — shared across all recruiters in the org */}
          <div>
            <p className="text-2xs font-semibold text-text-tertiary uppercase tracking-wide mb-2">Contact history</p>
            <ContactLog candidateId={candidate.id} />
          </div>

          {/* Full profile text — viewable + editable. Editing is the
              manual override when the LinkedIn extension capture missed
              part of the candidate's history (Brendan-class: extension
              grabbed only the current role; recruiter pastes the older
              C++/Sybase work in here, candidate is re-scored). */}
          <ProfileTextSection candidate={candidate} jobId={jobId} />
          {candidate.captureMetadata && candidate.profileText && (
            <div className="mt-2">
              <CaptureMetadataPanel raw={candidate.captureMetadata} />
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
  const [messageState, setMessageState] = useState<"idle" | "saving" | "logged" | "error">("idle");
  // Once-per-load: stays "logged" until the page re-fetches the candidate.
  // Avoids accidental duplicate ContactEvents from a second click — the
  // server doesn't de-dup, so a second click really would create a 2nd row.

  const handleQuickMessage = useCallback(async () => {
    if (messageState === "saving" || messageState === "logged") return;
    setMessageState("saving");
    try {
      const res = await fetch(`/api/candidates/${candidate.id}/contacts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "message", jobId }),
      });
      if (!res.ok) throw new Error("save failed");
      setMessageState("logged");
    } catch {
      setMessageState("error");
      setTimeout(() => setMessageState("idle"), 3000);
    }
  }, [candidate.id, jobId, messageState]);

  const matchReason = useMemo(
    () =>
      safeParseJson<{
        summary?: string;
        reasoning?: string;
        dimensions?: Partial<RadarDimensions>;
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
  // When the LinkedIn capture is incomplete, the score and "reasons against"
  // are NOT trustworthy — the work history (which would prove the must-haves)
  // is missing from the captured text. Suppress the misleading 12%-style score
  // and Claude's fabricated rejection narrative; show "Unscored — capture
  // incomplete" + an Upload CV CTA so the recruiter has an obvious next step.
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
    <div className="bg-surface-raised border border-separator rounded-md hover:bg-surface-hover transition-colors">
      {/* Header row */}
      <div className="flex items-start gap-3 p-4">
        {/* Avatar */}
        <button
          type="button"
          onClick={() => setShowProfile(true)}
          className="w-8 h-8 rounded-md bg-surface-hover flex items-center justify-center flex-shrink-0 text-text-primary font-semibold text-md hover:bg-surface-overlay transition-colors"
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
                  className="font-semibold text-text-primary text-md leading-snug hover:text-accent transition-colors text-left"
                  title="View stored LinkedIn data"
                >
                  {candidate.name}
                </button>
                {displayableLinkedinUrl(candidate.linkedinUrl) && (
                  <a href={displayableLinkedinUrl(candidate.linkedinUrl)!} target="_blank" rel="noopener noreferrer"
                    className="text-text-tertiary hover:text-accent transition-colors flex-shrink-0"
                    title="Open LinkedIn profile">
                    <LinkedInIcon className="w-3.5 h-3.5" />
                  </a>
                )}
                <JobAdderBadge url={candidate.jobAdderUrl} />
                {candidate.sharedFromOrgName && (
                  <span
                    className="inline-flex items-center gap-1 text-xs font-medium text-accent bg-accent-subtle rounded-sm px-1.5 py-0.5"
                    title={`This candidate is in ${candidate.sharedFromOrgName}'s library — read-only via your cross-org subscription`}
                  >
                    Shared from {candidate.sharedFromOrgName}
                  </span>
                )}
              </div>
              {candidate.headline && (
                <p className="text-base text-text-secondary mt-0.5 line-clamp-1">
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
                    "inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs font-medium transition-colors",
                    hasExtensionCapture
                      ? "bg-accent-subtle text-accent hover:bg-accent/25"
                      : "bg-surface-hover text-text-tertiary hover:bg-surface-overlay",
                  )}
                  title="Open stored LinkedIn capture"
                >
                  <FileText className="w-3 h-3" />
                  {captureLabel}
                </button>
                {candidate.profileText && (
                  <span className="text-xs text-text-tertiary data-mono" suppressHydrationWarning>
                    {candidate.profileText.length.toLocaleString()} chars saved
                  </span>
                )}
              </div>
            </div>

            <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
              {/* Single data-quality badge replaces the previous trio (Minimal /
                  Snippet / Provisional) — shows the worst-case warning for this
                  candidate so the recruiter sees one clear signal, not clutter. */}
              {candidate.matchScore != null && (() => {
                // A "stub" breakdown is produced when Claude returned
                // unparseable JSON OR the capture path explicitly signalled
                // an incomplete profile. The breakdown carries
                // profile_capture_warning.code = "incomplete_capture" in
                // that case — the score is deterministic-only and NOT a
                // real Claude assessment. Flag this distinctly from "snippet"
                // so a recruiter doesn't trust a 50% stub as a 50% Claude score.
                const isStub = breakdown?.profile_capture_warning?.code === "incomplete_capture";
                const tag =
                  isStub                                  ? { label: "Stub score",   tone: "danger",  title: "Score is a deterministic stub — Claude either couldn't parse the profile or the capture is incomplete. Re-fetch the profile and re-score for a real assessment." } :
                  breakdown?.data_quality === "minimal"   ? { label: "Thin profile", tone: "danger",  title: "Very little profile data — score is speculative until the full profile is fetched" } :
                  breakdown?.data_quality === "snippet"   ? { label: "Snippet only", tone: "warning", title: "Score is based on a LinkedIn snippet — fetch the full profile for a reliable assessment" } :
                  (!hasFetchedProfile && !breakdown?.data_quality) ? { label: "Provisional", tone: "warning", title: "Score is provisional until the full LinkedIn profile is fetched" } :
                  null;
                if (!tag) return null;
                const colour = tag.tone === "danger"
                  ? "text-danger bg-danger-subtle"
                  : "text-warning bg-warning-subtle";
                return (
                  <span title={tag.title} className={cn("text-2xs font-semibold uppercase tracking-wide rounded-sm px-1 py-0.5 hidden sm:inline-block", colour)}>
                    {tag.label}
                  </span>
                );
              })()}
              <div className="flex items-center gap-1.5">
                {/* Confidence badge — only when breakdown is present */}
                {breakdown && <ConfidenceBadge breakdown={breakdown} />}
                {!hasFetchedProfile && (
                  <FetchPriorityBadge score={candidate.fetchPriorityScore} reason={fetchPriorityReason} />
                )}
                {/* "Scored by Llama" pill — surfaced inline next to the score so
                    the recruiter sees at scan time that this was a failover
                    run with a penalised, lower-confidence score. */}
                {breakdown?.scoredBy === "ollama" && <LlamaPill context="match" />}
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
                  {/* Captured-but-not-yet-scored — Stage 1 of the capture
                      pipeline lands profileText immediately; Stage 2 (scoring)
                      can take 5–30s. Show a pulse so the recruiter sees "we
                      have the profile, score is coming" instead of just an
                      empty score badge. */}
                  {candidate.matchScore == null && candidate.profileText && candidate.profileCapturedAt && (
                    Date.now() - new Date(candidate.profileCapturedAt).getTime() < 5 * 60_000
                  ) && (
                    <span
                      title="Profile captured — AI scoring in progress"
                      className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-accent rounded-full border border-surface-raised animate-pulse"
                    />
                  )}
                  {/* Status dot: profile updated since last score */}
                  {candidate.matchScore != null && !candidate.profileTextHash && candidate.profileText && (
                    <span
                      title="Profile updated since last score — re-score recommended"
                      className="absolute -top-1 -right-1 w-2 h-2 bg-warning rounded-full border border-surface-raised"
                    />
                  )}
                  {/* Status dot: provisional score — no full profile captured yet */}
                  {candidate.matchScore != null && !hasFetchedProfile && (
                    <span
                      title="Provisional score — based on a LinkedIn snippet, not a full profile. Fetch the full profile for a reliable score."
                      className="absolute -top-1 -left-1 w-2 h-2 bg-warning rounded-full border border-surface-raised"
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
                {/* Status pill — bypass the legacy slate/blue util mapping and
                    use the token-based mapping defined at the top of this file. */}
                <Badge className={statusPillTokens(candidate.status)}>
                  {statusLabel(candidate.status)}
                </Badge>
                {contactCount > 0 && (() => {
                  const latest = candidate.contactEvents?.[0];
                  const tooltipParts: string[] = [];
                  if (latest) {
                    const typeLabel =
                      latest.type === "call"  ? "Called" :
                      latest.type === "email" ? "Emailed" :
                      latest.type === "ai_outreach_generated" ? "AI outreach drafted" :
                      "Messaged";
                    const date = new Date(latest.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
                    tooltipParts.push(`${typeLabel} by ${latest.userName} · ${date}`);
                  }
                  if (contactCount > 1) tooltipParts.push(`+${contactCount - 1} more contact${contactCount - 1 !== 1 ? "s" : ""}`);
                  return (
                    <span
                      className="inline-flex items-center gap-1 text-xs text-accent bg-accent-subtle rounded-sm px-1.5 py-0.5 font-medium cursor-default"
                      title={tooltipParts.join("\n")}
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-accent inline-block" />
                      <span className="data-mono">{contactCount}</span>
                    </span>
                  );
                })()}
              </div>
              {/* Acceptance likelihood badge */}
              <AcceptanceBadge score={candidate.acceptanceScore} data={acceptanceData} />
              {candidate.acceptanceScore != null && acceptanceData?.scoredBy === "ollama" && (
                <LlamaPill context="acceptance" />
              )}
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

      {/* Expanded details — sunken inset against the raised card surface. */}
      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-separator pt-3 bg-surface-sunken">
          {/* v2 breakdown: reasons for / against + missing evidence */}
          {breakdown && breakdown.version === 2 && (
            <>
              {(breakdown.reasons_for?.length > 0 || breakdown.reasons_against?.length > 0) && (
                <div className="grid grid-cols-2 gap-3">
                  {breakdown.reasons_for?.length > 0 && (
                    <div>
                      <p className="text-2xs font-semibold text-success uppercase tracking-wide mb-1">Reasons for</p>
                      <ul className="space-y-0.5">
                        {breakdown.reasons_for.map((r, i) => (
                          <li key={i} className="text-xs text-text-secondary flex items-start gap-1">
                            <span className="text-success mt-0.5 flex-shrink-0">✓</span>
                            {r}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {breakdown.reasons_against?.length > 0 && (
                    <div>
                      <p className="text-2xs font-semibold text-danger uppercase tracking-wide mb-1">Reasons against</p>
                      <ul className="space-y-0.5">
                        {breakdown.reasons_against.map((r, i) => (
                          <li key={i} className="text-xs text-text-secondary flex items-start gap-1">
                            <span className="text-danger mt-0.5 flex-shrink-0">✗</span>
                            {r}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {breakdown.missing_evidence?.length > 0 && (
                <div className="p-2.5 bg-warning-subtle border border-separator rounded">
                  <p className="text-2xs font-semibold text-warning uppercase tracking-wide mb-1">Missing evidence</p>
                  <ul className="space-y-0.5">
                    {breakdown.missing_evidence.map((m, i) => (
                      <li key={i} className="text-xs text-text-secondary flex items-start gap-1">
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
                  <p className="text-2xs font-semibold text-success uppercase tracking-wide mb-1">Strengths</p>
                  <ul className="space-y-0.5">
                    {matchReason.strengths.map((s, i) => (
                      <li key={i} className="text-xs text-text-secondary flex items-start gap-1">
                        <span className="text-success mt-0.5">✓</span>{s}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {matchReason.gaps && matchReason.gaps.length > 0 && (
                <div>
                  <p className="text-2xs font-semibold text-danger uppercase tracking-wide mb-1">Gaps</p>
                  <ul className="space-y-0.5">
                    {matchReason.gaps.map((g, i) => (
                      <li key={i} className="text-xs text-text-secondary flex items-start gap-1">
                        <span className="text-danger mt-0.5">✗</span>{g}
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
              <p className="text-2xs font-semibold text-text-tertiary uppercase tracking-wide">Notes</p>
              {!editingNotes && (
                <button
                  onClick={() => setEditingNotes(true)}
                  className="text-xs text-accent hover:text-accent-hover"
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
                  className="w-full text-base bg-surface-raised border border-separator rounded px-2.5 py-2 text-text-primary placeholder:text-text-tertiary resize-none focus:outline-none focus:border-accent focus:shadow-focus transition-all"
                  rows={3}
                  placeholder="Add your notes..."
                  autoFocus
                />
                <div className="flex gap-2 mt-1.5">
                  <button
                    onClick={handleSaveNotes}
                    className="text-xs text-accent font-medium hover:text-accent-hover"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => { setNotes(candidate.notes ?? ""); setEditingNotes(false); }}
                    className="text-xs text-text-tertiary hover:text-text-primary"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-xs text-text-tertiary">{notes || "No notes yet"}</p>
            )}
          </div>

          {/* LinkedIn URL */}
          {onLinkedInChange && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <p className="text-2xs font-semibold text-text-tertiary uppercase tracking-wide">LinkedIn URL</p>
                {!editingLinkedIn && (
                  <button onClick={() => { setLinkedInInput(candidate.linkedinUrl ?? ""); setEditingLinkedIn(true); }}
                    className="text-xs text-accent hover:text-accent-hover">
                    {candidate.linkedinUrl ? "Edit" : "Add"}
                  </button>
                )}
              </div>
              {editingLinkedIn ? (
                <div>
                  <input type="url" value={linkedInInput} onChange={(e) => setLinkedInInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleSaveLinkedIn(); if (e.key === "Escape") setEditingLinkedIn(false); }}
                    placeholder="https://linkedin.com/in/..." autoFocus
                    className="w-full h-7 text-base bg-surface-raised border border-separator rounded px-2.5 text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:shadow-focus transition-all"
                  />
                  <div className="flex gap-2 mt-1.5">
                    <button onClick={handleSaveLinkedIn} className="text-xs text-accent font-medium hover:text-accent-hover">Save</button>
                    <button onClick={() => setEditingLinkedIn(false)} className="text-xs text-text-tertiary hover:text-text-primary">Cancel</button>
                  </div>
                </div>
              ) : displayableLinkedinUrl(candidate.linkedinUrl) ? (
                <a href={displayableLinkedinUrl(candidate.linkedinUrl)!} target="_blank" rel="noopener noreferrer"
                  className="text-xs text-accent hover:underline truncate block max-w-full">{displayableLinkedinUrl(candidate.linkedinUrl)}</a>
              ) : (
                <p className="text-xs text-text-tertiary">No LinkedIn URL — add one to enable profile fetch</p>
              )}
            </div>
          )}

          {/* JobAdder URL */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-1.5">
                <JobAdderBadge url={null} className="w-3.5 h-3.5 text-[8px]" />
                <p className="text-2xs font-semibold text-text-tertiary uppercase tracking-wide">JobAdder</p>
              </div>
              {!editingJobAdder && (
                <button onClick={() => { setJobAdderInput(candidate.jobAdderUrl ?? ""); setJobAdderSaveError(null); setEditingJobAdder(true); }}
                  className="text-xs text-warning hover:text-warning-hover">
                  {candidate.jobAdderUrl ? "Edit" : "Link"}
                </button>
              )}
            </div>
            {editingJobAdder ? (
              <div>
                <input type="url" value={jobAdderInput} onChange={(e) => setJobAdderInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleSaveJobAdder(); if (e.key === "Escape") setEditingJobAdder(false); }}
                  placeholder="https://app.jobadder.com/candidates/..." autoFocus
                  className="w-full h-7 text-base bg-surface-raised border border-separator rounded px-2.5 text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-warning focus:shadow-focus transition-all"
                />
                <div className="flex gap-2 mt-1.5">
                  <button onClick={handleSaveJobAdder} className="text-xs text-warning font-medium hover:text-warning-hover">Save</button>
                  <button onClick={() => setEditingJobAdder(false)} className="text-xs text-text-tertiary hover:text-text-primary">Cancel</button>
                </div>
                {jobAdderSaveError && <p className="text-xs text-danger mt-1">{jobAdderSaveError}</p>}
              </div>
            ) : candidate.jobAdderUrl ? (
              <a href={candidate.jobAdderUrl} target="_blank" rel="noopener noreferrer"
                className="text-xs text-warning hover:underline truncate block max-w-full">{candidate.jobAdderUrl}</a>
            ) : (
              <p className="text-xs text-text-tertiary">Not linked — paste the JobAdder candidate URL to link</p>
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
      <div className="flex items-center gap-1 px-3 py-2 border-t border-separator bg-surface-sunken rounded-b-md">
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
            <Button size="sm" variant="ghost" onClick={() => { if (confirm(`Mark ${candidate.name} as Hired?`)) onStatusChange(candidate.id, "hired"); }} className="text-success hover:text-success hover:bg-success-subtle">Hired</Button>
            <Button size="sm" variant="ghost" onClick={() => onStatusChange(candidate.id, "declined")} className="text-text-tertiary hover:text-text-primary hover:bg-surface-hover">Declined</Button>
          </>)}
          {/* Quick "Messaged" — logs a contact event tagged to THIS job without
              expanding the card or advancing the pipeline. Useful when a
              candidate scored low but actually fits. Only shown in early funnel
              stages where messaging is the natural next action; gated on
              linkedinUrl since "messaged about this role" presumes a channel. */}
          {["new", "reviewing", "shortlisted", "contacted"].includes(candidate.status) && displayableLinkedinUrl(candidate.linkedinUrl) && (
            <Button
              size="sm"
              variant="ghost"
              onClick={handleQuickMessage}
              disabled={messageState === "saving" || messageState === "logged"}
              className={
                messageState === "logged" ? "text-success hover:text-success hover:bg-success-subtle"
                : messageState === "error" ? "text-danger hover:text-danger hover:bg-danger-subtle"
                : "text-accent hover:text-accent hover:bg-accent-subtle"
              }
              title="Log that you messaged this candidate about this role"
            >
              {messageState === "saving"
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <MessageCircle className="w-3.5 h-3.5" />}
              {messageState === "logged" ? "Logged" : messageState === "error" ? "Failed" : "Messaged"}
            </Button>
          )}
          {/* Back step */}
          {PIPELINE_BACK[candidate.status] && (() => {
            const a = PIPELINE_BACK[candidate.status];
            return <Button size="sm" variant="ghost" onClick={() => onStatusChange(candidate.id, a.to)} className={a.className}>{a.label}</Button>;
          })()}
          {/* Reject — available on all non-terminal stages. ↩ Undo button handles recovery. */}
          {!TERMINAL_STATUSES.has(candidate.status) && (
            <Button size="sm" variant="ghost" onClick={() => onStatusChange(candidate.id, "rejected")} className="text-text-tertiary hover:text-danger hover:bg-danger-subtle">
              <X className="w-3.5 h-3.5" />Reject
            </Button>
          )}
          {/* Document actions + undo for terminal statuses */}
          {["rejected","declined"].includes(candidate.status) && (
            <>
              <Button size="sm" variant="ghost" onClick={() => onStatusChange(candidate.id, "reviewing")} className="text-text-tertiary hover:text-text-primary hover:bg-surface-hover" title="Move back to reviewing">
                ↩ Undo
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setRejectionOpen(true)} className="text-text-secondary hover:text-danger hover:bg-danger-subtle" title="Draft rejection email">
                <Mail className="w-3.5 h-3.5" />Draft email
              </Button>
            </>
          )}
          {["offer_sent","hired"].includes(candidate.status) && (
            <Button size="sm" variant="ghost" onClick={() => setOfferOpen(true)} className="text-success hover:text-success hover:bg-success-subtle" title="Generate offer letter">
              <Mail className="w-3.5 h-3.5" />Offer letter
            </Button>
          )}
        </div>

        {/* Right side */}
        <div className="flex items-center gap-1 flex-shrink-0">
          {/* View profile — icon-only on mobile */}
          {hasViewableProfile && (
            <Button size="sm" variant="ghost" onClick={() => setShowProfile(true)} title="View stored LinkedIn profile">
              <FileText className="w-3.5 h-3.5" />
              <span className="hidden sm:inline ml-1">View</span>
            </Button>
          )}

          {/* Fetch profile */}
          {displayableLinkedinUrl(candidate.linkedinUrl) && (
            (fetchQueueState === "waiting" || fetchQueueState === "fetching") ? (
              <Button size="sm" variant="ghost" loading disabled className="text-accent">
                <span className="hidden sm:inline">Fetching…</span>
                <span className="sm:hidden">…</span>
              </Button>
            ) : hasFetchedProfile ? (
              <Button size="sm" variant="ghost" onClick={() => onFetchProfile(candidate.id)} title="Re-fetch LinkedIn profile" aria-label="Re-fetch LinkedIn profile">
                <RefreshCw className="w-3.5 h-3.5" />
              </Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => onFetchProfile(candidate.id)} className="text-warning hover:text-warning hover:bg-warning-subtle font-medium" title="Fetch full LinkedIn profile" aria-label="Fetch full LinkedIn profile">
                <RefreshCw className="w-3.5 h-3.5" />
                <span className="hidden sm:inline ml-1">Fetch</span>
              </Button>
            )
          )}

          {/* Score */}
          {candidate.profileText && (
            <Button size="sm" variant="ghost" onClick={() => onScore(candidate.id)} loading={scoring} className="text-accent hover:text-accent hover:bg-accent-subtle" disabled={scoring} aria-label={candidate.matchScore != null ? "Re-score this candidate" : "Score this candidate"}>
              {!scoring && <Loader2 className="w-3.5 h-3.5" />}
              <span className="hidden sm:inline ml-1">{candidate.matchScore != null ? "Re-score" : "Score"}</span>
            </Button>
          )}

          {/* Send outreach — hidden on mobile, accessible via expand */}
          {candidate.profileText && (
            <Button size="sm" variant="ghost" onClick={() => setOutreachOpen(true)} className="hidden sm:flex" title="Generate outreach message">
              <Send className="w-3.5 h-3.5" />
            </Button>
          )}

          {/* Notes — icon only */}
          <Button size="sm" variant="ghost" onClick={() => setEditingNotes(true)} title="Edit notes" aria-label="Edit notes">
            <MessageSquare className="w-3.5 h-3.5" />
          </Button>

          {/* Expand/collapse */}
          <Button size="sm" variant="ghost" onClick={() => setExpanded(!expanded)} title={expanded ? "Collapse" : "Expand"} aria-label={expanded ? "Collapse candidate details" : "Expand candidate details"} aria-expanded={expanded}>
            {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </Button>

          {/* Delete */}
          <Button size="sm" variant="ghost" onClick={() => onDelete(candidate.id)} className="hover:text-danger hover:bg-danger-subtle" title="Delete candidate" aria-label="Delete candidate">
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
        />
      )}
    </div>
  );
});

CandidateCard.displayName = "CandidateCard";
