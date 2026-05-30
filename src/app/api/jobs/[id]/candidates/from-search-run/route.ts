/**
 * POST /api/jobs/[id]/candidates/from-search-run — attach selected results
 * from a durable SearchRun to a job.
 *
 * Mirrors the multi-search import path: for each selected SearchRunResult
 * with a resolved candidateId, copy the source Candidate's data onto a new
 * Candidate row tied to THIS jobId (upsert keyed on (jobId, linkedinUrl) so
 * re-imports are idempotent). Scraper hits that haven't ingested yet
 * (candidateId === null) are NOT importable — the UI greys them.
 *
 * NO AI scoring fires at attach time — the recruiter clicks Score-all later
 * (same cost-discipline as the talent-pool + multi-import flows).
 *
 * Auth: getAuth + requireJobAccess; cross-org source rows verified via
 * getAccessibleOrgIds + per-row orgId check (defence-in-depth).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getAuth, requireJobAccess, unauthorized } from "@/lib/session";
import { getAccessibleOrgIds } from "@/lib/org-access";
import { assertRunAccess } from "@/lib/search-run";
import { reportError } from "@/lib/error-reporting";

const BodySchema = z.object({
  runId: z.string().min(1),
  candidateIds: z.array(z.string()).min(1).max(200),
});

interface Outcome {
  candidateId: string;
  status: "attached" | "skipped" | "failed";
  reason?: string;
  newCandidateId?: string;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id: jobId } = await params;

  const { job, error: accessError } = await requireJobAccess(jobId, auth);
  if (accessError || !job) return accessError;

  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 });
  }
  const { runId, candidateIds } = parsed.data;

  const accessibleOrgIds = await getAccessibleOrgIds(auth);

  // Caller must be able to see the run.
  const runOk = await assertRunAccess(runId, { isOwner: auth.isOwner, accessibleOrgIds });
  if (!runOk) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Only attach results that genuinely belong to this run AND have a resolved
  // candidate (scraper hits not yet ingested are not importable).
  const rows = await prisma.searchRunResult.findMany({
    where: { searchRunId: runId, candidateId: { in: candidateIds } },
    select: { candidateId: true },
  });
  const ids = [...new Set(rows.map((r) => r.candidateId).filter((c): c is string => !!c))];

  const jobOrgId = job.orgId ?? null;
  const outcomes: Outcome[] = [];

  for (const candidateId of ids) {
    try {
      outcomes.push(await attachOne(candidateId, jobId, jobOrgId, accessibleOrgIds));
    } catch (err) {
      reportError(err, { route: "from-search-run", jobId, runId, candidateId });
      outcomes.push({ candidateId, status: "failed", reason: err instanceof Error ? err.message : String(err) });
    }
  }

  const counts = {
    attached: outcomes.filter((o) => o.status === "attached").length,
    skipped: outcomes.filter((o) => o.status === "skipped").length,
    failed: outcomes.filter((o) => o.status === "failed").length,
    total: outcomes.length,
  };
  return NextResponse.json({ outcomes, counts });
}

async function attachOne(
  candidateId: string,
  jobId: string,
  jobOrgId: string | null,
  accessibleOrgIds: string[] | null,
): Promise<Outcome> {
  const source = await prisma.candidate.findUnique({
    where: { id: candidateId },
    select: {
      id: true, name: true, headline: true, location: true,
      linkedinUrl: true, jobAdderUrl: true, profileText: true,
      profileCapturedAt: true, email: true, phone: true,
      orgId: true, job: { select: { orgId: true } },
    },
  });
  if (!source) return { candidateId, status: "skipped", reason: "source_not_found" };

  const sourceOrgId = source.orgId ?? source.job?.orgId ?? null;
  if (accessibleOrgIds !== null && (!sourceOrgId || !accessibleOrgIds.includes(sourceOrgId))) {
    return { candidateId, status: "skipped", reason: "cross_org_no_access" };
  }

  const linkedinUrl = source.linkedinUrl ?? `library:${source.id}`;
  const crossOrg = !(accessibleOrgIds === null || sourceOrgId === jobOrgId);
  const upserted = await prisma.candidate.upsert({
    where: { jobId_linkedinUrl: { jobId, linkedinUrl } },
    create: {
      jobId,
      orgId: jobOrgId,
      name: source.name,
      headline: source.headline,
      location: source.location,
      linkedinUrl,
      // Strip jobAdderUrl on cross-org imports (points at provider's ATS).
      jobAdderUrl: crossOrg ? null : source.jobAdderUrl,
      profileText: source.profileText,
      email: crossOrg ? null : source.email,
      phone: crossOrg ? null : source.phone,
      source: "talent_pool",
      status: "new",
      ...(source.profileCapturedAt ? { profileCapturedAt: source.profileCapturedAt } : {}),
    },
    update: { source: "talent_pool" },
  });
  return { candidateId, status: "attached", newCandidateId: upserted.id };
}
