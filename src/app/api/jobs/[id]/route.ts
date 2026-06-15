import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized, requireJobAccess } from "@/lib/session";
import { isCrmEnabled, isRemindersEnabled } from "@/lib/feature-flags";
import { JOB_LIST_CANDIDATE_SELECT } from "@/lib/job-candidate-select";

// Never cache the job payload: the page refetches this immediately after adding
// candidates / changing status, and a heuristically-cached stale response made
// those updates "not show up until reload".
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;
  const { error } = await requireJobAccess(id, auth);
  if (error) return error;

  // Exclude large text fields from the candidate list — profileText,
  // matchReason etc. can be 10-50KB each. At 500 candidates that's 25MB+ per page load.
  // The full candidate detail is fetched separately when a card is expanded.
  //
  // scoreBreakdown (~5KB per candidate) is fetched on demand from
  // /api/jobs/:id/candidates/:candidateId/score-breakdown when the recruiter
  // opens the "Why?" panel on a card. Keeping it out of the list select shaves
  // ~2-5MB off the page load for a 500-candidate job. The card-level chips
  // that previously read this field gracefully degrade until the lazy fetch
  // lands — see candidate-card.tsx for the wiring.
  const full = await prisma.job.findUnique({
    where: { id },
    include: {
      // Single source of truth for the stripped-for-size candidate payload —
      // keeps the API shape and the UI Candidate types from drifting. See
      // src/lib/job-candidate-select.ts (profileText / scoreBreakdown /
      // screeningData / interviewNotes / statusHistory are intentionally absent
      // and fetched per-candidate on demand).
      candidates: {
        orderBy: [{ matchScore: "desc" }, { createdAt: "desc" }],
        select: JOB_LIST_CANDIDATE_SELECT,
      },
    },
  });

  if (!full) return NextResponse.json(full);

  // ── Cross-job presence: for each candidate, find OTHER active jobs (in
  // any org the caller can read) that have a candidate with the same
  // LinkedIn URL. Lets the recruiter see "Also on Senior .NET Developer +
  // 2 others" on the card and avoid double-messaging the same person
  // across simultaneous searches. One additional query; indexed on
  // Candidate.linkedinUrl + Job.status.
  const candidatesWithUrls = full.candidates.filter(
    (c) => c.linkedinUrl && !c.linkedinUrl.startsWith("library:"),
  );
  const urls = [...new Set(candidatesWithUrls.map((c) => c.linkedinUrl!))];
  let otherJobsByUrl = new Map<string, Array<{ jobId: string; title: string; company: string | null; matchScore: number | null }>>();
  if (urls.length > 0) {
    const crossJobRows = await prisma.candidate.findMany({
      where: {
        linkedinUrl: { in: urls },
        // Exclude the current job AND library rows
        NOT: { OR: [{ jobId: id }, { jobId: null }] },
        job: {
          // Active jobs only — closed/on-hold roles aren't actionable for outreach
          status: "active",
          orgId: full.orgId, // same org only — don't leak across orgs
        },
      },
      select: {
        linkedinUrl: true, matchScore: true,
        job: { select: { id: true, title: true, company: true } },
      },
      // Hard cap on the cross-job fan-out. Without this an org with 50
      // active jobs that all share a handful of repeat URLs could surface
      // thousands of rows here just to render the "Also on … + 2 others"
      // pill. 500 is generous — typical jobs have <20 cross-presence rows.
      take: 500,
    });
    otherJobsByUrl = crossJobRows.reduce((map, row) => {
      if (!row.linkedinUrl || !row.job) return map;
      const list = map.get(row.linkedinUrl) ?? [];
      list.push({
        jobId: row.job.id,
        title: row.job.title,
        company: row.job.company,
        matchScore: row.matchScore,
      });
      map.set(row.linkedinUrl, list);
      return map;
    }, new Map<string, Array<{ jobId: string; title: string; company: string | null; matchScore: number | null }>>());
  }

  // Annotate each candidate with its cross-job presence. Empty array when
  // not on any other active job.
  const enrichedCandidates = full.candidates.map((c) => ({
    ...c,
    otherActiveJobs: c.linkedinUrl ? otherJobsByUrl.get(c.linkedinUrl) ?? [] : [],
  }));

  return NextResponse.json(
    // crmEnabled lets the client gate CRM-only affordances (e.g. the
    // "Submit to client" action) without a build-time NEXT_PUBLIC flag.
    { ...full, candidates: enrichedCandidates, crmEnabled: isCrmEnabled(), remindersEnabled: isRemindersEnabled() },
    { headers: { "Cache-Control": "no-store, must-revalidate" } },
  );
}

const PatchJobSchema = z.object({
  title:      z.string().min(1).max(200).trim().optional(),
  company:    z.string().max(200).trim().optional(),
  location:   z.string().max(200).trim().optional(),
  // Empty string clears the secondary location (recruiter removing the second city).
  location2:  z.string().max(200).trim().optional().nullable(),
  status:     z.enum(["active", "closed", "on-hold"]).optional(),
  rawJd:      z.string().min(1).max(50_000).optional(),
  parsedRole: z.string().max(100_000).optional(),
  salaryMin:  z.number().int().min(0).max(2_000_000).nullable().optional(),
  salaryMax:  z.number().int().min(0).max(2_000_000).nullable().optional(),
  orgId:      z.string().nullable().optional(), // owner-only: reassign after org delete
}).refine(
  (data) => {
    if (data.salaryMin != null && data.salaryMax != null) return data.salaryMin <= data.salaryMax;
    return true;
  },
  { message: "Salary minimum cannot exceed maximum" }
);

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;
  const { error } = await requireJobAccess(id, auth);
  if (error) return error;

  const result = PatchJobSchema.safeParse(await req.json().catch(() => ({})));
  if (!result.success) return NextResponse.json({ error: result.error.flatten() }, { status: 422 });
  const body = result.data;

  const job = await prisma.job.update({
    where: { id },
    data: {
      ...(body.title      !== undefined && { title: body.title }),
      ...(body.company    !== undefined && { company: body.company }),
      ...(body.location   !== undefined && { location: body.location }),
      // Use null to clear; empty string also clears (consistent with the
      // create endpoint's `|| null` pattern).
      ...(body.location2  !== undefined && { location2: body.location2 || null }),
      ...(body.status     !== undefined && { status: body.status }),
      ...(body.rawJd      !== undefined && { rawJd: body.rawJd }),
      ...(body.parsedRole !== undefined && { parsedRole: body.parsedRole }),
      ...(body.salaryMin  !== undefined && { salaryMin: body.salaryMin }),
      ...(body.salaryMax  !== undefined && { salaryMax: body.salaryMax }),
      // orgId reassignment is owner-only (used after an org delete orphans jobs)
      ...(body.orgId !== undefined && auth.isOwner && { orgId: body.orgId }),
    },
  });
  return NextResponse.json(job);
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;
  const { job, error } = await requireJobAccess(id, auth);
  if (error || !job) return error;

  // Stamp job context on candidates before deletion so library display is
  // preserved after the SetNull cascade nulls out jobId. Both writes must be
  // atomic — a failed delete would leave candidates labelled "(archived)"
  // next to a still-live job otherwise.
  await prisma.$transaction([
    prisma.candidate.updateMany({
      where: { jobId: id },
      data: { archivedJobTitle: job.title, archivedJobCompany: job.company ?? null },
    }),
    prisma.job.delete({ where: { id } }),
  ]);
  return NextResponse.json({ ok: true });
}
