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

  const tiles = [
    { label: "Active jobs",      value: activeJobs,       icon: Briefcase },
    { label: "Total candidates", value: totalCandidates,  icon: Users },
    { label: "Shortlisted",      value: totalShortlisted, icon: Star },
  ];

  return (
    <div className="bg-surface-base min-h-full">
      {/* Toolbar */}
      <div className="toolbar">
        <h1 className="text-md font-semibold text-text-primary">Jobs</h1>
        <span className="text-xs text-text-tertiary">Manage your recruitment pipeline</span>

        <div className="ml-auto flex items-center gap-2">
          {/* Fetch status indicator */}
          {fetchTarget ? (
            <div className="relative group">
              <Link
                href={`/jobs/${fetchTarget.jobId}`}
                title={fetchJobs.map(j => `${j.title}${j.company ? ` · ${j.company}` : ""}: ${j.count}`).join("\n")}
                className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded bg-warning-subtle text-warning text-xs font-medium hover:bg-warning/20 transition-colors"
              >
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-warning opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-warning" />
                </span>
                <span className="data-mono">{needsFetchRows.length}</span> to fetch
                {fetchJobs.length > 1 && <span className="text-text-tertiary">· {fetchJobs.length} jobs</span>}
              </Link>
              {/* Per-job breakdown on hover */}
              <div className="absolute right-0 top-full mt-1 z-10 hidden group-hover:block bg-surface-overlay border border-separator rounded-md shadow-popover p-1.5 min-w-[220px]">
                {fetchJobs.map(j => (
                  <Link
                    key={j.jobId}
                    href={`/jobs/${j.jobId}`}
                    className="flex items-center justify-between px-2 py-1 hover:bg-surface-hover rounded text-xs"
                  >
                    <span className="text-text-primary truncate">{j.title}{j.company ? ` · ${j.company}` : ""}</span>
                    <span className="ml-2 text-warning font-medium flex-shrink-0 data-mono">{j.count}</span>
                  </Link>
                ))}
              </div>
            </div>
          ) : (
            <span
              title="All captured profiles are up to date"
              className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded bg-success-subtle text-success text-xs font-medium"
            >
              <span className="inline-flex rounded-full h-2 w-2 bg-success" />
              Profiles up to date
            </span>
          )}
          <Link
            href="/jobs/new"
            className="inline-flex items-center gap-1.5 h-7 px-3 rounded bg-accent hover:bg-accent-hover text-white text-md font-medium transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            New job
          </Link>
        </div>
      </div>

      <div className="p-5 max-w-5xl mx-auto">
        {/* Stat tiles */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-5">
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

        {/* Job list */}
        {jobs.length === 0 ? (
          <div className="bg-surface-raised border border-separator rounded-md p-10 text-center">
            <Briefcase className="w-6 h-6 text-text-tertiary mx-auto mb-3" />
            <h3 className="text-md font-semibold text-text-primary mb-1">No jobs yet</h3>
            <p className="text-sm text-text-secondary mb-4">
              Create your first job by uploading or pasting a job description.
            </p>
            <Link
              href="/jobs/new"
              className="inline-flex items-center gap-1.5 h-7 px-3 rounded bg-accent hover:bg-accent-hover text-white text-md font-medium transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              Create first job
            </Link>
          </div>
        ) : (
          <JobsListClient jobs={jobs} />
        )}
      </div>
    </div>
  );
}
