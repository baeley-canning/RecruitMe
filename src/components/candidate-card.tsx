"use client";

import { useState, useRef } from "react";
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
import type { ScoreDimensions } from "./score-radar";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { cn, statusLabel, statusBadge, safeParseJson, timeAgo } from "@/lib/utils";

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
  matchScore: number | null;
  matchReason: string | null;
  acceptanceScore: number | null;
  acceptanceReason: string | null;
  notes: string | null;
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
  onDelete: (id: string) => void;
  scoring?: boolean;
  fetchingProfile?: boolean;
}

interface OutreachMessage {
  linkedin: string;
  email: string;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button
      onClick={handleCopy}
      className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 transition-colors"
    >
      {copied ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
      {copied ? "Copied!" : "Copy"}
    </button>
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

export function CandidateCard({
  candidate,
  jobId,
  onStatusChange,
  onScore,
  onFetchProfile,
  onNotesChange,
  onDelete,
  scoring = false,
  fetchingProfile = false,
}: CandidateCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [showReasoning, setShowReasoning] = useState(false);
  const [showRadar, setShowRadar] = useState(false);
  const [radarPos, setRadarPos] = useState({ top: 0, right: 0 });
  const scoreBadgeRef = useRef<HTMLDivElement>(null);
  const [editingNotes, setEditingNotes] = useState(false);
  const [notes, setNotes] = useState(candidate.notes ?? "");
  const [outreachOpen, setOutreachOpen] = useState(false);
  const [outreachLoading, setOutreachLoading] = useState(false);
  const [outreachData, setOutreachData] = useState<OutreachMessage | null>(null);
  const [outreachError, setOutreachError] = useState("");
  const [outreachTab, setOutreachTab] = useState<"linkedin" | "email">("linkedin");

  const handleGenerateOutreach = async () => {
    setOutreachOpen(true);
    if (outreachData) return; // already generated
    setOutreachLoading(true);
    setOutreachError("");
    try {
      const res = await fetch(`/api/jobs/${jobId}/candidates/${candidate.id}/outreach`, {
        method: "POST",
      });
      const data = await res.json() as OutreachMessage & { error?: string };
      if (!res.ok || data.error) {
        setOutreachError(data.error ?? "Generation failed");
      } else {
        setOutreachData(data);
      }
    } catch {
      setOutreachError("Failed to generate message. Check Ollama is running.");
    } finally {
      setOutreachLoading(false);
    }
  };

  const matchReason = safeParseJson<{
    summary?: string;
    reasoning?: string;
    dimensions?: ScoreDimensions;
    strengths?: string[];
    gaps?: string[];
  } | null>(candidate.matchReason, null);

  const acceptanceData = safeParseJson<AcceptanceData | null>(candidate.acceptanceReason, null);

  const handleSaveNotes = () => {
    onNotesChange(candidate.id, notes);
    setEditingNotes(false);
  };

  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-sm hover:shadow-md transition-shadow">
      {/* Header row */}
      <div className="flex items-start gap-3 p-4">
        {/* Avatar */}
        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center flex-shrink-0 text-white font-semibold text-sm">
          {candidate.name.charAt(0).toUpperCase()}
        </div>

        {/* Main info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-slate-900 text-sm leading-snug">
                  {candidate.name}
                </span>
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
                <div className="flex items-center gap-1 mt-0.5">
                  <MapPin className="w-3 h-3 text-slate-400" />
                  <span className="text-xs text-slate-400">{candidate.location}</span>
                </div>
              )}
            </div>

            <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
              <div className="flex items-center gap-2">
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
                {showRadar && matchReason?.dimensions && (
                  <div
                    style={{ position: "fixed", top: radarPos.top, right: radarPos.right, zIndex: 9999 }}
                    onMouseEnter={() => setShowRadar(true)}
                    onMouseLeave={() => setShowRadar(false)}
                  >
                    <ScoreRadar dimensions={matchReason.dimensions} />
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
      {matchReason?.summary && (
        <div className="px-4 pb-2">
          <div className="flex items-start justify-between gap-2">
            <p className="text-xs text-slate-600 leading-relaxed italic flex-1">
              &ldquo;{matchReason.summary}&rdquo;
            </p>
            {matchReason.reasoning && (
              <button
                onClick={() => setShowReasoning((v) => !v)}
                className="text-xs text-blue-600 hover:text-blue-700 whitespace-nowrap flex items-center gap-0.5 flex-shrink-0 mt-0.5 font-medium"
              >
                Why?
                <ChevronDown className={cn("w-3 h-3 transition-transform", showReasoning && "rotate-180")} />
              </button>
            )}
          </div>
          {showReasoning && matchReason.reasoning && (
            <div className="mt-2 p-3 bg-blue-50 border border-blue-100 rounded-lg">
              <p className="text-xs font-medium text-blue-800 mb-1">AI Assessment</p>
              <p className="text-xs text-slate-700 leading-relaxed">{matchReason.reasoning}</p>
            </div>
          )}
        </div>
      )}

      {/* Expanded details */}
      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-slate-100 pt-3">
          {matchReason && (
            <div className="grid grid-cols-2 gap-3">
              {matchReason.strengths && matchReason.strengths.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-emerald-700 mb-1">Strengths</p>
                  <ul className="space-y-0.5">
                    {matchReason.strengths.map((s, i) => (
                      <li key={i} className="text-xs text-slate-600 flex items-start gap-1">
                        <span className="text-emerald-500 mt-0.5">✓</span>
                        {s}
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
                        <span className="text-red-400 mt-0.5">✗</span>
                        {g}
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
        </div>

        {/* Right side */}
        <div className="flex items-center gap-1">
          {/* Fetch full profile — shown when only a snippet is stored or no score yet */}
          {candidate.linkedinUrl && (!candidate.profileText || candidate.profileText.length < 500) && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onFetchProfile(candidate.id)}
              loading={fetchingProfile}
              disabled={fetchingProfile}
              className="text-slate-500 hover:text-blue-600 hover:bg-blue-50"
              title="Fetch full LinkedIn profile and rescore"
            >
              {!fetchingProfile && <RefreshCw className="w-3.5 h-3.5" />}
              {fetchingProfile ? "Fetching…" : "Fetch profile"}
            </Button>
          )}
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
              onClick={handleGenerateOutreach}
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

      {/* Outreach modal */}
      {outreachOpen && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <div>
                <h3 className="font-semibold text-slate-900">Outreach Message</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Personalised for {candidate.name}
                </p>
              </div>
              <button
                onClick={() => setOutreachOpen(false)}
                className="text-slate-400 hover:text-slate-700 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="px-6 py-5">
              {outreachLoading && (
                <div className="flex items-center gap-2 text-sm text-slate-500 py-6 justify-center">
                  <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
                  Generating personalised message…
                </div>
              )}

              {outreachError && (
                <p className="text-sm text-red-600 py-4 text-center">{outreachError}</p>
              )}

              {outreachData && (
                <div className="space-y-4">
                  {/* Tab switcher */}
                  <div className="flex gap-1 p-1 bg-slate-100 rounded-lg">
                    {(["linkedin", "email"] as const).map((tab) => (
                      <button
                        key={tab}
                        onClick={() => setOutreachTab(tab)}
                        className={cn(
                          "flex-1 py-1.5 text-xs font-medium rounded-md transition-colors capitalize",
                          outreachTab === tab
                            ? "bg-white text-slate-900 shadow-sm"
                            : "text-slate-500 hover:text-slate-700"
                        )}
                      >
                        {tab === "linkedin" ? "LinkedIn message" : "Email"}
                      </button>
                    ))}
                  </div>

                  {outreachTab === "linkedin" && (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-xs font-medium text-slate-500">
                          Connection request · {outreachData.linkedin.length}/300 chars
                        </p>
                        <CopyButton text={outreachData.linkedin} />
                      </div>
                      <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-800 leading-relaxed whitespace-pre-wrap">
                        {outreachData.linkedin}
                      </div>
                      <p className="text-xs text-slate-400 mt-2">
                        Paste this into the LinkedIn "Add a note" field when sending a connection request.
                      </p>
                    </div>
                  )}

                  {outreachTab === "email" && (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-xs font-medium text-slate-500">Full email</p>
                        <CopyButton text={outreachData.email} />
                      </div>
                      <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-800 leading-relaxed whitespace-pre-wrap">
                        {outreachData.email}
                      </div>
                    </div>
                  )}

                  <button
                    onClick={() => { setOutreachData(null); handleGenerateOutreach(); }}
                    className="text-xs text-blue-600 hover:text-blue-700 font-medium"
                  >
                    Regenerate
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
