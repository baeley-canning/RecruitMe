"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Briefcase, Users, Star, Activity, AlertCircle, CheckCircle2,
  ChevronRight, Search, Camera, Loader2, TrendingUp,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ScoreBadge } from "@/components/score-badge";

interface TopCandidate { id: string; name: string; headline: string | null; location: string | null; matchScore: number | null; }
interface JobStat {
  id: string; title: string; company: string | null; location: string | null;
  totalCandidates: number; scored: number; fetched: number; needsFetch: number;
  shortlisted: number; avgScore: number | null; topCandidates: TopCandidate[];
  staleScores: boolean; needsAttention: boolean;
}
interface RecentCapture { id: string; name: string; matchScore: number | null; status: string; profileCapturedAt: string | null; job: { id: string; title: string } | null; }
interface SearchSession { id: string; collected: number; avgScore: number | null; evaluation: string | null; createdAt: string; job: { id: string; title: string } | null; }
interface DashboardData {
  jobs: JobStat[];
  recentCaptures: RecentCapture[];
  recentSearches: SearchSession[];
  totals: { activeJobs: number; totalCandidates: number; shortlisted: number; capturedThisWeek: number };
}

function evalColour(ev: string | null) {
  if (!ev) return "text-slate-400";
  if (ev.startsWith("FAIL")) return "text-red-600";
  if (ev.startsWith("WARNING")) return "text-amber-600";
  return "text-emerald-600";
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);

  useEffect(() => {
    fetch("/api/dashboard")
      .then((r) => r.ok ? r.json() : null)
      .then(setData)
      .catch(() => {});
  }, []);

  if (!data) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 text-slate-400 animate-spin" />
      </div>
    );
  }

  const { jobs, recentCaptures, recentSearches, totals } = data;
  const needsAttention = jobs.filter((j) => j.needsAttention);
  const healthy = jobs.filter((j) => !j.needsAttention);

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="mb-7">
        <h1 className="text-2xl font-bold text-slate-900">Dashboard</h1>
        <p className="text-sm text-slate-500 mt-1">What needs your attention right now.</p>
      </div>

      {/* Stat strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        {[
          { label: "Active jobs",        value: totals.activeJobs,        icon: Briefcase,  colour: "text-blue-600 bg-blue-50" },
          { label: "Total candidates",   value: totals.totalCandidates,   icon: Users,      colour: "text-slate-600 bg-slate-100" },
          { label: "Shortlisted",        value: totals.shortlisted,       icon: Star,       colour: "text-amber-600 bg-amber-50" },
          { label: "Captured this week", value: totals.capturedThisWeek,  icon: Camera,     colour: "text-emerald-600 bg-emerald-50" },
        ].map(({ label, value, icon: Icon, colour }) => (
          <div key={label} className="bg-white rounded-xl border border-slate-200 p-4 flex items-center gap-3">
            <div className={cn("w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0", colour)}>
              <Icon className="w-4 h-4" />
            </div>
            <div>
              <p className="text-xl font-bold text-slate-900">{value}</p>
              <p className="text-xs text-slate-500">{label}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left col: jobs needing attention + healthy jobs */}
        <div className="lg:col-span-2 space-y-6">

          {/* Needs attention */}
          {needsAttention.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-2 mb-3">
                <AlertCircle className="w-4 h-4 text-amber-500" />
                Needs attention
              </h2>
              <div className="space-y-2">
                {needsAttention.map((job) => (
                  <JobRow key={job.id} job={job} attention />
                ))}
              </div>
            </div>
          )}

          {/* Active jobs */}
          <div>
            <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-2 mb-3">
              <CheckCircle2 className="w-4 h-4 text-emerald-500" />
              {needsAttention.length > 0 ? "Other active jobs" : "Active jobs"}
            </h2>
            {healthy.length === 0 && jobs.length === 0 && (
              <div className="text-center py-10 bg-white rounded-xl border border-dashed border-slate-200">
                <Briefcase className="w-8 h-8 text-slate-300 mx-auto mb-2" />
                <p className="text-sm text-slate-500">No active jobs yet.</p>
                <Link href="/jobs/new" className="text-sm text-blue-600 hover:text-blue-700 font-medium mt-1 inline-block">Create your first job →</Link>
              </div>
            )}
            <div className="space-y-2">
              {(needsAttention.length > 0 ? healthy : jobs).map((job) => (
                <JobRow key={job.id} job={job} />
              ))}
            </div>
          </div>
        </div>

        {/* Right col: recent activity */}
        <div className="space-y-5">

          {/* Recent captures */}
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
              <Camera className="w-4 h-4 text-slate-400" />
              <p className="text-sm font-medium text-slate-700">Recent captures</p>
              <span className="ml-auto text-[11px] text-slate-400">last 7 days</span>
            </div>
            {recentCaptures.length === 0 ? (
              <p className="text-xs text-slate-400 text-center py-6">No profiles captured yet</p>
            ) : (
              <div className="divide-y divide-slate-50">
                {recentCaptures.slice(0, 6).map((c) => (
                  <div key={c.id} className="flex items-center gap-3 px-4 py-2.5">
                    <ScoreBadge score={c.matchScore} size="sm" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-slate-800 truncate">{c.name}</p>
                      {c.job && <p className="text-[11px] text-slate-400 truncate">{c.job.title}</p>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Recent searches */}
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
              <Search className="w-4 h-4 text-slate-400" />
              <p className="text-sm font-medium text-slate-700">Recent searches</p>
            </div>
            {recentSearches.length === 0 ? (
              <p className="text-xs text-slate-400 text-center py-6">No searches this week</p>
            ) : (
              <div className="divide-y divide-slate-50">
                {recentSearches.map((s) => (
                  <div key={s.id} className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-slate-700">{s.job?.title ?? "Unknown"}</span>
                      <span className="ml-auto text-xs text-slate-500">{s.collected} found</span>
                    </div>
                    {s.evaluation && (
                      <p className={cn("text-[11px] truncate mt-0.5", evalColour(s.evaluation))}>
                        {s.evaluation.slice(0, 60)}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function JobRow({ job, attention }: { job: JobStat; attention?: boolean }) {
  return (
    <Link
      href={`/jobs/${job.id}`}
      className={cn(
        "flex items-center gap-4 bg-white rounded-xl border px-4 py-3 hover:border-blue-200 hover:bg-blue-50/30 transition-colors group",
        attention ? "border-amber-200" : "border-slate-200"
      )}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <p className="text-sm font-medium text-slate-800 truncate">{job.title}</p>
          {job.staleScores && (
            <span className="text-[10px] bg-amber-50 text-amber-600 border border-amber-200 rounded px-1.5 py-0.5 font-medium flex-shrink-0">
              Re-score
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-[11px] text-slate-400 flex-wrap">
          {job.company && <span>{job.company}</span>}
          <span>{job.totalCandidates} candidates</span>
          {job.shortlisted > 0
            ? <span className="text-amber-600 font-medium">★ {job.shortlisted} shortlisted</span>
            : job.scored > 0
            ? <span className="text-slate-400">0 shortlisted</span>
            : null}
          {job.needsFetch > 0 && <span className="text-blue-500">{job.needsFetch} to fetch</span>}
          {job.avgScore !== null && <span>avg {job.avgScore}%</span>}
        </div>
      </div>

      {/* Top candidate score preview */}
      {job.topCandidates.length > 0 && (
        <div className="flex items-center gap-1 flex-shrink-0">
          {job.topCandidates.slice(0, 3).map((c) => (
            <div key={c.id} className="w-8 h-8 rounded-full bg-slate-100 border-2 border-white flex items-center justify-center -ml-1 first:ml-0" title={c.name}>
              <span className="text-[9px] font-bold text-slate-600">{c.matchScore}%</span>
            </div>
          ))}
        </div>
      )}

      <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-blue-400 flex-shrink-0" />
    </Link>
  );
}
