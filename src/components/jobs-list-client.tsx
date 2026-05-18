"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Briefcase,
  Clock,
  Star,
  TrendingUp,
  CheckCircle2,
  Search,
  X,
} from "lucide-react";
import { timeAgo } from "@/lib/utils";

interface CandidateStub {
  id: string;
  status: string;
  matchScore: number | null;
}

interface JobStub {
  id: string;
  title: string;
  company: string | null;
  location: string | null;
  status: string;
  parsedRole: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  candidates: CandidateStub[];
}

export function JobsListClient({ jobs }: { jobs: JobStub[] }) {
  const [query, setQuery] = useState("");

  const filtered = query.trim()
    ? jobs.filter((j) => {
        const q = query.toLowerCase();
        return (
          j.title.toLowerCase().includes(q) ||
          (j.company ?? "").toLowerCase().includes(q) ||
          (j.location ?? "").toLowerCase().includes(q)
        );
      })
    : jobs;

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-tertiary" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search jobs by title, company, or location..."
          className="w-full h-8 pl-8 pr-8 text-md border border-separator rounded focus:outline-none focus:border-accent focus:shadow-focus bg-surface-sunken text-text-primary placeholder:text-text-tertiary transition-all"
        />
        {query && (
          <button
            onClick={() => setQuery("")}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-primary"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {filtered.length === 0 && query && (
        <div className="text-center py-10 text-text-tertiary text-md">
          No jobs matching &ldquo;{query}&rdquo;
        </div>
      )}

      {filtered.map((job) => {
        const candidates = job.candidates;
        const total = candidates.length;
        const newCount = candidates.filter((c) => c.status === "new").length;
        const shortlisted = candidates.filter((c) => c.status === "shortlisted").length;
        const contacted = candidates.filter((c) => ["contacted", "interviewing", "offer_sent"].includes(c.status)).length;
        const hired = candidates.filter((c) => c.status === "hired").length;
        const hasBeenParsed = Boolean(job.parsedRole);
        const isClosed = job.status === "closed";
        const daysSinceUpdate = Math.floor((Date.now() - new Date(job.updatedAt).getTime()) / 86_400_000);
        const isStale = !isClosed && daysSinceUpdate >= 14 && total > 0;

        const scored = candidates.filter((c) => c.matchScore != null);
        const avgScore = scored.length
          ? Math.round(scored.reduce((s, c) => s + (c.matchScore ?? 0), 0) / scored.length)
          : null;

        return (
          <Link
            key={job.id}
            href={`/jobs/${job.id}`}
            className={`flex items-center gap-5 p-4 bg-surface-raised rounded-md border border-separator transition-colors group ${
              isClosed
                ? "opacity-60 hover:opacity-80 hover:bg-surface-hover"
                : "hover:bg-surface-hover"
            }`}
          >
            <div className={`w-10 h-10 rounded-md flex items-center justify-center flex-shrink-0 ${
              isClosed ? "bg-surface-hover" : "bg-accent-subtle"
            }`}>
              <Briefcase className={`w-5 h-5 ${isClosed ? "text-text-tertiary" : "text-accent"}`} />
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-md font-semibold text-text-primary group-hover:text-accent transition-colors truncate">
                  {job.title}
                </h3>
                {isClosed ? (
                  <span className="text-xs px-1.5 py-0.5 bg-surface-hover text-text-tertiary border border-separator rounded-sm font-medium">
                    Closed
                  </span>
                ) : (
                  <span className="text-xs px-1.5 py-0.5 bg-success-subtle text-success border border-separator rounded-sm font-medium">
                    Active
                  </span>
                )}
                {!hasBeenParsed && (
                  <span className="text-xs px-1.5 py-0.5 bg-warning-subtle text-warning border border-separator rounded-sm font-medium">
                    Needs parsing
                  </span>
                )}
                {isStale && (
                  <span className="text-xs px-1.5 py-0.5 bg-surface-hover text-text-tertiary border border-separator rounded-sm font-medium">
                    Dormant
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 mt-1 flex-wrap">
                {job.company && (
                  <span className="text-md text-text-secondary truncate">{job.company}</span>
                )}
                {job.location && (
                  <span className="text-md text-text-tertiary">{job.location}</span>
                )}
                <span className="text-xs text-text-tertiary flex items-center gap-1 data-mono" suppressHydrationWarning>
                  <Clock className="w-3 h-3" />
                  {timeAgo(job.createdAt)}
                </span>
              </div>

              {total > 0 && (
                <div className="flex items-center gap-3 mt-2 flex-wrap">
                  {newCount > 0 && (
                    <span className="text-xs text-text-secondary flex items-center gap-1 data-mono">
                      <span className="w-1.5 h-1.5 rounded-full bg-text-tertiary inline-block" />
                      {newCount} new
                    </span>
                  )}
                  {shortlisted > 0 && (
                    <span className="text-xs text-warning flex items-center gap-1 data-mono">
                      <Star className="w-3 h-3" />
                      {shortlisted} shortlisted
                    </span>
                  )}
                  {contacted > 0 && (
                    <span className="text-xs text-accent flex items-center gap-1 data-mono">
                      <TrendingUp className="w-3 h-3" />
                      {contacted} in progress
                    </span>
                  )}
                  {hired > 0 && (
                    <span className="text-xs text-success flex items-center gap-1 data-mono">
                      <CheckCircle2 className="w-3 h-3" />
                      {hired} hired
                    </span>
                  )}
                </div>
              )}
            </div>

            <div className="flex items-center gap-6 flex-shrink-0 text-right">
              <div>
                <p className="text-lg font-semibold text-text-primary data-mono">{total}</p>
                <p className="text-xs text-text-secondary">Candidates</p>
              </div>
              {avgScore != null && (
                <div>
                  <p className="text-lg font-semibold text-accent data-mono">{avgScore}%</p>
                  <p className="text-xs text-text-secondary">Avg score</p>
                </div>
              )}
              <TrendingUp className="w-4 h-4 text-text-tertiary group-hover:text-accent transition-colors" />
            </div>
          </Link>
        );
      })}
    </div>
  );
}
