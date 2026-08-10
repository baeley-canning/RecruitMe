"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  MapPin,
  Briefcase,
  Star,
  Printer,
  ExternalLink,
  CheckCircle2,
  XCircle,
  TrendingUp,
  Minus,
  TrendingDown,
  Loader2,
  Users,
  DollarSign,
  FileText,
} from "lucide-react";
import { ScoreBadge } from "@/components/score-badge";
import { ShareShortlistButton } from "@/components/job/share-shortlist-button";
import { ClientReportModal } from "@/components/job/client-report-modal";
import { displayableLinkedinUrl } from "@/components/candidate/helpers";
import { cn, safeParseJson } from "@/lib/utils";
import { scoreTier } from "@/lib/score-utils";
import type { ParsedRole } from "@/lib/ai";
import type { ScoreBreakdown } from "@/lib/scoring";

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

interface MatchData {
  summary?: string;
  strengths?: string[];
  gaps?: string[];
}

interface Candidate {
  id: string;
  name: string;
  headline: string | null;
  location: string | null;
  linkedinUrl: string | null;
  jobAdderUrl: string | null;
  matchScore: number | null;
  matchReason: string | null;
  scoreBreakdown: string | null;
  acceptanceScore: number | null;
  acceptanceReason: string | null;
  notes: string | null;
  status: string;
}

interface Job {
  id: string;
  title: string;
  company: string | null;
  location: string | null;
  parsedRole: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  candidates: Candidate[];
}

function AcceptancePill({ score }: { score: number | null }) {
  if (score == null) return null;
  // Bucketing via canonical helper (70/40 for "acceptance"). Colours and
  // labels are bespoke to the shortlist context — recruiter is deciding
  // whether to ping, so "low" warrants a stronger visual than the neutral
  // grey AcceptanceBadge uses in the candidate-card.
  const tier = scoreTier(score, "acceptance");
  const config = {
    strong: { cls: "bg-success-subtle text-success", label: "Likely open",  Icon: TrendingUp },
    fair:   { cls: "bg-warning-subtle text-warning", label: "May consider", Icon: Minus },
    weak:   { cls: "bg-danger-subtle text-danger",   label: "Hard to move", Icon: TrendingDown },
    poor:   { cls: "bg-danger-subtle text-danger",   label: "Hard to move", Icon: TrendingDown },
  }[tier];
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-sm font-medium", config.cls)}>
      <config.Icon className="w-3 h-3" />
      {config.label}
    </span>
  );
}

function CandidateBrief({
  candidate,
  rank,
  onRemove,
}: {
  candidate: Candidate;
  rank: number;
  onRemove: (id: string) => void;
}) {
  const match = safeParseJson<MatchData | null>(candidate.matchReason, null);
  const breakdown = safeParseJson<ScoreBreakdown | null>(candidate.scoreBreakdown, null);
  const acceptance = safeParseJson<AcceptanceData | null>(candidate.acceptanceReason, null);

  return (
    <div className="bg-surface-raised border border-separator rounded-md overflow-hidden print:shadow-none print:border print:rounded-none print:break-inside-avoid">
      <div className="p-4">
        {/* Identity + scores */}
        <div className="flex items-start justify-between gap-4 mb-3">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-full bg-accent-subtle flex items-center justify-center flex-shrink-0 text-accent font-semibold text-xs print:hidden">
              {candidate.name.split(" ").map((w: string) => w[0]).slice(0, 2).join("").toUpperCase()}
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-text-primary text-md">
                  <span className="data-mono text-text-tertiary">#{rank}</span> — {candidate.name}
                </span>
                {displayableLinkedinUrl(candidate.linkedinUrl) && (
                  <a
                    href={displayableLinkedinUrl(candidate.linkedinUrl)!}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent hover:text-accent-hover transition-colors print:hidden"
                    title="LinkedIn profile"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                )}
                {candidate.linkedinUrl && (
                  <span className="hidden print:inline text-xs text-text-tertiary">{candidate.linkedinUrl}</span>
                )}
                {candidate.jobAdderUrl && /^https?:\/\//i.test(candidate.jobAdderUrl) && (
                  <a
                    href={candidate.jobAdderUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center w-5 h-5 rounded-xs text-2xs font-semibold bg-warning text-text-inverse hover:opacity-80 transition-opacity print:hidden"
                    title="Open in JobAdder"
                  >
                    JA
                  </a>
                )}
              </div>
              {candidate.headline && (
                <p className="text-sm text-text-secondary mt-0.5">{candidate.headline}</p>
              )}
              {candidate.location && (
                <div className="flex items-center gap-1 mt-0.5">
                  <MapPin className="w-3 h-3 text-text-tertiary" />
                  <span className="text-xs text-text-tertiary">{candidate.location}</span>
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
            <ScoreBadge score={candidate.matchScore} size="lg" />
            <AcceptancePill score={candidate.acceptanceScore} />
          </div>
        </div>

        {/* AI summary */}
        {(breakdown?.recruiter_summary || match?.summary) && (
          <blockquote className="text-sm text-text-secondary italic border-l-2 border-accent/50 pl-3 mb-3 leading-relaxed">
            {breakdown?.recruiter_summary ?? match?.summary}
          </blockquote>
        )}

        {/* Strengths & gaps */}
        {((breakdown?.reasons_for?.length || breakdown?.reasons_against?.length) || match?.strengths?.length || match?.gaps?.length) && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-3 print:grid-cols-2">
            {((breakdown?.reasons_for?.length ?? 0) > 0 || (match?.strengths?.length ?? 0) > 0) && (
              <div>
                <p className="text-2xs font-semibold text-success uppercase tracking-wide mb-2">Strengths</p>
                <ul className="space-y-1">
                  {(breakdown?.reasons_for ?? match?.strengths ?? []).map((s, i) => (
                    <li key={i} className="flex items-start gap-1.5 text-xs text-text-primary">
                      <CheckCircle2 className="w-3.5 h-3.5 text-success flex-shrink-0 mt-0.5" />
                      {s}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {((breakdown?.reasons_against?.length ?? 0) > 0 || (match?.gaps?.length ?? 0) > 0) && (
              <div>
                <p className="text-2xs font-semibold text-danger uppercase tracking-wide mb-2">Gaps</p>
                <ul className="space-y-1">
                  {(breakdown?.reasons_against ?? match?.gaps ?? []).map((g, i) => (
                    <li key={i} className="flex items-start gap-1.5 text-xs text-text-primary">
                      <XCircle className="w-3.5 h-3.5 text-danger flex-shrink-0 mt-0.5" />
                      {g}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Acceptance signals */}
        {acceptance && acceptance.signals.length > 0 && (
          <div className="mb-3 p-3 bg-surface-sunken rounded-md border border-separator">
            <p className="text-2xs font-semibold text-text-tertiary uppercase tracking-wide mb-1.5">
              Offer Acceptance Signals
            </p>
            <p className="text-xs text-text-secondary italic mb-2">{acceptance.headline}</p>
            <div className="space-y-1">
              {acceptance.signals.map((s, i) => (
                <div key={i} className="flex items-start gap-1.5">
                  {s.positive
                    ? <CheckCircle2 className="w-3.5 h-3.5 text-success flex-shrink-0 mt-0.5" />
                    : <XCircle className="w-3.5 h-3.5 text-danger flex-shrink-0 mt-0.5" />}
                  <span className="text-xs text-text-secondary">{s.label}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Recruiter notes */}
        {candidate.notes && (
          <div className="mb-3 p-3 bg-warning-subtle border border-separator rounded-md">
            <p className="text-2xs font-semibold text-warning uppercase tracking-wide mb-1">Recruiter Notes</p>
            <p className="text-xs text-text-primary leading-relaxed">{candidate.notes}</p>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-between pt-3 border-t border-separator print:hidden">
          {displayableLinkedinUrl(candidate.linkedinUrl) ? (
            <a
              href={displayableLinkedinUrl(candidate.linkedinUrl)!}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-accent hover:text-accent-hover font-medium transition-colors"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              View LinkedIn profile
            </a>
          ) : <span />}
          <button
            onClick={() => onRemove(candidate.id)}
            className="text-xs text-text-tertiary hover:text-danger transition-colors"
          >
            Remove from shortlist
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ShortlistPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [job, setJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(true);
  const [showClientReport, setShowClientReport] = useState(false);

  const fetchJob = async () => {
    const res = await fetch(`/api/jobs/${id}`);
    if (res.status === 401 || res.status === 403) {
      window.location.href = "/login";
      return;
    }
    if (res.ok) setJob(await res.json() as Job);
    setLoading(false);
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { fetchJob(); }, []);

  const handleRemove = async (candidateId: string) => {
    await fetch(`/api/jobs/${id}/candidates/${candidateId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "reviewing" }),
    });
    await fetchJob();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 text-accent animate-spin" />
      </div>
    );
  }

  if (!job) {
    return <div className="p-6 text-center text-text-tertiary">Job not found.</div>;
  }

  const shortlisted = job.candidates
    .filter((c) => c.status === "shortlisted")
    .sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0));

  const parsedRole = safeParseJson<ParsedRole | null>(job.parsedRole, null);

  const avgScore = shortlisted.length
    ? Math.round(shortlisted.reduce((s, c) => s + (c.matchScore ?? 0), 0) / shortlisted.length)
    : null;

  const highAcceptance = shortlisted.filter((c) => scoreTier(c.acceptanceScore ?? 0, "acceptance") === "strong").length;

  return (
    <>
    <div className="bg-surface-base min-h-screen">
      <div className="p-4 sm:p-6 max-w-4xl mx-auto print:p-0 print:max-w-none">
      {/* Nav bar — hidden on print */}
      <div className="flex items-center justify-between mb-5 print:hidden">
        <Link
          href={`/jobs/${id}`}
          className="inline-flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to {job.title}
        </Link>
        <div className="flex items-center gap-1.5">
          <ShareShortlistButton jobId={id} shortlistCount={shortlisted.length} />
          {shortlisted.length > 0 && (
            <button
              onClick={() => setShowClientReport(true)}
              className="inline-flex items-center gap-1.5 h-7 px-3 rounded bg-surface-hover hover:bg-surface-hover-strong text-text-primary text-md font-medium border border-separator transition-colors"
            >
              <FileText className="w-3.5 h-3.5" />
              Client Report
            </button>
          )}
          <button
            onClick={() => window.print()}
            className="inline-flex items-center gap-1.5 h-7 px-3 rounded bg-surface-hover hover:bg-surface-hover-strong text-text-primary text-md font-medium border border-separator transition-colors"
          >
            <Printer className="w-3.5 h-3.5" />
            Print / Save PDF
          </button>
        </div>
      </div>

      {/* Header */}
      <div className="mb-5 print:mb-6">
        <div className="flex items-center gap-2 text-2xs text-text-tertiary uppercase tracking-widest font-medium mb-2">
          <Star className="w-3.5 h-3.5 text-warning" />
          Candidate Shortlist
        </div>
        <h1 className="text-xl font-semibold text-text-primary mb-2 print:text-2xl">{job.title}</h1>
        <div className="flex items-center gap-4 text-sm text-text-secondary flex-wrap">
          {job.company && (
            <span className="flex items-center gap-1">
              <Briefcase className="w-3.5 h-3.5 text-text-tertiary" />
              {job.company}
            </span>
          )}
          {job.location && (
            <span className="flex items-center gap-1">
              <MapPin className="w-3.5 h-3.5 text-text-tertiary" />
              {job.location}
            </span>
          )}
          {(job.salaryMin || job.salaryMax) && (
            <span className="flex items-center gap-1 data-mono">
              <DollarSign className="w-3.5 h-3.5 text-text-tertiary" />
              {job.salaryMin && job.salaryMax
                ? `$${(job.salaryMin / 1000).toFixed(0)}k–$${(job.salaryMax / 1000).toFixed(0)}k NZD`
                : job.salaryMin
                ? `From $${(job.salaryMin / 1000).toFixed(0)}k NZD`
                : `Up to $${(job.salaryMax! / 1000).toFixed(0)}k NZD`}
            </span>
          )}
        </div>
        <p className="text-xs text-text-tertiary mt-3 hidden print:block" suppressHydrationWarning>
          Prepared {new Date().toLocaleDateString("en-NZ", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
        </p>
      </div>

      {/* Stats strip */}
      {shortlisted.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5 print:mb-6 print:grid-cols-3">
          {[
            { icon: <Users className="w-4 h-4 text-accent" />, value: shortlisted.length, label: "Shortlisted" },
            { icon: <Star className="w-4 h-4 text-warning" />, value: avgScore != null ? `${avgScore}%` : "—", label: "Avg. match score" },
            { icon: <TrendingUp className="w-4 h-4 text-success" />, value: highAcceptance, label: "Likely to accept" },
          ].map(({ icon, value, label }) => (
            <div key={label} className="bg-surface-raised border border-separator rounded-md p-3 text-center print:rounded-none">
              <div className="flex justify-center mb-1 print:hidden">{icon}</div>
              <p className="text-xl font-semibold text-text-primary data-mono print:text-xl">{value}</p>
              <p className="text-xs text-text-secondary mt-0.5">{label}</p>
            </div>
          ))}
        </div>
      )}

      {/* Role context — print only */}
      {parsedRole && (
        <div className="hidden print:block mb-6 p-4 border border-separator rounded">
          <p className="text-2xs font-semibold text-text-tertiary uppercase tracking-wide mb-2">Role Requirements</p>
          <div className="text-sm space-y-1">
            {parsedRole.experience && <p><span className="text-text-tertiary">Experience: </span>{parsedRole.experience}</p>}
            {parsedRole.location && <p><span className="text-text-tertiary">Location: </span>{parsedRole.location}</p>}
            {parsedRole.skills_required.length > 0 && (
              <p><span className="text-text-tertiary">Required skills: </span>{parsedRole.skills_required.join(", ")}</p>
            )}
          </div>
        </div>
      )}

      {/* Candidate list */}
      {shortlisted.length === 0 ? (
        <div className="text-center py-12 bg-surface-raised rounded-md border border-dashed border-separator">
          <Star className="w-10 h-10 text-text-tertiary mx-auto mb-3" />
          <p className="text-text-primary font-medium">No candidates shortlisted yet</p>
          <p className="text-text-tertiary text-sm mt-1">
            Go back and star candidates to add them here.
          </p>
          <Link
            href={`/jobs/${id}`}
            className="inline-flex items-center gap-1.5 mt-4 text-sm text-accent hover:text-accent-hover font-medium"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to candidates
          </Link>
        </div>
      ) : (
        <div className="space-y-3 print:space-y-6">
          {shortlisted.map((candidate, i) => (
            <CandidateBrief
              key={candidate.id}
              candidate={candidate}
              rank={i + 1}
              onRemove={handleRemove}
            />
          ))}
        </div>
      )}

      {/* Print footer */}
      <div className="hidden print:block mt-10 pt-4 border-t border-separator text-xs text-text-tertiary text-center">
        Generated by RecruitMe · {new Date().getFullYear()}
      </div>
      </div>
    </div>

    {showClientReport && job && (
      <ClientReportModal
        jobId={id}
        jobTitle={job.title}
        jobParsedRole={job.parsedRole}
        candidates={shortlisted.map((c) => ({ ...c, profileText: null }))}
        onClose={() => setShowClientReport(false)}
      />
    )}
    </>
  );
}
