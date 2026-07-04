import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized, requireJobAccess } from "@/lib/session";
import { isCrmEnabled, isRemindersEnabled } from "@/lib/feature-flags";
import { JOB_LIST_CANDIDATE_SELECT } from "@/lib/job-candidate-select";
import { safeParseJson } from "@/lib/utils";
import { getJobScoringWeights } from "@/lib/scoring-config";
import { baseScoreUpdateData } from "@/lib/base-score";
import { reportError } from "@/lib/error-reporting";
import type { ParsedRole } from "@/lib/ai";

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

  // ── Automatic base score (deterministic, no AI) ──────────────────────────
  // Any candidate without a score yet gets a snippet-based base score against
  // this job's parsed role, so the list never shows "—" before anyone spends an
  // AI token. AI scoring overrides it on the next Re-score (these rows keep
  // profileTextHash null, so score-all never treats them as cached). Best-effort:
  // a scoring hiccup must never break the job load.
  const baseScores = new Map<string, { matchScore: number; matchReason: string }>();
  const parsedRoleForBase = full.parsedRole
    ? safeParseJson<ParsedRole | null>(full.parsedRole, null)
    : null;
  if (parsedRoleForBase) {
    // The list select strips profileText for payload size, but the base score
    // is far stronger fed the FULL stored evidence (profileText/CV) than a
    // headline — so fetch it for just the unscored rows (usually a handful).
    const unscored = full.candidates.filter((c) => c.matchScore == null);
    const evidenceById = new Map<string, string | null>();
    if (unscored.length > 0) {
      const rows = await prisma.candidate.findMany({
        where: { id: { in: unscored.map((c) => c.id) } },
        select: { id: true, profileText: true },
      });
      for (const r of rows) evidenceById.set(r.id, r.profileText);
    }
    const needsBaseScore = unscored.filter(
      (c) => c.headline || c.location || evidenceById.get(c.id),
    );
    if (needsBaseScore.length > 0) {
      const weights = await getJobScoringWeights(full.scoringWeights, auth.orgId);
      const writes: Promise<unknown>[] = [];
      for (const c of needsBaseScore) {
        try {
          // Scoring is pure CPU (no AI, no I/O) and fast — compute synchronously
          // so the score is in `baseScores` for the response merge below.
          const data = baseScoreUpdateData(
            { name: c.name, headline: c.headline, location: c.location, evidenceText: evidenceById.get(c.id) ?? null },
            full,
            parsedRoleForBase,
            weights,
          );
          baseScores.set(c.id, { matchScore: data.matchScore, matchReason: data.matchReason });
          // Guard on matchScore: null — never clobber a concurrent AI score.
          writes.push(
            prisma.candidate
              .updateMany({ where: { id: c.id, matchScore: null }, data })
              .catch((err) => reportError(err, { route: "jobs/[id]:base-score", jobId: id, candidateId: c.id })),
          );
        } catch (err) {
          reportError(err, { route: "jobs/[id]:base-score", jobId: id, candidateId: c.id });
        }
      }
      // Persist out of band: the scores are already merged into the response, so
      // the recruiter sees them immediately and the job load stays fast even on
      // a 500-candidate job; durability catches up (idempotent on next load).
      void Promise.allSettled(writes);
    }
  }

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
  const enrichedCandidates = full.candidates.map((c) => {
    // Surface the freshly-computed base score on first load (the DB write above
    // is guarded/idempotent; merging here means the number shows immediately).
    const base = baseScores.get(c.id);
    return {
      ...c,
      ...(base ? { matchScore: base.matchScore, matchReason: base.matchReason } : {}),
      otherActiveJobs: c.linkedinUrl ? otherJobsByUrl.get(c.linkedinUrl) ?? [] : [],
    };
  });

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
