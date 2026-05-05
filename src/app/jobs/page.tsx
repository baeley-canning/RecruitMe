import { redirect } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { getAuth, jobsWhere } from "@/lib/session";
import { Plus, Briefcase, Users, Star } from "lucide-react";
import { JobsListClient } from "@/components/jobs-list-client";

export const dynamic = "force-dynamic";

export default async function JobsPage() {
  const auth = await getAuth();
  if (!auth) redirect("/login");

  const [jobs, needsFetchRows] = await Promise.all([
    prisma.job.findMany({
      where: jobsWhere(auth),
      orderBy: { createdAt: "desc" },
      include: {
        candidates: {
          select: { id: true, status: true, matchScore: true },
        },
      },
    }),
    // Candidates that have a LinkedIn URL but haven't had their profile captured yet.
    prisma.candidate.findMany({
      where: {
        job: { ...jobsWhere(auth), status: "active" },
        linkedinUrl: { not: null },
        profileCapturedAt: null,
      },
      select: { id: true, jobId: true, job: { select: { title: true, company: true } } },
    }),
  ]);

  const activeJobs       = jobs.filter((j) => j.status === "active").length;
  const totalCandidates  = jobs.reduce((sum, j) => sum + j.candidates.length, 0);
  const totalShortlisted = jobs.reduce(
    (sum, j) => sum + j.candidates.filter((c) => c.status === "shortlisted").length,
    0
  );

  // Group pending fetches by job for the indicator tooltip
  const fetchByJob = needsFetchRows.reduce((acc, row) => {
    if (!row.jobId) return acc;
    if (!acc[row.jobId]) acc[row.jobId] = { count: 0, jobId: row.jobId, title: row.job?.title ?? "Untitled", company: row.job?.company ?? "" };
    acc[row.jobId].count++;
    return acc;
  }, {} as Record<string, { count: number; jobId: string; title: string; company: string }>);
  const fetchJobs = Object.values(fetchByJob).sort((a, b) => b.count - a.count);
  const fetchTarget = needsFetchRows.length > 0 ? needsFetchRows[0] : null;

  return (
    <div className="p-8 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Dashboard</h1>
          <p className="text-slate-500 text-sm mt-1">Manage your recruitment pipeline</p>
        </div>
        <div className="flex items-center gap-3">
          {/* Fetch status indicator */}
          {fetchTarget ? (
            <div className="relative group">
              <Link
                href={`/jobs/${fetchTarget.jobId}`}
                title={fetchJobs.map(j => `${j.title}${j.company ? ` · ${j.company}` : ""}: ${j.count}`).join("\n")}
                className="flex items-center gap-2 px-3 py-2 rounded-lg border border-orange-200 bg-orange-50 hover:bg-orange-100 transition-colors text-xs font-medium text-orange-700"
              >
                <span className="relative flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-orange-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-orange-500" />
                </span>
                {needsFetchRows.length} to fetch{fetchJobs.length > 1 ? ` · ${fetchJobs.length} jobs` : ""}
              </Link>
              {/* Per-job breakdown on hover */}
              <div className="absolute right-0 top-full mt-1 z-10 hidden group-hover:block bg-white border border-slate-200 rounded-lg shadow-lg p-2 min-w-[200px]">
                {fetchJobs.map(j => (
                  <Link key={j.jobId} href={`/jobs/${j.jobId}`} className="flex items-center justify-between px-2 py-1 hover:bg-slate-50 rounded text-xs">
                    <span className="text-slate-700 truncate">{j.title}{j.company ? ` · ${j.company}` : ""}</span>
                    <span className="ml-2 text-orange-600 font-medium flex-shrink-0">{j.count}</span>
                  </Link>
                ))}
              </div>
            </div>
          ) : (
            <span
              title="All captured profiles are up to date"
              className="flex items-center gap-2 px-3 py-2 rounded-lg border border-emerald-200 bg-emerald-50 text-xs font-medium text-emerald-700"
            >
              <span className="inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
              Profiles up to date
            </span>
          )}
          <Link
            href="/jobs/new"
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
          >
            <Plus className="w-4 h-4" />
            New Job
          </Link>
        </div>
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

      {/* Job list */}
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
        <JobsListClient jobs={jobs} />
      )}
    </div>
  );
}
