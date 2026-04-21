import { redirect } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { getAuth, jobsWhere } from "@/lib/session";
import { Plus, Briefcase, Users, Star } from "lucide-react";
import { JobsListClient } from "@/components/jobs-list-client";

export default async function JobsPage() {
  const auth = await getAuth();
  if (!auth) redirect("/login");

  const jobs = await prisma.job.findMany({
    where: jobsWhere(auth),
    orderBy: { createdAt: "desc" },
    include: {
      candidates: {
        select: { id: true, status: true, matchScore: true },
      },
    },
  });

  const activeJobs       = jobs.filter((j) => j.status === "active").length;
  const totalCandidates  = jobs.reduce((sum, j) => sum + j.candidates.length, 0);
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
