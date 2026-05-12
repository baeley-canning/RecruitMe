"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Briefcase, Users, Star, AlertCircle, CheckCircle2,
  ChevronRight, Search, Camera, Loader2,
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
  if (!ev) return "text-text-tertiary";
  if (ev.startsWith("FAIL")) return "text-danger";
  if (ev.startsWith("WARNING")) return "text-warning";
  return "text-success";
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
        <Loader2 className="w-5 h-5 text-text-tertiary animate-spin" />
      </div>
    );
  }

  const { jobs, recentCaptures, recentSearches, totals } = data;
  const needsAttention = jobs.filter((j) => j.needsAttention);
  const healthy = jobs.filter((j) => !j.needsAttention);

  const tiles = [
    { label: "Active jobs",         value: totals.activeJobs,        icon: Briefcase },
    { label: "Total candidates",    value: totals.totalCandidates,   icon: Users },
    { label: "Shortlisted",         value: totals.shortlisted,       icon: Star },
    { label: "Captured this week",  value: totals.capturedThisWeek,  icon: Camera },
  ];

  return (
    <div className="bg-surface-base min-h-full">
      {/* Toolbar */}
      <div className="toolbar">
        <h1 className="text-md font-semibold text-text-primary">Dashboard</h1>
        <span className="text-xs text-text-tertiary">What needs your attention right now</span>
        <div className="ml-auto" />
      </div>

      <div className="p-5 max-w-6xl mx-auto">
        {/* Stat tiles */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-5">
          {tiles.map(({ label, value, icon: Icon }) => (
            <div
              key={label}
              className="bg-surface-raised border border-separator rounded-md p-3"
            >
              <div className="flex items-center gap-2 mb-1 text-text-tertiary">
                <Icon className="w-3.5 h-3.5" />
                <p className="text-2xs uppercase tracking-wider">{label}</p>
              </div>
              <p className="text-2xl data-mono text-text-primary">{value}</p>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {/* Left: jobs */}
          <div className="lg:col-span-2 space-y-5">

            {needsAttention.length > 0 && (
              <section>
                <h2 className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-text-tertiary mb-2">
                  <AlertCircle className="w-3.5 h-3.5 text-warning" />
                  Needs attention
                </h2>
                <div className="bg-surface-raised border border-separator rounded-md divide-y divide-separator overflow-hidden">
                  {needsAttention.map((job) => (
                    <JobRow key={job.id} job={job} attention />
                  ))}
                </div>
              </section>
            )}

            <section>
              <h2 className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-text-tertiary mb-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-success" />
                {needsAttention.length > 0 ? "Other active jobs" : "Active jobs"}
              </h2>
              {healthy.length === 0 && jobs.length === 0 ? (
                <div className="bg-surface-raised border border-separator rounded-md p-8 text-center">
                  <p className="text-sm text-text-secondary mb-3">No active jobs yet.</p>
                  <Link
                    href="/jobs/new"
                    className="inline-flex items-center h-7 px-3 rounded bg-accent hover:bg-accent-hover text-white text-md font-medium transition-colors"
                  >
                    Create your first job
                  </Link>
                </div>
              ) : (
                <div className="bg-surface-raised border border-separator rounded-md divide-y divide-separator overflow-hidden">
                  {(needsAttention.length > 0 ? healthy : jobs).map((job) => (
                    <JobRow key={job.id} job={job} />
                  ))}
                </div>
              )}
            </section>
          </div>

          {/* Right: recent activity */}
          <div className="space-y-5">

            <section className="bg-surface-raised border border-separator rounded-md overflow-hidden">
              <div className="px-3 py-2 border-b border-separator flex items-center gap-2">
                <Camera className="w-3.5 h-3.5 text-text-tertiary" />
                <p className="text-md font-medium text-text-primary">Recent captures</p>
                <span className="ml-auto text-2xs text-text-tertiary">last 7 days</span>
              </div>
              {recentCaptures.length === 0 ? (
                <p className="text-xs text-text-tertiary text-center py-6">No profiles captured yet</p>
              ) : (
                <div className="divide-y divide-separator">
                  {recentCaptures.slice(0, 6).map((c) => (
                    <div key={c.id} className="flex items-center gap-2 px-3 py-2">
                      <ScoreBadge score={c.matchScore} size="sm" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-text-primary truncate">{c.name}</p>
                        {c.job && <p className="text-xs text-text-tertiary truncate">{c.job.title}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="bg-surface-raised border border-separator rounded-md overflow-hidden">
              <div className="px-3 py-2 border-b border-separator flex items-center gap-2">
                <Search className="w-3.5 h-3.5 text-text-tertiary" />
                <p className="text-md font-medium text-text-primary">Recent searches</p>
              </div>
              {recentSearches.length === 0 ? (
                <p className="text-xs text-text-tertiary text-center py-6">No searches this week</p>
              ) : (
                <div className="divide-y divide-separator">
                  {recentSearches.map((s) => (
                    <div key={s.id} className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-text-primary truncate">{s.job?.title ?? "Unknown"}</span>
                        <span className="ml-auto text-xs text-text-secondary data-mono">{s.collected} found</span>
                      </div>
                      {s.evaluation && (
                        <p className={cn("text-xs truncate mt-0.5", evalColour(s.evaluation))}>
                          {s.evaluation.slice(0, 60)}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
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
      className="flex items-center gap-3 px-3 py-2 hover:bg-surface-hover transition-colors group"
    >
      <Briefcase className={cn("w-4 h-4 flex-shrink-0", attention ? "text-warning" : "text-text-tertiary")} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <p className="text-md font-medium text-text-primary truncate">{job.title}</p>
          {job.staleScores && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm text-2xs font-medium bg-warning-subtle text-warning flex-shrink-0">
              Re-score
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-text-tertiary flex-wrap">
          {job.company && <span>{job.company}</span>}
          <span><span className="data-mono">{job.totalCandidates}</span> candidates</span>
          {job.shortlisted > 0
            ? <span className="text-warning">★ <span className="data-mono">{job.shortlisted}</span> shortlisted</span>
            : job.scored > 0
            ? <span>0 shortlisted</span>
            : null}
          {job.needsFetch > 0 && <span className="text-accent"><span className="data-mono">{job.needsFetch}</span> to fetch</span>}
          {job.avgScore !== null && <span>avg <span className="data-mono">{job.avgScore}%</span></span>}
        </div>
      </div>

      {job.topCandidates.length > 0 && (
        <div className="hidden sm:flex items-center gap-1 flex-shrink-0">
          {job.topCandidates.slice(0, 3).map((c) => (
            <div
              key={c.id}
              className="h-6 min-w-[2.25rem] px-1 rounded-sm bg-surface-hover border border-separator flex items-center justify-center"
              title={c.name}
            >
              <span className="text-2xs data-mono text-text-secondary">{c.matchScore}%</span>
            </div>
          ))}
        </div>
      )}

      <ChevronRight className="w-3.5 h-3.5 text-text-tertiary group-hover:text-text-secondary flex-shrink-0" />
    </Link>
  );
}
