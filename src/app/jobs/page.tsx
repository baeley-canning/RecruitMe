import Link from "next/link";
import { prisma } from "@/lib/db";
import { Plus, Briefcase, Users, Star, TrendingUp, Clock, CheckCircle2 } from "lucide-react";
import { timeAgo } from "@/lib/utils";

export default async function JobsPage() {
  const jobs = await prisma.job.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      candidates: {
        select: { id: true, status: true, matchScore: true },
      },
    },
  });

  const activeJobs      = jobs.filter((j) => j.status === "active").length;
  const totalCandidates = jobs.reduce((sum, j) => sum + j.candidates.length, 0);
  const totalShortlisted = jobs.reduce(
    (sum, j) => sum + j.candidates.filter((c) => c.status === "shortlisted").length,
    0
  );

  return (
    <div className="p-8 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Dashboard</h1>
          <p className="text-slate-500 text-sm mt-1">Manage your recruitment pipeline</p>
        </div>
        <Link
          href="/jobs/new"
          className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
        >
          <Plus className="w-4 h-4" />
          New Job
        </Link>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-blue-50 rounded-lg flex items-center justify-center">
              <Briefcase className="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-900">{activeJobs}</p>
              <p className="text-xs text-slate-500">Active Jobs</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-purple-50 rounded-lg flex items-center justify-center">
              <Users className="w-5 h-5 text-purple-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-900">{totalCandidates}</p>
              <p className="text-xs text-slate-500">Total Candidates</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-emerald-50 rounded-lg flex items-center justify-center">
              <Star className="w-5 h-5 text-emerald-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-900">{totalShortlisted}</p>
              <p className="text-xs text-slate-500">Shortlisted</p>
            </div>
          </div>
        </div>
      </div>

      {/* Job cards */}
      {jobs.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-slate-200 border-dashed">
          <div className="w-14 h-14 bg-blue-50 rounded-full flex items-center justify-center mx-auto mb-4">
            <Briefcase className="w-7 h-7 text-blue-500" />
          </div>
          <h3 className="text-lg font-semibold text-slate-900 mb-2">No jobs yet</h3>
          <p className="text-slate-500 text-sm mb-5">
            Create your first job by uploading or pasting a job description.
          </p>
          <Link
            href="/jobs/new"
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
          >
            <Plus className="w-4 h-4" />
            Create first job
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {jobs.map((job) => {
            const candidates      = job.candidates;
            const total           = candidates.length;
            const newCount        = candidates.filter((c) => c.status === "new").length;
            const shortlisted     = candidates.filter((c) => c.status === "shortlisted").length;
            const contacted       = candidates.filter((c) => ["contacted", "interviewing", "offer_sent"].includes(c.status)).length;
            const hired           = candidates.filter((c) => c.status === "hired").length;
            const hasBeenParsed   = Boolean(job.parsedRole);
            const isClosed        = job.status === "closed";

            // Average match score of scored candidates
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

                  {/* Pipeline mini-bar */}
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
      )}
    </div>
  );
}
