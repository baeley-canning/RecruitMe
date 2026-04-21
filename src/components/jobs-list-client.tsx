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
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search jobs by title, company, or location..."
          className="w-full pl-9 pr-9 py-2.5 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400 bg-white"
        />
        {query && (
          <button
            onClick={() => setQuery("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {filtered.length === 0 && query && (
        <div className="text-center py-10 text-slate-400 text-sm">
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
            className={`flex items-center gap-5 p-5 bg-white rounded-xl border transition-all group ${
              isClosed
                ? "border-slate-200 opacity-60 hover:opacity-80"
                : "border-slate-200 hover:border-blue-300 hover:shadow-md"
            }`}
          >
            <div className={`w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 ${
              isClosed ? "bg-slate-200" : "bg-gradient-to-br from-blue-500 to-blue-700"
            }`}>
              <Briefcase className={`w-6 h-6 ${isClosed ? "text-slate-500" : "text-white"}`} />
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="font-semibold text-slate-900 group-hover:text-blue-700 transition-colors truncate">
                  {job.title}
                </h3>
                {isClosed ? (
                  <span className="text-xs px-2 py-0.5 bg-slate-100 text-slate-500 border border-slate-200 rounded-full font-medium">
                    Closed
                  </span>
                ) : (
                  <span className="text-xs px-2 py-0.5 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-full font-medium">
                    Active
                  </span>
                )}
                {!hasBeenParsed && (
                  <span className="text-xs px-2 py-0.5 bg-amber-50 text-amber-700 border border-amber-200 rounded-full font-medium">
                    Needs parsing
                  </span>
                )}
                {isStale && (
                  <span className="text-xs px-2 py-0.5 bg-slate-100 text-slate-500 border border-slate-200 rounded-full font-medium">
                    Dormant
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 mt-1 flex-wrap">
                {job.company && (
                  <span className="text-sm text-slate-500 truncate">{job.company}</span>
                )}
                {job.location && (
                  <span className="text-sm text-slate-400">{job.location}</span>
                )}
                <span className="text-xs text-slate-400 flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {timeAgo(job.createdAt)}
                </span>
              </div>

              {total > 0 && (
                <div className="flex items-center gap-3 mt-2 flex-wrap">
                  {newCount > 0 && (
                    <span className="text-xs text-slate-500 flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-slate-400 inline-block" />
                      {newCount} new
                    </span>
                  )}
                  {shortlisted > 0 && (
                    <span className="text-xs text-amber-600 flex items-center gap-1">
                      <Star className="w-3 h-3" />
                      {shortlisted} shortlisted
                    </span>
                  )}
                  {contacted > 0 && (
                    <span className="text-xs text-blue-600 flex items-center gap-1">
                      <TrendingUp className="w-3 h-3" />
                      {contacted} in progress
                    </span>
                  )}
                  {hired > 0 && (
                    <span className="text-xs text-emerald-600 flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3" />
                      {hired} hired
                    </span>
                  )}
                </div>
              )}
            </div>

            <div className="flex items-center gap-6 flex-shrink-0 text-right">
              <div>
                <p className="text-lg font-bold text-slate-900">{total}</p>
                <p className="text-xs text-slate-500">Candidates</p>
              </div>
              {avgScore != null && (
                <div>
                  <p className="text-lg font-bold text-blue-600">{avgScore}%</p>
                  <p className="text-xs text-slate-500">Avg score</p>
                </div>
              )}
              <TrendingUp className="w-5 h-5 text-slate-300 group-hover:text-blue-400 transition-colors" />
            </div>
          </Link>
        );
      })}
    </div>
  );
}
