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
} from "lucide-react";
import { ScoreBadge } from "@/components/score-badge";
import { cn, safeParseJson } from "@/lib/utils";
import type { ParsedRole } from "@/lib/ai";

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
  matchScore: number | null;
  matchReason: string | null;
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
  const level = score >= 70 ? "high" : score >= 40 ? "medium" : "low";
  const config = {
    high:   { cls: "bg-emerald-50 text-emerald-700 border-emerald-200", label: "Likely open",  Icon: TrendingUp },
    medium: { cls: "bg-amber-50 text-amber-700 border-amber-200",       label: "May consider", Icon: Minus },
    low:    { cls: "bg-red-50 text-red-600 border-red-100",             label: "Hard to move", Icon: TrendingDown },
  }[level];
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border font-medium", config.cls)}>
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
  const acceptance = safeParseJson<AcceptanceData | null>(candidate.acceptanceReason, null);

  return (
    <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden print:shadow-none print:border-slate-300 print:rounded-none print:break-inside-avoid">
      <div className="h-1 bg-gradient-to-r from-blue-500 to-blue-400 print:hidden" />

      <div className="p-6">
        {/* Identity + scores */}
        <div className="flex items-start justify-between gap-4 mb-4">
          <div className="flex items-start gap-3">
            <div className="w-11 h-11 rounded-full bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center flex-shrink-0 text-white font-bold print:hidden">
              {candidate.name.charAt(0).toUpperCase()}
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-bold text-slate-900 text-base">
                  #{rank} — {candidate.name}
                </span>
                {candidate.linkedinUrl && (
                  <a
                    href={candidate.linkedinUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[#0A66C2] hover:opacity-80 transition-opacity print:hidden"
                    title="LinkedIn profile"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                )}
                {candidate.linkedinUrl && (
                  <span className="hidden print:inline text-xs text-slate-400">{candidate.linkedinUrl}</span>
                )}
              </div>
              {candidate.headline && (
                <p className="text-sm text-slate-600 mt-0.5">{candidate.headline}</p>
              )}
              {candidate.location && (
                <div className="flex items-center gap-1 mt-0.5">
                  <MapPin className="w-3 h-3 text-slate-400" />
                  <span className="text-xs text-slate-400">{candidate.location}</span>
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
        {match?.summary && (
          <blockquote className="text-sm text-slate-600 italic border-l-2 border-blue-200 pl-3 mb-4 leading-relaxed">
            {match.summary}
          </blockquote>
        )}

        {/* Strengths & gaps */}
        {(match?.strengths?.length || match?.gaps?.length) && (
          <div className="grid grid-cols-2 gap-4 mb-4">
            {match?.strengths && match.strengths.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-emerald-700 uppercase tracking-wide mb-2">Strengths</p>
                <ul className="space-y-1">
                  {match.strengths.map((s, i) => (
                    <li key={i} className="flex items-start gap-1.5 text-xs text-slate-700">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0 mt-0.5" />
                      {s}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {match?.gaps && match.gaps.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-red-600 uppercase tracking-wide mb-2">Gaps</p>
                <ul className="space-y-1">
                  {match.gaps.map((g, i) => (
                    <li key={i} className="flex items-start gap-1.5 text-xs text-slate-700">
                      <XCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0 mt-0.5" />
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
          <div className="mb-4 p-3 bg-slate-50 rounded-xl border border-slate-100">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
              Offer Acceptance Signals
            </p>
            <p className="text-xs text-slate-600 italic mb-2">{acceptance.headline}</p>
            <div className="space-y-1">
              {acceptance.signals.map((s, i) => (
                <div key={i} className="flex items-start gap-1.5">
                  {s.positive
                    ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0 mt-0.5" />
                    : <XCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0 mt-0.5" />}
                  <span className="text-xs text-slate-600">{s.label}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Recruiter notes */}
        {candidate.notes && (
          <div className="mb-4 p-3 bg-amber-50 border border-amber-100 rounded-xl">
            <p className="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-1">Recruiter Notes</p>
            <p className="text-xs text-slate-700 leading-relaxed">{candidate.notes}</p>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-between pt-3 border-t border-slate-100 print:hidden">
          {candidate.linkedinUrl ? (
            <a
              href={candidate.linkedinUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-[#0A66C2] hover:opacity-80 font-medium transition-opacity"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              View LinkedIn profile
            </a>
          ) : <span />}
          <button
            onClick={() => onRemove(candidate.id)}
            className="text-xs text-slate-400 hover:text-red-600 transition-colors"
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

  const fetchJob = async () => {
    const res = await fetch(`/api/jobs/${id}`);
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
        <Loader2 className="w-6 h-6 text-blue-500 animate-spin" />
      </div>
    );
  }

  if (!job) {
    return <div className="p-8 text-center text-slate-500">Job not found.</div>;
  }

  const shortlisted = job.candidates
    .filter((c) => c.status === "shortlisted")
    .sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0));

  const parsedRole = safeParseJson<ParsedRole | null>(job.parsedRole, null);

  const avgScore = shortlisted.length
    ? Math.round(shortlisted.reduce((s, c) => s + (c.matchScore ?? 0), 0) / shortlisted.length)
    : null;

  const highAcceptance = shortlisted.filter((c) => (c.acceptanceScore ?? 0) >= 70).length;

  return (
    <div className="p-8 max-w-4xl mx-auto print:p-0 print:max-w-none">
      {/* Nav bar — hidden on print */}
      <div className="flex items-center justify-between mb-8 print:hidden">
        <Link
          href={`/jobs/${id}`}
          className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to {job.title}
        </Link>
        <button
          onClick={() => window.print()}
          className="inline-flex items-center gap-2 px-4 py-2 border border-slate-300 text-slate-700 hover:bg-slate-50 rounded-lg text-sm font-medium transition-colors"
        >
          <Printer className="w-4 h-4" />
          Print / Save PDF
        </button>
      </div>

      {/* Header */}
      <div className="mb-8 print:mb-6">
        <div className="flex items-center gap-2 text-xs text-slate-400 uppercase tracking-widest font-medium mb-2">
          <Star className="w-3.5 h-3.5 text-amber-500" />
          Candidate Shortlist
        </div>
        <h1 className="text-3xl font-bold text-slate-900 mb-2 print:text-2xl">{job.title}</h1>
        <div className="flex items-center gap-4 text-sm text-slate-500 flex-wrap">
          {job.company && (
            <span className="flex items-center gap-1">
              <Briefcase className="w-3.5 h-3.5" />
              {job.company}
            </span>
          )}
          {job.location && (
            <span className="flex items-center gap-1">
              <MapPin className="w-3.5 h-3.5" />
              {job.location}
            </span>
          )}
          {(job.salaryMin || job.salaryMax) && (
            <span className="flex items-center gap-1">
              <DollarSign className="w-3.5 h-3.5" />
              {job.salaryMin && job.salaryMax
                ? `$${(job.salaryMin / 1000).toFixed(0)}k–$${(job.salaryMax / 1000).toFixed(0)}k NZD`
                : job.salaryMin
                ? `From $${(job.salaryMin / 1000).toFixed(0)}k NZD`
                : `Up to $${(job.salaryMax! / 1000).toFixed(0)}k NZD`}
            </span>
          )}
        </div>
        <p className="text-xs text-slate-400 mt-3 hidden print:block">
          Prepared {new Date().toLocaleDateString("en-NZ", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
        </p>
      </div>

      {/* Stats strip */}
      {shortlisted.length > 0 && (
        <div className="grid grid-cols-3 gap-4 mb-8 print:mb-6">
          {[
            { icon: <Users className="w-4 h-4 text-blue-500" />, value: shortlisted.length, label: "Shortlisted" },
            { icon: <Star className="w-4 h-4 text-amber-500" />, value: avgScore != null ? `${avgScore}%` : "—", label: "Avg. match score" },
            { icon: <TrendingUp className="w-4 h-4 text-emerald-500" />, value: highAcceptance, label: "Likely to accept" },
          ].map(({ icon, value, label }) => (
            <div key={label} className="bg-white border border-slate-200 rounded-xl p-4 text-center print:border-slate-300 print:rounded-none">
              <div className="flex justify-center mb-1 print:hidden">{icon}</div>
              <p className="text-2xl font-bold text-slate-900 print:text-xl">{value}</p>
              <p className="text-xs text-slate-500 mt-0.5">{label}</p>
            </div>
          ))}
        </div>
      )}

      {/* Role context — print only */}
      {parsedRole && (
        <div className="hidden print:block mb-6 p-4 border border-slate-200 rounded">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Role Requirements</p>
          <div className="text-sm space-y-1">
            {parsedRole.experience && <p><span className="text-slate-500">Experience: </span>{parsedRole.experience}</p>}
            {parsedRole.location && <p><span className="text-slate-500">Location: </span>{parsedRole.location}</p>}
            {parsedRole.skills_required.length > 0 && (
              <p><span className="text-slate-500">Required skills: </span>{parsedRole.skills_required.join(", ")}</p>
            )}
          </div>
        </div>
      )}

      {/* Candidate list */}
      {shortlisted.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-2xl border border-dashed border-slate-200">
          <Star className="w-10 h-10 text-slate-200 mx-auto mb-3" />
          <p className="text-slate-500 font-medium">No candidates shortlisted yet</p>
          <p className="text-slate-400 text-sm mt-1">
            Go back and star candidates to add them here.
          </p>
          <Link
            href={`/jobs/${id}`}
            className="inline-flex items-center gap-1.5 mt-4 text-sm text-blue-600 hover:text-blue-700 font-medium"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to candidates
          </Link>
        </div>
      ) : (
        <div className="space-y-5 print:space-y-6">
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
      <div className="hidden print:block mt-10 pt-4 border-t border-slate-200 text-xs text-slate-400 text-center">
        Generated by RecruitMe · {new Date().getFullYear()}
      </div>
    </div>
  );
}
