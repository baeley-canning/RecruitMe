import { Prisma } from "@prisma/client";

/**
 * THE candidate select for the job-detail list (GET /api/jobs/[id]).
 *
 * Single source of truth so the API payload and the UI types can't silently
 * drift — the recurring "contract-drift" bug class (a button gated on a field
 * that this select strips → silently never renders; a `=== null` gate that
 * never fires because the field is `undefined`).
 *
 * DELIBERATELY STRIPPED here for payload size (a 500-candidate page would be
 * 25MB+ otherwise): profileText, scoreBreakdown, screeningData, interviewNotes,
 * statusHistory. Those are hydrated per-candidate on demand. The UI Candidate
 * types (candidate-card.tsx, jobs/[id]/page.tsx) therefore type them OPTIONAL —
 * if you add one of them to this select, make it required there; if you remove
 * a field here, the optional typing already forces null-safe access downstream.
 */
export const JOB_LIST_CANDIDATE_SELECT = {
  id: true, jobId: true, orgId: true, name: true, headline: true,
  location: true, linkedinUrl: true, source: true, status: true, phone: true, email: true,
  photoFileId: true,
  matchScore: true, matchReason: true,
  fetchPriorityScore: true, fetchPriorityReason: true,
  acceptanceScore: true, acceptanceReason: true,
  profileCapturedAt: true, profileTextHash: true,
  captureMetadata: true,
  jobAdderUrl: true, seekUrl: true, notes: true, createdAt: true, updatedAt: true,
  archivedJobTitle: true, archivedJobCompany: true,
  _count: { select: { contactEvents: true } },
  contactEvents: {
    orderBy: { createdAt: "desc" },
    take: 1,
    select: { type: true, userName: true, createdAt: true },
  },
  // Candidate tags (reminders/tags feature). Cheap join — avoids an N+1 for
  // per-card chips. The UI maps tagAssignments[].tag -> TagDto[].
  tagAssignments: { select: { tag: { select: { id: true, label: true, color: true } } } },
} satisfies Prisma.CandidateSelect;

/** The exact row shape GET /api/jobs/[id] returns per candidate (before the
 *  route's `otherActiveJobs` enrichment). Derived from the select so it tracks
 *  it automatically. */
export type JobListCandidate = Prisma.CandidateGetPayload<{
  select: typeof JOB_LIST_CANDIDATE_SELECT;
}>;
