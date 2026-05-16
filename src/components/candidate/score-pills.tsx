"use client";

import { useRef, useState } from "react";
import { MapPin, TrendingUp, Minus, TrendingDown, CheckCircle2, XCircle, Gauge } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ScoreBreakdown } from "@/lib/scoring";
import { locationFitBadge } from "./helpers";
import { provenancePillProps } from "../provenance-pill-props";
import { isPlausibleLocation } from "@/lib/location";

// Score pill primitives extracted from candidate-card.tsx to keep that
// file under control (was 1,743 lines with 5+ sub-components inline).
// These all take pure props — no parent-state coupling.

export interface AcceptanceSignal {
  label: string;
  positive: boolean;
}

export interface AcceptanceData {
  likelihood: "high" | "medium" | "low";
  headline: string;
  signals: AcceptanceSignal[];
  summary: string;
  /** Mirrors AcceptancePrediction.scoredBy on the server. Drives the
   *  provenance pill next to the acceptance score so the recruiter can
   *  see whether Claude or OpenAI produced the likelihood. */
  scoredBy?: "claude" | "openai";
}

export interface FetchPriorityReason {
  label?: string;
  summary?: string;
  signals?: string[];
  risks?: string[];
  matchedTerms?: string[];
}

// ─── Location fit pill ────────────────────────────────────────────────────

export function LocationFitPill({
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

// ─── Provenance pill ──────────────────────────────────────────────────────

export function ProvenancePill({
  source,
  context,
}: {
  source: "claude" | "openai" | undefined | null;
  context: "match" | "acceptance";
}) {
  const props = provenancePillProps(source, context);
  if (!props) return null;
  const toneClass =
    props.tone === "openai"
      ? "bg-success-subtle text-success"
      : "bg-accent-subtle text-accent";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-xs font-medium",
        toneClass,
      )}
      title={props.title}
    >
      {props.label}
    </span>
  );
}

// ─── Acceptance badge ─────────────────────────────────────────────────────

export function AcceptanceBadge({
  score,
  data,
}: {
  score: number | null;
  data: AcceptanceData | null;
}) {
  const [showDetail, setShowDetail] = useState(false);
  const [tooltipPos, setTooltipPos] = useState({ top: 0, right: 0 });
  const badgeRef = useRef<HTMLButtonElement>(null);

  if (score == null) return null;
  const level = score >= 70 ? "high" : score >= 40 ? "medium" : "low";
  const config = {
    high:   { pill: "bg-success-subtle text-success", label: "Likely open",  Icon: TrendingUp },
    medium: { pill: "bg-warning-subtle text-warning", label: "May consider", Icon: Minus },
    low:    { pill: "bg-surface-hover  text-text-tertiary", label: "Hard to move", Icon: TrendingDown },
  }[level];

  const openDetail = () => {
    if (!data) return;
    if (badgeRef.current) {
      const rect = badgeRef.current.getBoundingClientRect();
      setTooltipPos({ top: rect.bottom + 8, right: window.innerWidth - rect.right });
    }
    setShowDetail(true);
  };

  return (
    <>
      <button
        ref={badgeRef}
        type="button"
        onMouseEnter={openDetail}
        onMouseLeave={() => setShowDetail(false)}
        onFocus={openDetail}
        onBlur={() => setShowDetail(false)}
        onClick={() => (showDetail ? setShowDetail(false) : openDetail())}
        aria-expanded={showDetail}
        aria-haspopup="dialog"
        aria-label={`Offer acceptance likelihood: ${config.label} (${score}%). Click for details.`}
        className={cn(
          "inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-sm font-medium text-left",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent",
          config.pill,
        )}
      >
        <config.Icon className="w-3 h-3" />
        {config.label}
      </button>

      {showDetail && data && (
        <div
          className="w-72 bg-surface-overlay text-text-primary rounded-md shadow-overlay overflow-hidden border border-separator"
          style={{ position: "fixed", top: tooltipPos.top, right: tooltipPos.right, zIndex: 9999 }}
          onMouseEnter={() => setShowDetail(true)}
          onMouseLeave={() => setShowDetail(false)}
        >
          <div className="px-3 pt-2.5 pb-2 border-b border-separator">
            <p className="text-2xs font-semibold text-text-tertiary uppercase tracking-wide mb-1">Offer Acceptance Likelihood</p>
            <p className="text-sm font-medium text-text-primary leading-snug">{data.headline}</p>
          </div>
          {data.signals.length > 0 && (
            <div className="px-3 py-2 space-y-1.5 border-b border-separator">
              {data.signals.map((s, i) => (
                <div key={i} className="flex items-start gap-2">
                  {s.positive
                    ? <CheckCircle2 className="w-3.5 h-3.5 text-success flex-shrink-0 mt-0.5" />
                    : <XCircle      className="w-3.5 h-3.5 text-danger  flex-shrink-0 mt-0.5" />}
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

// ─── Confidence badge ─────────────────────────────────────────────────────

export function ConfidenceBadge({ breakdown }: { breakdown: ScoreBreakdown }) {
  const [show, setShow] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
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

  const openDetail = () => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 6, right: window.innerWidth - rect.right });
    }
    setShow(true);
  };

  return (
    <>
      <button
        ref={ref}
        type="button"
        onMouseEnter={openDetail}
        onMouseLeave={() => setShow(false)}
        onFocus={openDetail}
        onBlur={() => setShow(false)}
        onClick={() => (show ? setShow(false) : openDetail())}
        aria-expanded={show}
        aria-haspopup="dialog"
        aria-label={`Scoring confidence: ${cfg.label} (${confidence.score}%). Click for reasons.`}
        className={cn(
          "inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-sm font-medium leading-none text-left",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent",
          cfg.pill,
        )}
      >
        <span className="text-[10px]">◎</span>
        <span className="data-mono">{confidence.score}%</span>
      </button>

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

// ─── Fetch priority badge ─────────────────────────────────────────────────

export function FetchPriorityBadge({
  score,
  reason,
}: {
  score: number | null | undefined;
  reason: FetchPriorityReason | null;
}) {
  const [show, setShow] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
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

  const openDetail = () => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 6, right: window.innerWidth - rect.right });
    }
    setShow(true);
  };

  return (
    <>
      <button
        ref={ref}
        type="button"
        onMouseEnter={openDetail}
        onMouseLeave={() => setShow(false)}
        onFocus={openDetail}
        onBlur={() => setShow(false)}
        onClick={() => (show ? setShow(false) : openDetail())}
        aria-expanded={show}
        aria-haspopup="dialog"
        aria-label={`Fetch priority: ${cfg.label} (${score}%). Click for evidence.`}
        className={cn(
          "inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-sm font-medium leading-none text-left",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent",
          cfg.pill,
        )}
      >
        <Gauge className="w-3 h-3" />
        <span>Fetch <span className="data-mono">{score}%</span></span>
      </button>

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
